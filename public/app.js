/* 总控台前端。无构建、无框架——一个 HTML 文件能被直接打开是这类工具的底线。 */

const $ = (sel, root = document) => root.querySelector(sel);

const state = {
  roles: [],
  jobs: [],
  job: null,
  phase: 'idle', // idle | planning | planned | running | done
  live: new Map(), // taskId -> { text, reasoning }
  summaryText: '',
  es: null,
  nodes: new Map(), // taskId -> card element
  expanded: new Set(),
};

/* ---------------- 基础工具 ---------------- */

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inline(text) {
  // 先把行内代码摘出来，避免里面的 * _ 被当强调处理
  const codes = [];
  let s = String(text).replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000C${codes.length - 1}\u0000`;
  });

  s = escapeHtml(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/\u0000C(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(codes[Number(i)])}</code>`);
  return s;
}

/** 轻量 Markdown → HTML。只支持模型实际会用的语法，够用且不会有依赖。 */
function mdToHtml(src) {
  const lines = String(src || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  let para = [];
  let lists = [];
  let quote = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join(' '))}</p>`);
      para = [];
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      out.push(`<blockquote>${quote.map((q) => inline(q)).join('<br>')}</blockquote>`);
      quote = [];
    }
  };
  const closeLists = () => {
    while (lists.length) out.push(`</${lists.pop()}>`);
  };
  const flushAll = () => {
    flushPara();
    flushQuote();
    closeLists();
  };

  while (i < lines.length) {
    const line = lines[i];

    // 代码块
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      flushAll();
      const lang = fence[1];
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // 跳过结束围栏
      out.push(
        `<pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ''}>${escapeHtml(buf.join('\n'))}</code></pre>`,
      );
      continue;
    }

    // 表格（当前行含 | 且下一行是分隔行）
    if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      flushAll();
      const parseRow = (r) =>
        r
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((c) => c.trim());
      const head = parseRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) {
        rows.push(parseRow(lines[i]));
        i++;
      }
      out.push(
        `<table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`,
      );
      continue;
    }

    // 空行
    if (!line.trim()) {
      flushAll();
      i++;
      continue;
    }

    // 分割线
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      flushAll();
      out.push('<hr>');
      i++;
      continue;
    }

    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushAll();
      const lv = Math.min(h[1].length, 4);
      out.push(`<h${lv}>${inline(h[2].trim())}</h${lv}>`);
      i++;
      continue;
    }

    // 引用
    const q = line.match(/^>\s?(.*)$/);
    if (q) {
      flushPara();
      closeLists();
      quote.push(q[1]);
      i++;
      continue;
    }
    flushQuote();

    // 列表
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const want = ul ? 'ul' : 'ol';
      if (lists[lists.length - 1] !== want) {
        closeLists();
        out.push(`<${want}>`);
        lists.push(want);
      }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
      i++;
      continue;
    }
    closeLists();

    para.push(line.trim());
    i++;
  }

  flushAll();
  return out.join('\n');
}

function toast(msg, isErr = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show${isErr ? ' err' : ''}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => {
    el.className = 'toast';
  }, 3200);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error(`服务返回异常（HTTP ${res.status}）`);
  }
  if (!res.ok || json.ok === false) throw new Error(json.error || `HTTP ${res.status}`);
  return json.data;
}

function roleOf(id) {
  return state.roles.find((r) => r.id === id) || { id, name: id, badge: '?', color: '#6366f1' };
}

/* ---------------- 初始化 ---------------- */

async function boot() {
  try {
    const health = await api('/api/health');
    const pill = $('#modelPill');
    if (health.hasKey) {
      pill.classList.add('ok');
      $('#modelText').textContent = `${health.model} · 并发 ${health.concurrency}`;
    } else {
      pill.classList.add('bad');
      $('#modelText').textContent = '未配置密钥';
    }
  } catch (err) {
    $('#modelPill').classList.add('bad');
    $('#modelText').textContent = '服务未连接';
  }

  try {
    state.roles = await api('/api/roles');
  } catch {
    state.roles = [];
  }

  await refreshJobs();
  bindEvents();

  // 支持 #job/<id> 直达，刷新不丢当前任务，链接也能直接发给别人
  const m = location.hash.match(/^#job\/(.+)$/);
  if (m) loadJob(decodeURIComponent(m[1]));
}

async function refreshJobs() {
  try {
    state.jobs = await api('/api/jobs');
    renderJobs();
  } catch {
    /* 静默：侧栏失败不影响主流程 */
  }
}

function renderJobs() {
  const box = $('#jobList');
  if (!state.jobs.length) {
    box.innerHTML = '<div style="padding:10px 8px;font-size:11.5px;color:var(--text-faint)">还没有记录</div>';
    return;
  }
  box.innerHTML = state.jobs
    .map(
      (j) => `
      <div class="job-item${state.job && state.job.id === j.id ? ' active' : ''}" data-id="${j.id}">
        <span class="jt">${escapeHtml(j.title || j.goal.slice(0, 20))}</span>
        <span class="jm">
          <i class="mini-dot ${j.status}"></i>
          ${j.taskCount} 个任务 · ${statusText(j.status)}
        </span>
      </div>`,
    )
    .join('');

  box.querySelectorAll('.job-item').forEach((el) => {
    el.onclick = () => loadJob(el.dataset.id);
  });
}

function statusText(s) {
  return (
    {
      PLANNED: '待执行',
      RUNNING: '执行中',
      DONE: '已完成',
      PARTIAL: '部分完成',
      FAILED: '失败',
      CANCELLED: '已取消',
    }[s] || s || ''
  );
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
  $('#btnPlan').onclick = doPlan;
  $('#btnNew').onclick = () => {
    if (state.es) state.es.close();
    state.job = null;
    state.phase = 'idle';
    state.live.clear();
    state.summaryText = '';
    $('#goalInput').value = '';
    $('#stage').innerHTML =
      '<div class="empty"><div class="et">还没有任务</div><div class="es">上面写一句你想做的事，总控会拆成几块并行推进</div></div>';
    history.replaceState(null, '', location.pathname);
    renderJobs();
    $('#goalInput').focus();
  };

  $('#btnRoles').onclick = openRoles;

  $('#goalInput').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      doPlan();
    }
  });

  $('#stage').addEventListener('click', onStageClick);
}

function onStageClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;

  if (act === 'execute') startRun();
  if (act === 'replan') replan();
  if (act === 'cancel') cancelRun();
  if (act === 'export') exportMd();
  if (act === 'role') {
    if (state.phase !== 'planned') return;
    openRolePicker(btn.dataset.id);
  }
  if (act === 'toggle') {
    const id = btn.dataset.id;
    if (state.expanded.has(id)) state.expanded.delete(id);
    else state.expanded.add(id);
    renderStage();
  }
  if (act === 'copy') {
    const id = btn.dataset.id;
    const text = state.live.get(id)?.text || '';
    navigator.clipboard?.writeText(text).then(
      () => toast('已复制'),
      () => toast('复制失败', true),
    );
  }
}

/* ---------------- 规划 ---------------- */

async function doPlan() {
  const goal = $('#goalInput').value.trim();
  if (goal.length < 4) return toast('至少写 4 个字，让我知道你要干什么', true);

  state.phase = 'planning';
  state.live.clear();
  state.summaryText = '';
  renderStage();

  const t0 = Date.now();
  try {
    const job = await api('/api/jobs', { method: 'POST', body: { goal } });
    state.job = job;
    state.phase = 'planned';
    history.replaceState(null, '', `#job/${job.id}`);
    renderStage();
    refreshJobs();
    toast(`已拆成 ${job.plan.tasks.length} 个任务，用了 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
  } catch (err) {
    state.phase = 'idle';
    renderStage();
    toast(`拆解失败：${err.message}`, true);
  }
}

async function replan() {
  if (!state.job) return;
  state.phase = 'planning';
  renderStage();
  try {
    const job = await api(`/api/jobs/${state.job.id}/replan`, { method: 'POST', body: {} });
    state.job = job;
    state.phase = 'planned';
    state.live.clear();
    state.summaryText = '';
    renderStage();
    refreshJobs();
    toast('已重新规划');
  } catch (err) {
    state.phase = 'planned';
    renderStage();
    toast(`重新规划失败：${err.message}`, true);
  }
}

async function loadJob(id) {
  if (state.es) {
    state.es.close();
    state.es = null;
  }
  try {
    const job = await api(`/api/jobs/${id}`);
    state.job = job;
    state.live.clear();
    state.summaryText = job.summary?.content || '';
    for (const r of job.runs || []) {
      if (r.output) state.live.set(r.taskId, { text: r.output, reasoning: '' });
    }
    state.phase = job.running || job.status === 'RUNNING' ? 'running' : job.summary ? 'done' : 'planned';
    if (state.phase === 'running') {
      renderStage();
      attachStream(job.id);
      subscribeExisting(job.id);
    } else {
      renderStage();
    }
    renderJobs();
    history.replaceState(null, '', `#job/${job.id}`);
  } catch (err) {
    toast(`加载失败：${err.message}`, true);
  }
}

