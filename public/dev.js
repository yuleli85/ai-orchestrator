/**
 * 开发智能体视图。
 *
 * 与 app.js（总控台）共享全局工具函数：$ / escapeHtml / mdToHtml / api / toast。
 * 单独一个文件的原因：这个视图的状态机（方案 → 确认 → 执行 → 回滚）和总控完全不同，
 * 混在一起两边都会看不懂。
 */

const devState = {
  workspace: localStorage.getItem('orch.dev.workspace') || '',
  run: null,
  runs: [],
  trail: [],
  step: 0,
  maxSteps: 40,
  es: null,
};

const TERMINAL = ['DONE', 'FAILED', 'CANCELLED', 'ROLLED_BACK'];

/* ---------------- 视图切换 ---------------- */

function switchView(view) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  $('#viewMain').hidden = view !== 'main';
  $('#viewDev').hidden = view !== 'dev';
  const archEl = $('#viewArch');
  if (archEl) archEl.hidden = view !== 'arch';

  if (view === 'dev') {
    renderWs();
    refreshDevRuns();
  }
  // arch.js 后加载，用 typeof 守卫，避免脚本顺序变化时直接抛错
  if (view === 'arch' && typeof renderArchWs === 'function') {
    renderArchWs();
    refreshArchRuns();
  }
}

/* ---------------- 工作区 ---------------- */

function renderWs() {
  const el = $('#wsPath');
  if (!devState.workspace) {
    el.textContent = '未选择（点击下方按钮挑一个项目目录）';
    el.classList.remove('set');
  } else {
    el.textContent = devState.workspace;
    el.classList.add('set');
  }
}

/**
 * 通用目录选择器。返回选中的绝对路径；取消返回 null。
 * 抽出来的原因：开发视图和架构视图都要选目录，复制一份 80 行的弹窗逻辑迟早两边不同步。
 */
async function pickDirectory({ start = '', warn = '', title = '选择目录' } = {}) {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal" style="width:min(680px,94vw)">
        <div class="modal-head">
          <h3>${escapeHtml(title)}</h3>
          <button class="btn ghost sm" data-close>关闭</button>
        </div>
        <div class="modal-body">
          ${warn ? `<div class="dev-warn">${escapeHtml(warn)}</div>` : ''}
          <div class="dir-crumb" id="dirCrumb">加载中…</div>
          <div class="dir-list" id="dirList"></div>
          <div style="display:flex;gap:8px;margin-top:10px">
            <input id="dirInput" placeholder="也可以直接粘贴完整路径，如 D:////work////my-project"
                   style="flex:1;height:34px;padding:0 10px;border-radius:8px;border:1px solid var(--line);background:var(--panel-2);color:var(--text)">
            <button class="btn" id="dirGo">用这个</button>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn ghost" data-close>取消</button>
          <button class="btn primary" id="dirPick" disabled>选这个目录</button>
        </div>
      </div>`;
    document.body.appendChild(mask);

    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      mask.remove();
      resolve(val);
    };

    mask.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => done(null)));
    mask.addEventListener('click', (e) => {
      if (e.target === mask) done(null);
    });

    let current = start || '';
    let listing = null;

    const render = () => {
      if (!listing) return;
      $('#dirCrumb').textContent = listing.abs;
      $('#dirList').innerHTML = [
        listing.parent
          ? '<div class="dir-item" data-nav="__parent__"><span class="ico">↑</span><span>上级目录</span></div>'
          : '',
        ...listing.entries.map(
          (d) => `<div class="dir-item" data-nav="${escapeHtml(d.path)}"><span class="ico">▸</span><span>${escapeHtml(d.name)}</span></div>`,
        ),
        listing.entries.length ? '' : '<div class="dir-item" style="cursor:default">（没有子目录，可以直接选这个目录）</div>',
      ].join('');
      $('#dirPick').disabled = false;
    };

    const load = async (p) => {
      try {
        const data = await api(`/api/fs/list${p ? `?path=${encodeURIComponent(p)}` : ''}`);
        listing = data;
        current = data.abs;
        render();
      } catch (err) {
        $('#dirCrumb').textContent = `打不开：${err.message}`;
      }
    };

    $('#dirList').addEventListener('click', (e) => {
      const item = e.target.closest('[data-nav]');
      if (!item) return;
      const nav = item.dataset.nav;
      load(nav === '__parent__' ? listing.parent : nav);
    });

    $('#dirGo').onclick = () => {
      const v = $('#dirInput').value.trim();
      if (v) load(v);
    };

    $('#dirPick').onclick = () => done(current);

    load(current || '');
  });
}

async function openWorkspacePicker() {
  const picked = await pickDirectory({
    start: devState.workspace,
    title: '选择工作区',
    warn: '开发智能体只能在这个目录内读写文件、执行构建与测试命令。改动会先备份，随时可以回滚。',
  });
  if (!picked) return;
  devState.workspace = picked;
  localStorage.setItem('orch.dev.workspace', picked);
  renderWs();
  toast('工作区已切换');
}

/* ---------------- 列表 ---------------- */

async function refreshDevRuns() {
  try {
    devState.runs = await api('/api/dev/runs');
    renderDevList();
  } catch {
    /* 静默：列表失败不影响主流程 */
  }
}

function renderDevList() {
  const box = $('#devList');
  if (!devState.runs.length) {
    box.innerHTML = '<div class="side-label" style="padding:6px 10px;color:var(--text-faint)">还没有记录</div>';
    return;
  }
  box.innerHTML = devState.runs
    .map((r) => {
      const active = devState.run?.id === r.id ? ' active' : '';
      const dot = { DONE: 'DONE', FAILED: 'FAILED', RUNNING: 'RUNNING', DESIGNING: 'RUNNING', CANCELLED: 'PARTIAL', ROLLED_BACK: 'PARTIAL' }[r.status] || '';
      return `<div class="job-item${active}" data-run="${r.id}">
        <div class="jt">${escapeHtml(shorten(r.task, 26))}</div>
        <div class="jm"><span class="mini-dot ${dot}"></span>${r.changeCount} 文件 · ${statusCn(r.status)}</div>
      </div>`;
    })
    .join('');
}

function statusCn(s) {
  return {
    CREATED: '待出方案',
    DESIGNING: '读代码中',
    PLANNED: '待确认',
    RUNNING: '执行中',
    DONE: '已完成',
    FAILED: '失败',
    CANCELLED: '已取消',
    ROLLED_BACK: '已回滚',
  }[s] || s;
}

/* ---------------- 创建 / 设计 / 执行 ---------------- */

async function devDesign() {
  const task = $('#devTask').value.trim();
  if (!devState.workspace) {
    toast('先选一个工作区目录', true);
    openWorkspacePicker();
    return;
  }
  if (task.length < 4) {
    toast('说清楚要改什么，至少 4 个字', true);
    return;
  }

  const btn = $('#btnDevPlan');
  btn.disabled = true;
  btn.textContent = '读代码中…';

  try {
    const run = await api('/api/dev/runs', { method: 'POST', body: { workspace: devState.workspace, task } });
    devState.run = run;
    devState.trail = [];
    devState.step = 0;
    renderDevStage();
    attachDevStream(run.id);
    await api(`/api/dev/runs/${run.id}/design`, { method: 'POST' });
    refreshDevRuns();
  } catch (err) {
    toast(`失败：${err.message}`, true);
    btn.disabled = false;
    btn.textContent = '出实施方案';
  }
}

async function devExecute() {
  const run = devState.run;
  if (!run) return;
  // 用户可能在方案里改了东西？这里 v1 直接按原方案执行，改方案留给"重新出方案"
  devState.trail = [];
  devState.step = 0;
  renderDevStage();
  attachDevStream(run.id);
  try {
    await api(`/api/dev/runs/${run.id}/execute`, { method: 'POST' });
  } catch (err) {
    toast(`启动失败：${err.message}`, true);
  }
}

async function devCancel() {
  const run = devState.run;
  if (!run) return;
  try {
    await api(`/api/dev/runs/${run.id}/cancel`, { method: 'POST' });
    toast('已发送取消');
  } catch (err) {
    toast(err.message, true);
  }
}

async function devRollback() {
  const run = devState.run;
  if (!run) return;
  const ok = confirm(`把这次改动的 ${run.changes?.length || 0} 个文件恢复到运行前的状态？\n（本次新建的文件会被删除）`);
  if (!ok) return;
  try {
    const r = await api(`/api/dev/runs/${run.id}/rollback`, { method: 'POST' });
    toast(`已恢复 ${r.restored.length} 个、删除 ${r.removed.length} 个${r.failed.length ? `，${r.failed.length} 个失败` : ''}`);
    await loadDevRun(run.id);
    refreshDevRuns();
  } catch (err) {
    toast(`回滚失败：${err.message}`, true);
  }
}

/**
 * 把服务端存下来的 trace 还原成界面上的轨迹行。
 * trace 里一步只有一条 tool 记录（结果合并在 result 字段里），
 * 界面上是"工具行 + 结果行"两条，所以这里要展开，并按步骤变化补分隔线。
 */
function traceToTrail(trace) {
  const out = [];
  let lastStep = -1;
  for (const t of trace || []) {
    if (t.step != null && t.step !== lastStep) {
      out.push({ kind: 'sep', step: t.step });
      lastStep = t.step;
    }
    if (t.kind === 'assistant') {
      out.push({ kind: 'assistant', step: t.step, text: t.text });
    } else if (t.kind === 'tool') {
      out.push({ kind: 'tool', step: t.step, name: t.name, args: t.args });
      if (t.result !== undefined && t.result !== null) {
        out.push({ kind: 'result', step: t.step, name: t.name, ok: t.ok, text: t.result, durationMs: t.durationMs });
      }
    }
  }
  return out;
}

async function loadDevRun(id) {
  try {
    const run = await api(`/api/dev/runs/${id}`);
    devState.run = run;
    devState.trail = traceToTrail(run.trace);
    devState.step = run.step || 0;
    renderDevStage();
    history.replaceState(null, '', `#dev/${id}`);
    if (run.running) attachDevStream(id);
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------------- SSE ---------------- */

function attachDevStream(runId) {
  if (devState.es) {
    devState.es.close();
    devState.es = null;
  }
  const es = new EventSource(`/api/dev/runs/${runId}/events`);
  devState.es = es;

  es.onmessage = (e) => {
    let evt;
    try {
      evt = JSON.parse(e.data);
    } catch {
      return;
    }
    handleDevEvent(evt, runId);
  };
  es.onerror = () => {
    // 服务端在终态会主动断开，这里不要无限重连
    if (devState.run && TERMINAL.includes(devState.run.status)) {
      es.close();
      devState.es = null;
    }
  };
}

function closeStream() {
  if (devState.es) {
    devState.es.close();
    devState.es = null;
  }
}

function handleDevEvent(evt, runId) {
  const run = devState.run;
  if (!run || run.id !== runId) return;

  switch (evt.type) {
    case 'dev:snapshot': {
      // 刷新页面/重连时恢复现场
      run.status = evt.status;
      if (evt.design) run.design = evt.design;
      run.summary = evt.summary;
      run.verification = evt.verification;
      run.remaining = evt.remaining;
      run.changes = evt.changes || [];
      run.commands = evt.commands || [];
      run.error = evt.error;
      devState.step = evt.step || 0;
      if (!devState.trail.length && evt.trace?.length) {
        devState.trail = traceToTrail(evt.trace);
      }
      renderDevStage();
      break;
    }

    case 'dev:status': {
      run.status = evt.status;
      renderDevStage();
      if (TERMINAL.includes(evt.status)) {
        closeStream();
        refreshDevRuns();
        const btn = $('#btnDevPlan');
        btn.disabled = false;
        btn.textContent = '出实施方案';
      }
      break;
    }

    case 'dev:design:start':
      run.status = 'DESIGNING';
      renderDevStage();
      break;

    case 'dev:design:done':
      run.design = evt.design;
      renderDevStage();
      break;

    case 'dev:step': {
      devState.step = evt.step;
      if (evt.maxSteps) devState.maxSteps = evt.maxSteps;
      const counter = $('#stepCounter');
      if (counter) counter.textContent = `${evt.step} / ${devState.maxSteps}`;
      appendTrail({ kind: 'sep', step: evt.step });
      break;
    }

    case 'dev:assistant':
      appendTrail({ kind: 'assistant', step: evt.step, text: evt.text });
      break;

    case 'dev:tool':
      appendTrail({ kind: 'tool', step: evt.step, name: evt.name, args: evt.args });
      break;

    case 'dev:tool:result':
      appendTrail({ kind: 'result', step: evt.step, name: evt.name, ok: evt.ok, text: evt.preview, durationMs: evt.durationMs });
      break;

    case 'dev:file': {
      const prev = (run.changes || []).find((c) => c.path === evt.path);
      if (prev) prev.bytes = evt.bytes;
      else run.changes = [...(run.changes || []), { path: evt.path, action: evt.action, bytes: evt.bytes, lines: evt.lines || 0 }];
      paintLiveCount();
      break;
    }

    case 'dev:cmd':
      run.commands = [
        ...(run.commands || []),
        { command: evt.command, ok: evt.ok, exitCode: evt.exitCode, durationMs: evt.durationMs, blocked: evt.blocked },
      ];
      paintLiveCount();
      break;

    case 'dev:done':
      run.summary = evt.summary;
      run.verification = evt.verification;
      run.remaining = evt.remaining;
      run.changes = evt.changes || [];
      run.commands = evt.commands || [];
      run.durationMs = evt.durationMs;
      renderDevStage();
      break;

    case 'dev:error':
      run.error = evt.error;
      renderDevStage();
      break;

    case 'dev:warning':
      appendTrail({ kind: 'warn', step: devState.step, text: evt.message });
      break;

    default:
      break;
  }
}

/* ---------------- 渲染 ---------------- */

const TOOL_CN = {
  list_files: '看目录',
  read_file: '读文件',
  search: '搜代码',
  write_file: '写文件',
  edit_file: '改文件',
  run_command: '跑命令',
  finish: '收工',
};

function renderDevStage() {
  const stage = $('#devStage');
  const run = devState.run;

  if (!run) {
    stage.innerHTML =
      '<div class="empty"><div class="et">还没有开发任务</div><div class="es">选一个项目目录，说清楚要改什么，它会先读代码再动手</div></div>';
    return;
  }

  const parts = [];

  if (run.status === 'DESIGNING' && !run.design) {
    parts.push(`<div class="design-card"><div class="design-head"><h2>正在读代码、出方案</h2><span class="meta">通常 10~25 秒</span></div>
      <div class="design-body"><p style="color:var(--text-faint)">先看目录结构、关键配置文件，再决定改哪些文件。这一步不会动你的代码。</p></div></div>`);
  }

  if (run.design) parts.push(renderDesign(run));

  if (run.status === 'RUNNING' || devState.trail.length) parts.push(renderTrailShell(run));

  if (TERMINAL.includes(run.status) && run.summary !== null) parts.push(renderResult(run));

  if (run.error && !run.summary) {
    parts.push(`<div class="result-card bad"><div class="result-head"><h2>执行失败</h2></div>
      <div class="result-body"><p style="color:#fca5a5">${escapeHtml(run.error)}</p></div>
      ${renderActions(run)}</div>`);
  }

  stage.innerHTML = parts.join('');
  paintTrail();
}

function renderDesign(run) {
  const d = run.design;
  const files = (d.files || [])
    .map(
      (f) => `<div class="file-row"><span class="op ${f.action === 'create' ? 'create' : 'modify'}">${
        f.action === 'create' ? '新建' : '修改'
      }</span><span class="p">${escapeHtml(f.path)}</span><span class="why">${escapeHtml(f.purpose || '')}</span></div>`,
    )
    .join('');

  return `<div class="design-card">
    <div class="design-head">
      <h2>实施方案</h2>
      <span class="meta">${statusCn(run.status)}${run.design?.model ? ` · ${escapeHtml(run.design.model)}` : ''}</span>
    </div>
    <div class="design-body">
      <h3>要解决的问题</h3>
      <p>${escapeHtml(d.understanding || '')}</p>
      ${d.approach?.length ? `<h3>技术方案</h3><ol>${d.approach.map((a) => `<li>${escapeHtml(a)}</li>`).join('')}</ol>` : ''}
      ${files ? `<h3>计划改动的文件</h3><div class="file-list">${files}</div>` : ''}
      ${d.steps?.length ? `<h3>实施步骤</h3><ol>${d.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>` : ''}
      ${d.verify?.length ? `<h3>验证方式</h3><div class="verify-box">${d.verify.map((v) => `$ ${escapeHtml(v)}`).join('<br>')}</div>` : ''}
      ${d.risks?.length ? `<h3>可能踩的坑</h3><ul>${d.risks.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>` : ''}
    </div>
    ${renderActions(run)}
  </div>`;
}

function renderActions(run) {
  const btns = [];
  if (run.status === 'PLANNED') {
    btns.push('<button class="btn primary" data-dev-act="execute">确认，开始执行</button>');
    btns.push('<button class="btn ghost" data-dev-act="redesign">不满意，重新出方案</button>');
  }
  if (run.status === 'DESIGNING') {
    btns.push('<button class="btn danger" data-dev-act="cancel">停止</button>');
  }
  if (run.status === 'RUNNING') {
    btns.push('<button class="btn danger" data-dev-act="cancel">停止执行</button>');
  }
  if (TERMINAL.includes(run.status) && (run.changes?.length || 0) > 0) {
    btns.push('<button class="btn danger" data-dev-act="rollback">回滚这次改动</button>');
    btns.push('<button class="btn ghost" data-dev-act="redesign">重新出方案</button>');
  }
  if (!btns.length) return '';
  return `<div class="dev-actions">${btns.join('')}</div>`;
}

function renderTrailShell(run) {
  const running = run.status === 'RUNNING';
  return `<div class="trail${running ? '' : ' done'}">
    <div class="trail-head">
      <span>${running ? '正在执行' : '执行记录'}</span>
      <span id="liveCount" style="font-size:11.5px;color:var(--text-faint);font-weight:400">${liveCountText(run)}</span>
      <span class="step-counter" id="stepCounter">${devState.step} / ${devState.maxSteps}</span>
    </div>
    <div class="trail-body" id="trailBody"></div>
  </div>`;
}

function liveCountText(run) {
  const files = (run.changes || []).length;
  const cmds = (run.commands || []).length;
  const okCmds = (run.commands || []).filter((c) => c.ok).length;
  if (!files && !cmds) return '还没动文件';
  return `改动 ${files} 个文件 · 命令 ${cmds} 条${cmds ? `（${okCmds} 通过）` : ''}`;
}

function paintLiveCount() {
  const el = $('#liveCount');
  if (el) el.textContent = liveCountText(devState.run || {});
}

function trailItemHtml(t) {
  if (t.kind === 'sep') return `<div class="tl-item step-sep">第 ${t.step} 步</div>`;
  if (t.kind === 'assistant') {
    return `<div class="tl-item assistant"><span class="tl-icon">▸</span><span class="tl-text">${escapeHtml(t.text)}</span></div>`;
  }
  if (t.kind === 'warn') {
    return `<div class="tl-item assistant"><span class="tl-icon" style="color:var(--amber)">!</span><span class="tl-text" style="color:#fcd34d">${escapeHtml(t.text)}</span></div>`;
  }
  if (t.kind === 'tool') {
    const a = t.args || {};
    const brief = a.path || a.command || a.pattern || a.dir || '';
    return `<div class="tl-item tool"><span class="tl-icon">▸</span><span class="tl-text">${escapeHtml(
      TOOL_CN[t.name] || t.name,
    )} ${escapeHtml(String(brief).slice(0, 120))}</span></div>`;
  }
  if (t.kind === 'result') {
    const preview = String(t.text || '')
      .replace(/\s+/g, ' ')
      .slice(0, 180);
    return `<div class="tl-item result ${t.ok ? 'ok' : 'bad'}"><span class="tl-icon">${t.ok ? '✓' : '✗'}</span><span class="tl-text">${escapeHtml(
      preview,
    )}</span></div>`;
  }
  return '';
}

function paintTrail() {
  const body = $('#trailBody');
  if (!body) return;
  body.innerHTML = devState.trail.map(trailItemHtml).join('');
  // 只有正在跑的时候才跟随到底部。看历史记录时停到底部会让人以为前几步没执行。
  if (devState.run?.status === 'RUNNING') body.scrollTop = body.scrollHeight;
  else body.scrollTop = 0;
}

function appendTrail(item) {
  devState.trail.push(item);
  const body = $('#trailBody');
  if (!body) {
    renderDevStage();
    return;
  }
  body.insertAdjacentHTML('beforeend', trailItemHtml(item));
  body.scrollTop = body.scrollHeight;
}

function renderResult(run) {
  const ok = run.status !== 'FAILED';
  const changed = (run.changes || [])
    .map(
      (c) => `<div class="file-row"><span class="op ${c.action === 'create' ? 'create' : 'modify'}">${
        c.action === 'create' ? '新建' : '修改'
      }</span><span class="p">${escapeHtml(c.path)}</span><span class="why">${
        c.lines ? `${c.lines} 行` : `${(c.bytes / 1024).toFixed(1)}KB`
      }</span></div>`,
    )
    .join('');

  const cmds = (run.commands || [])
    .map(
      (c) => `<div class="cmd-row"><span class="${c.ok ? 'ok' : 'bad'}">${c.ok ? '✓' : '✗'}</span><span class="c">${escapeHtml(
        c.command,
      )}</span><span class="d">${c.exitCode != null ? `exit ${c.exitCode} · ` : ''}${((c.durationMs || 0) / 1000).toFixed(1)}s</span></div>`,
    )
    .join('');

  return `<div class="result-card ${ok ? 'ok' : 'bad'}">
    <div class="result-head">
      <h2>${ok ? '已完成' : '执行失败'}</h2>
      <span class="dur">${run.durationMs ? `${(run.durationMs / 1000).toFixed(1)}s` : ''}</span>
    </div>
    <div class="result-body">
      ${changed ? `<h3>改动的文件</h3><div class="file-list">${changed}</div>` : '<h3>改动的文件</h3><p style="color:var(--text-faint)">没有产生文件改动</p>'}
      ${cmds ? `<h3>执行过的命令</h3><div class="cmd-list">${cmds}</div>` : '<h3>执行过的命令</h3><p style="color:var(--text-faint)">没有执行任何命令（未验证）</p>'}
      ${run.summary ? `<h3>做了什么</h3>${mdToHtml(run.summary)}` : ''}
      ${run.verification ? `<h3>自测结论</h3>${mdToHtml(run.verification)}` : ''}
      ${run.remaining && run.remaining !== '无' ? `<h3>遗留问题</h3>${mdToHtml(run.remaining)}` : ''}
    </div>
    ${renderActions(run)}
  </div>`;
}

/* ---------------- 事件绑定 ---------------- */

function bootDev() {
  renderWs();

  $('#tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) switchView(tab.dataset.view);
  });

  $('#btnWs').onclick = openWorkspacePicker;
  $('#btnDevPlan').onclick = devDesign;

  $('#devStage').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-dev-act]');
    if (!btn) return;
    const act = btn.dataset.devAct;
    if (act === 'execute') devExecute();
    if (act === 'cancel') devCancel();
    if (act === 'rollback') devRollback();
    if (act === 'redesign') {
      closeStream();
      devState.run = null;
      devState.trail = [];
      renderDevStage();
      $('#devTask').focus();
    }
  });

  $('#devList').addEventListener('click', (e) => {
    const item = e.target.closest('[data-run]');
    if (!item) return;
    closeStream();
    loadDevRun(item.dataset.run).then(renderDevList);
  });

  $('#devTask').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      devDesign();
    }
  });

  refreshDevRuns();

  // 支持 #dev/<runId> 直达，方便刷新和分享
  const m = location.hash.match(/^#dev\/(.+)$/);
  if (m) {
    switchView('dev');
    loadDevRun(m[1]);
  }
}

bootDev();