/* ---------------- 执行 ---------------- */

async function startRun() {
  if (!state.job) return;
  const id = state.job.id;
  state.phase = 'running';
  state.live.clear();
  state.summaryText = '';
  for (const t of state.job.plan.tasks) state.live.set(t.id, { text: '', reasoning: '' });
  renderStage();

  try {
    await api(`/api/jobs/${id}/execute`, { method: 'POST' });
  } catch (err) {
    state.phase = 'planned';
    renderStage();
    return toast(`启动失败：${err.message}`, true);
  }

  attachStream(id);
}

function attachStream(jobId) {
  if (state.es) state.es.close();
  const es = new EventSource(`/api/jobs/${jobId}/events`);
  state.es = es;

  es.onmessage = (ev) => {
    let data;
    try {
      data = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleEvent(data);
  };

  es.onerror = () => {
    // SSE 断开：让浏览器自己重连，同时标记一下
    if (state.phase === 'running') {
      /* 浏览器会自动重连，这里不手动 close */
    }
  };
}

async function subscribeExisting(jobId) {
  attachStream(jobId);
}

function handleEvent(evt) {
  const { type } = evt;

  // 连接建立时的状态快照：补齐订阅前丢掉的事件
  if (type === 'job:snapshot') {
    for (const r of evt.runs || []) {
      if (r.status === 'DONE' && r.output) {
        state.live.set(r.taskId, { text: r.output, reasoning: state.live.get(r.taskId)?.reasoning || '' });
        patchStatus(r.taskId, 'DONE', r.durationMs);
        const card = state.nodes.get(r.taskId);
        const out = card?.querySelector('[data-role="output"]');
        if (out && !out.textContent) out.textContent = r.output;
      } else if (r.status === 'RUNNING') {
        patchStatus(r.taskId, 'RUNNING');
      } else if (r.status === 'FAILED') {
        patchStatus(r.taskId, 'FAILED', null, r.error);
      }
    }
    if (evt.summary && !state.summaryText) {
      state.summaryText = evt.summary;
      const slot = $('#summarySlot');
      if (slot) slot.innerHTML = `<div class="prose">${mdToHtml(evt.summary)}</div>`;
    }
    updateProgress();
    return;
  }

  if (type === 'job:start') {
    state.phase = 'running';
    renderStage();
    return;
  }

  if (type === 'task:start') {
    const cell = state.live.get(evt.taskId) || { text: '', reasoning: '' };
    cell.text = '';
    cell.reasoning = '';
    state.live.set(evt.taskId, cell);
    patchStatus(evt.taskId, 'RUNNING');
    return;
  }

  if (type === 'task:delta') {
    const cell = state.live.get(evt.taskId) || { text: '', reasoning: '' };
    cell.text += evt.text;
    state.live.set(evt.taskId, cell);
    appendOutput(evt.taskId, evt.text);
    return;
  }

  if (type === 'task:reasoning') {
    const cell = state.live.get(evt.taskId) || { text: '', reasoning: '' };
    cell.reasoning += evt.text;
    state.live.set(evt.taskId, cell);
    return;
  }

  if (type === 'task:done') {
    const cell = state.live.get(evt.taskId) || { text: '', reasoning: '' };
    cell.text = evt.output;
    state.live.set(evt.taskId, cell);
    patchStatus(evt.taskId, 'DONE', evt.durationMs);
    updateProgress();
    return;
  }

  if (type === 'task:error') {
    patchStatus(evt.taskId, 'FAILED', null, evt.error);
    updateProgress();
    return;
  }

  if (type === 'task:retry') {
    const card = state.nodes.get(evt.taskId);
    if (card) {
      const out = card.querySelector('.output');
      if (out) out.textContent += `\n\n— 第 ${evt.attempt} 次失败，正在重试：${evt.error} —\n\n`;
    }
    return;
  }

  if (type === 'summary:start') {
    state.summaryText = '';
    const box = $('#summarySlot');
    if (box) box.innerHTML = '<div class="planning-state"><div class="spinner"></div><div><div class="pt">总控正在合并交付</div><div class="ps">把所有子任务产出整理成一份能直接用的成果</div></div></div>';
    return;
  }

  if (type === 'summary:delta') {
    state.summaryText += evt.text;
    const box = $('#summarySlot .prose');
    if (box) box.innerHTML = mdToHtml(state.summaryText) + '<span class="caret"></span>';
    else {
      const slot = $('#summarySlot');
      if (slot) slot.innerHTML = `<div class="prose">${mdToHtml(state.summaryText)}<span class="caret"></span></div>`;
    }
    return;
  }

  if (type === 'summary:done') {
    state.summaryText = evt.content;
    const slot = $('#summarySlot');
    if (slot) slot.innerHTML = `<div class="prose">${mdToHtml(evt.content)}</div>`;
    return;
  }

  if (type === 'summary:error') {
    const slot = $('#summarySlot');
    if (slot) slot.innerHTML = `<div class="prose"><p style="color:#fca5a5">汇总失败：${escapeHtml(evt.error)}</p></div>`;
    return;
  }

  if (type === 'job:done') {
    state.phase = 'done';
    if (state.es) {
      state.es.close();
      state.es = null;
    }
    // 用服务端存的最新状态覆盖，避免漏事件导致显示不一致
    api(`/api/jobs/${state.job.id}`)
      .then((job) => {
        state.job = job;
        if (job.summary?.content) state.summaryText = job.summary.content;
        renderStage();
        renderJobs();
      })
      .catch(() => {});
    return;
  }
}

async function cancelRun() {
  if (!state.job) return;
  try {
    await api(`/api/jobs/${state.job.id}/cancel`, { method: 'POST' });
    toast('已请求取消');
  } catch (err) {
    toast(`取消失败：${err.message}`, true);
  }
}

/* ---------------- 渲染 ---------------- */

function renderStage() {
  const stage = $('#stage');
  state.nodes.clear();

  if (state.phase === 'idle') {
    stage.innerHTML =
      '<div class="empty"><div class="et">还没有任务</div><div class="es">上面写一句你想做的事，总控会拆成几块并行推进</div></div>';
    return;
  }

  if (state.phase === 'planning') {
    stage.innerHTML = `
      <div class="planning-state">
        <div class="spinner"></div>
        <div>
          <div class="pt">总控正在读你的需求并分配人手</div>
          <div class="ps">判断该拆成几块、每块交给谁、哪些能同时开工</div>
        </div>
      </div>`;
    return;
  }

  const job = state.job;
  if (!job) return;

  const tasks = job.plan?.tasks || [];
  const layers = groupLayers(tasks);
  const parallelLayers = layers.filter((l) => l.length > 1).length;

  stage.innerHTML = `
    <div class="block-card thinking">
      <div class="section-head">
        <h2>总控的理解</h2>
        <span class="meta">${escapeHtml(job.plan?.complexity || '')}${job.planMeta?.model ? ` · ${escapeHtml(job.planMeta.model)}` : ''}</span>
      </div>
      <p>${escapeHtml(job.plan?.understanding || job.goal)}</p>
      ${
        job.plan?.assumptions?.length
          ? `<div class="assumptions">${job.plan.assumptions.map((a) => `<span class="assumption">假设：${escapeHtml(a)}</span>`).join('')}</div>`
          : ''
      }
    </div>

    <div class="block-card">
      <div class="section-head">
        <h2>分派方案</h2>
        <span class="meta">${tasks.length} 个任务 · ${new Set(tasks.map((t) => t.roleId)).size} 个角色 · ${parallelLayers} 层并行</span>
      </div>
      <div id="planBody">${renderWaves(layers, job)}</div>
      ${renderActionBar(job, tasks)}
    </div>

    <div id="summarySlot">${renderSummarySlot(job)}</div>
  `;

  // 缓存卡片节点，供流式 patch 用
  stage.querySelectorAll('.task-card').forEach((el) => state.nodes.set(el.dataset.id, el));
  updateProgress();
}

function groupLayers(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const lv = new Map();
  const calc = (id, guard = new Set()) => {
    if (lv.has(id)) return lv.get(id);
    if (guard.has(id)) return 0;
    guard.add(id);
    const deps = (byId.get(id)?.dependsOn || []).filter((d) => byId.has(d));
    const v = deps.length ? Math.max(...deps.map((d) => calc(d, guard))) + 1 : 0;
    guard.delete(id);
    lv.set(id, v);
    return v;
  };
  for (const t of tasks) calc(t.id);

  const buckets = new Map();
  for (const t of tasks) {
    const level = lv.get(t.id) || 0;
    if (!buckets.has(level)) buckets.set(level, []);
    buckets.get(level).push(t);
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([, list]) => list);
}

function renderWaves(layers, job) {
  return layers
    .map((list, idx) => {
      const label =
        list.length > 1 ? `第 ${idx + 1} 波 · ${list.length} 个同时开工` : `第 ${idx + 1} 波 · 单线`;
      return `
      <div class="wave">
        <div class="wave-head">
          <span class="wave-no">L${idx + 1}</span>
          <span>${label}</span>
          <span class="wave-line"></span>
        </div>
        <div class="task-grid">${list.map((t) => renderCard(t, job)).join('')}</div>
      </div>`;
    })
    .join('');
}

function renderCard(task, job) {
  const role = roleOf(task.roleId);
  const run = (job.runs || []).find((r) => r.taskId === task.id);
  const st = run?.status || 'PENDING';
  const cell = state.live.get(task.id);
  const expanded = state.expanded.has(task.id);
  const deps = (task.dependsOn || []).map((d) => `<span class="chip dep">← ${d}</span>`).join('');
  const dur = run?.durationMs ? `${(run.durationMs / 1000).toFixed(1)}s` : '';

  const canChange = state.phase === 'planned';

  return `
  <article class="task-card ${st}" data-id="${task.id}">
    <div class="card-top">
      <div class="role-badge" style="--c:${role.color}${canChange ? ';cursor:pointer' : ''}"${
        canChange ? ` data-act="role" data-id="${task.id}" title="点击换一个角色"` : ''
      }>${escapeHtml(role.badge)}</div>
      <div class="card-title">
        <h3>${escapeHtml(task.title)}</h3>
        <span class="role-name">${escapeHtml(role.name)}${canChange ? ' · 可换人' : ''}</span>
      </div>
      <span class="status-chip ${st}" data-role="chip">${chipText(st)}${dur ? ` ${dur}` : ''}</span>
    </div>

    <p class="objective">${escapeHtml(task.objective)}</p>

    <div class="card-meta">
      <span class="chip">产出 · ${escapeHtml(shorten(task.deliverable, 26))}</span>
      ${deps}
    </div>

    ${
      expanded
        ? `<div class="card-expand">
             <b>已知输入</b><br>${escapeHtml(task.input || '—')}<br><br>
             <b>验收标准</b>
             <ul class="acceptance">${task.acceptance.map((a) => `<li>${escapeHtml(a)}</li>`).join('')}</ul>
           </div>`
        : `<ul class="acceptance">${task.acceptance.slice(0, 2).map((a) => `<li>${escapeHtml(a)}</li>`).join('')}</ul>`
    }

    <div class="output" data-role="output">${cell?.text ? escapeHtml(cell.text) : ''}</div>

    <div style="display:flex;gap:6px;margin-top:9px">
      <button class="btn sm ghost" data-act="toggle" data-id="${task.id}">${expanded ? '收起' : '详情'}</button>
      ${cell?.text ? `<button class="btn sm ghost" data-act="copy" data-id="${task.id}">复制产出</button>` : ''}
    </div>
  </article>`;
}

function chipText(st) {
  return { PENDING: '待执行', RUNNING: '进行中', DONE: '已交付', FAILED: '失败' }[st] || st;
}

function shorten(s, n) {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function renderActionBar(job, tasks) {
  const isRunning = state.phase === 'running';
  const isDone = state.phase === 'done';
  const doneCount = (job.runs || []).filter((r) => r.status === 'DONE').length;

  return `
  <div class="action-bar">
    ${
      isRunning
        ? `<button class="btn danger" data-act="cancel">中止</button>
           <div class="progress-wrap">
             <div class="progress-track"><div class="progress-fill" id="progressFill" style="width:0%"></div></div>
             <span id="progressText">0 / ${tasks.length}</span>
           </div>`
        : isDone
          ? `<button class="btn primary" data-act="export">导出 Markdown</button>
             <button class="btn ghost" data-act="execute">再跑一遍</button>`
          : `<button class="btn primary lg" data-act="execute">交给他们执行 →</button>
             <button class="btn ghost" data-act="replan">重新规划</button>`
    }
    <div class="spacer"></div>
    <span class="meta" style="font-size:11.5px;color:var(--text-faint)">${isDone ? `已完成 ${doneCount}/${tasks.length}` : ''}</span>
  </div>`;
}

function renderSummarySlot(job) {
  if (state.summaryText) {
    return `
    <div class="summary-card">
      <div class="section-head">
        <h2>交付成果</h2>
        <span class="meta">${job.summary?.usage?.completion_tokens ? `${job.summary.usage.completion_tokens} tokens` : ''}</span>
      </div>
      <div class="prose">${mdToHtml(state.summaryText)}</div>
    </div>`;
  }

  const hasRuns = (job.runs || []).some((r) => r.status === 'DONE');
  if (!hasRuns) {
    return state.phase === 'running'
      ? `<div class="summary-card"><div class="section-head"><h2>交付成果</h2></div>
         <p style="font-size:12.5px;color:var(--text-faint);margin:0">所有子任务完成后，总控会把产出合并成一份可直接使用的成果。</p></div>`
      : '';
  }
  return '';
}

function patchStatus(taskId, st, durationMs, error) {
  const card = state.nodes.get(taskId);
  if (!card) return;
  card.classList.remove('PENDING', 'RUNNING', 'DONE', 'FAILED');
  card.classList.add(st);
  const chip = card.querySelector('[data-role="chip"]');
  if (chip) {
    chip.className = `status-chip ${st}`;
    chip.textContent = chipText(st) + (durationMs ? ` ${(durationMs / 1000).toFixed(1)}s` : '');
  }
  const out = card.querySelector('[data-role="output"]');
  if (out) {
    if (st === 'RUNNING') out.textContent = '';
    if (st === 'FAILED' && error) out.textContent = `执行失败：${error}`;
  }
}

function appendOutput(taskId, text) {
  const card = state.nodes.get(taskId);
  if (!card) return;
  const out = card.querySelector('[data-role="output"]');
  if (!out) return;
  const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 24;
  out.appendChild(document.createTextNode(text));
  if (atBottom) out.scrollTop = out.scrollHeight;
}

function updateProgress() {
  if (!state.job) return;
  const total = state.job.plan?.tasks?.length || 0;
  const done = (state.job.runs || []).filter((r) => r.status === 'DONE' || r.status === 'FAILED').length;
  const fill = $('#progressFill');
  const txt = $('#progressText');
  if (fill) fill.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
  if (txt) txt.textContent = `${done} / ${total}`;
}

function exportMd() {
  if (!state.job) return;
  window.location.href = `/api/jobs/${state.job.id}/export`;
}

/* ---------------- 角色库 ---------------- */

function openRoles() {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal">
      <div class="modal-head">
        <h3>角色库</h3>
        <button class="btn ghost sm" data-close>关闭</button>
      </div>
      <div class="modal-body">
        <div id="roleBody">${renderRoleList()}</div>

        <details style="margin-top:18px">
          <summary style="cursor:pointer;font-size:12.5px;color:#a5b4fc;outline:none">+ 新增自定义角色</summary>
          <div style="margin-top:12px">
            <div class="field">
              <label>角色名称</label>
              <input id="nrName" placeholder="例：法务顾问">
            </div>
            <div class="field">
              <label>职责一句话（总控靠这句话判断该派谁）</label>
              <input id="nrSummary" placeholder="例：合规审查、合同风险、资质判断">
            </div>
            <div class="field">
              <label>工作要求（写专业判断标准，别写人设）</label>
              <textarea id="nrPersona" rows="4" placeholder="你是法务顾问。你的判断标准：&#10;- 先看有没有资质，再看条款怎么写&#10;- 所有结论要给依据条款"></textarea>
            </div>
            <div class="field">
              <label>模型档位</label>
              <select id="nrTier">
                <option value="fast">快 · 产出型任务</option>
                <option value="strong">强 · 需要深度推理</option>
              </select>
            </div>
            <button class="btn primary" id="nrSave">保存角色</button>
          </div>
        </details>
      </div>
      <div class="modal-foot">
        <button class="btn ghost" data-close>完成</button>
      </div>
    </div>`;

  document.body.appendChild(mask);

  const close = () => mask.remove();
  mask.querySelectorAll('[data-close]').forEach((b) => (b.onclick = close));
  mask.addEventListener('click', (e) => {
    if (e.target === mask) close();
  });

  const refresh = () => {
    const body = mask.querySelector('#roleBody');
    if (body) body.innerHTML = renderRoleList();
    renderJobs();
  };

  mask.addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del]');
    if (!del) return;
    try {
      await api(`/api/roles/${encodeURIComponent(del.dataset.del)}`, { method: 'DELETE' });
      state.roles = await api('/api/roles');
      refresh();
      toast('角色已删除');
    } catch (err) {
      toast(`删除失败：${err.message}`, true);
    }
  });

  const saveBtn = mask.querySelector('#nrSave');
  saveBtn.onclick = async () => {
    const name = mask.querySelector('#nrName').value.trim();
    const summary = mask.querySelector('#nrSummary').value.trim();
    const persona = mask.querySelector('#nrPersona').value.trim();
    const tier = mask.querySelector('#nrTier').value;

    if (!name) return toast('角色名称必填', true);
    if (!summary) return toast('职责一句话必填——总控靠它判断派谁', true);
    if (persona.length < 10) return toast('工作要求太短，至少写一句判断标准', true);

    try {
      await api('/api/roles', {
        method: 'POST',
        body: {
          id: `c_${Date.now().toString(36)}`,
          name,
          badge: name.slice(0, 1),
          color: '#6366f1',
          tier,
          summary,
          persona,
        },
      });
      state.roles = await api('/api/roles');
      refresh();
      mask.querySelector('#nrName').value = '';
      mask.querySelector('#nrSummary').value = '';
      mask.querySelector('#nrPersona').value = '';
      toast(`已新增角色「${name}」`);
    } catch (err) {
      toast(`保存失败：${err.message}`, true);
    }
  };
}

function renderRoleList() {
  return `
    <div style="margin-bottom:14px;font-size:12px;color:var(--text-faint)">
      共 ${state.roles.length} 个角色。预置角色不可删除；新增同 id 的角色会覆盖预置项。
    </div>
    ${state.roles
      .map(
        (r) => `
      <div class="role-row">
        <div class="role-badge" style="--c:${r.color}">${escapeHtml(r.badge)}</div>
        <div style="flex:1">
          <div class="rn">${escapeHtml(r.name)} <span style="color:var(--text-faint);font-weight:400;font-size:11px">${r.id} · ${r.tier === 'strong' ? '强模型' : '快模型'}</span></div>
          <div class="rs">${escapeHtml(r.summary || '')}</div>
        </div>
        ${r.builtin ? '<span class="chip">预置</span>' : `<button class="btn sm ghost" data-del="${r.id}">删除</button>`}
      </div>`,
      )
      .join('')}`;
}

/* ---------------- 换人 ---------------- */

function openRolePicker(taskId) {
  const job = state.job;
  if (!job) return;
  const task = (job.plan?.tasks || []).find((t) => t.id === taskId);
  if (!task) return;

  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal" style="width:min(460px,100%)">
      <div class="modal-head">
        <h3>换人执行</h3>
        <button class="btn ghost sm" data-close>取消</button>
      </div>
      <div class="modal-body">
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:12px">
          ${escapeHtml(task.title)} · 当前由「${escapeHtml(roleOf(task.roleId).name)}」负责
        </div>
        ${state.roles
          .map(
            (r) => `
          <button class="btn ghost" data-pick="${r.id}"
            style="width:100%;justify-content:flex-start;gap:10px;margin-bottom:6px;height:auto;padding:8px 10px;text-align:left;${
              r.id === task.roleId ? 'border-color:#6366f1;background:rgba(99,102,241,0.1)' : ''
            }">
            <span class="role-badge" style="--c:${r.color};width:24px;height:24px;flex:0 0 24px;font-size:11px">${escapeHtml(r.badge)}</span>
            <span style="min-width:0">
              <span style="display:block;font-size:12.5px">${escapeHtml(r.name)}</span>
              <span style="display:block;font-size:11px;color:var(--text-faint);white-space:normal">${escapeHtml(r.summary || '')}</span>
            </span>
          </button>`,
          )
          .join('')}
      </div>
    </div>`;

  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.querySelectorAll('[data-close]').forEach((b) => (b.onclick = close));
  mask.addEventListener('click', (e) => {
    if (e.target === mask) close();
  });

  mask.querySelectorAll('[data-pick]').forEach((b) => {
    b.onclick = async () => {
      const rid = b.dataset.pick;
      if (rid === task.roleId) return close();
      const tasks = job.plan.tasks.map((t) => (t.id === taskId ? { ...t, roleId: rid } : t));
      try {
        const updated = await api(`/api/jobs/${job.id}/plan`, {
          method: 'PATCH',
          body: { plan: { ...job.plan, tasks } },
        });
        state.job = updated;
        state.phase = 'planned';
        close();
        renderStage();
        toast(`已改由「${roleOf(rid).name}」负责`);
      } catch (err) {
        toast(`换人失败：${err.message}`, true);
      }
    };
  });
}

/* ---------------- 启动 ---------------- */

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
