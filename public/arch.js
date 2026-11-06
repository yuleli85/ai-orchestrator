/**
 * 架构智能体视图。
 *
 * 与开发视图的关键差异：这里有个"等人拍板"的中间态。
 * 诊断出来后必须把 2~3 个候选方案摆出来让人选，选完才进入写文档阶段。
 * 界面要保证这个岔路口足够显眼——方案卡片上的"代价"和"工作量"是决策依据，
 * 藏起来就等于让用户盲选。
 */

const archState = {
  workspace: localStorage.getItem('orch.arch.workspace') || '',
  run: null,
  runs: [],
  trail: [],
  step: 0,
  maxSteps: 24,
  es: null,
  scanStage: null,
  preview: null,
};

const ARCH_TERMINAL = ['DONE', 'FAILED', 'CANCELLED', 'INTERRUPTED', 'ROLLED_BACK'];

/* ---------------- 工作区 ---------------- */

function renderArchWs() {
  const el = $('#archWsPath');
  if (!el) return;
  if (!archState.workspace) {
    el.textContent = '未选择（点击下方按钮挑一个项目目录）';
    el.classList.remove('set');
  } else {
    el.textContent = archState.workspace;
    el.classList.add('set');
  }
}

async function openArchPicker() {
  const picked = await pickDirectory({
    start: archState.workspace,
    title: '选择要分析的代码目录',
    warn: '架构智能体只读代码，产出只写到该目录下的 docs/ 里，不会改动任何源码。',
  });
  if (!picked) return;
  archState.workspace = picked;
  localStorage.setItem('orch.arch.workspace', picked);
  renderArchWs();
  toast('目录已切换');
}

/* ---------------- 列表 ---------------- */

async function refreshArchRuns() {
  try {
    archState.runs = await api('/api/arch/runs');
    renderArchList();
  } catch {
    /* 忽略：列表失败不影响主流程 */
  }
}

function archStatusCn(s) {
  return (
    {
      CREATED: '待扫描',
      SCANNING: '扫描中',
      DIAGNOSED: '待选方向',
      DESIGNING: '写文档中',
      DONE: '已交付',
      FAILED: '失败',
      CANCELLED: '已中止',
      INTERRUPTED: '已中断',
      ROLLED_BACK: '已回滚',
    }[s] || s
  );
}

function renderArchList() {
  const box = $('#archList');
  if (!box) return;
  if (!archState.runs.length) {
    box.innerHTML = '<div style="padding:12px;color:var(--text-faint);font-size:12px">还没有架构任务</div>';
    return;
  }
  box.innerHTML = archState.runs
    .map((r) => {
      const active = archState.run?.id === r.id ? ' active' : '';
      const dot =
        { DONE: 'DONE', FAILED: 'FAILED', INTERRUPTED: 'FAILED', SCANNING: 'RUNNING', DESIGNING: 'RUNNING', DIAGNOSED: 'PARTIAL', CANCELLED: 'PARTIAL', ROLLED_BACK: 'PARTIAL' }[
          r.status
        ] || '';
      const meta =
        r.status === 'DONE'
          ? `${r.docCount} 份文档 · ${r.docLines} 行`
          : r.issueCount
            ? `${r.issueCount} 个问题 · ${r.optionCount} 个方案`
            : archStatusCn(r.status);
      return `<div class="job-item${active}" data-arch="${r.id}">
        <div class="jt">${escapeHtml(shorten(r.goal, 26))}</div>
        <div class="jm"><span class="mini-dot ${dot}"></span>${escapeHtml(meta)}</div>
      </div>`;
    })
    .join('');
}

/* ---------------- 启动扫描 ---------------- */

async function archScan() {
  const goalEl = $('#archGoal');
  const goal = goalEl.value.trim();
  if (!archState.workspace) return toast('先选一个要分析的代码目录', true);
  if (goal.length < 6) return toast('说清楚要解决的架构问题，至少 6 个字', true);

  const btn = $('#btnArchScan');
  btn.disabled = true;
  btn.textContent = '启动中…';
  closeArchStream();

  try {
    const run = await api('/api/arch/runs', { method: 'POST', body: { workspace: archState.workspace, goal } });
    archState.run = run;
    archState.trail = [];
    archState.step = 0;
    archState.scanStage = 'scan';
    archState.preview = null;
    renderArchStage();
    history.replaceState(null, '', `#arch/${run.id}`);

    attachArchStream(run.id);
    // 先让 SSE 连上再启动，否则会丢掉最早的一批事件
    await new Promise((r) => setTimeout(r, 150));
    await api(`/api/arch/runs/${run.id}/diagnose`, { method: 'POST', body: {} });
    goalEl.value = '';
    refreshArchRuns();
  } catch (err) {
    toast(`失败：${err.message}`, true);
    if (archState.run?.status === 'CREATED') archState.run = null;
    renderArchStage();
  } finally {
    btn.disabled = false;
    btn.textContent = '扫描诊断';
  }
}

/* ---------------- 选方向 ---------------- */

async function archDesign(optionId) {
  const run = archState.run;
  if (!run) return;
  try {
    await api(`/api/arch/runs/${run.id}/design`, { method: 'POST', body: { optionId } });
    run.selectedOptionId = optionId;
    run.status = 'DESIGNING';
    archState.trail = [];
    archState.step = 0;
    renderArchStage();
  } catch (err) {
    toast(`启动失败：${err.message}`, true);
  }
}

async function archCancel() {
  if (!archState.run) return;
  try {
    await api(`/api/arch/runs/${archState.run.id}/cancel`, { method: 'POST', body: {} });
    toast('已发送取消');
  } catch (err) {
    toast(err.message, true);
  }
}

async function archRollback() {
  const run = archState.run;
  if (!run) return;
  if (!confirm('把这批文档恢复到运行前的状态？\n\n原来存在的会被还原，本次新建的会被删除。')) return;
  try {
    const r = await api(`/api/arch/runs/${run.id}/rollback`, { method: 'POST', body: {} });
    toast(`已恢复 ${r.restored.length} 份、删除 ${r.removed.length} 份${r.failed.length ? `，${r.failed.length} 份失败` : ''}`);
    await loadArchRun(run.id);
  } catch (err) {
    toast(`回滚失败：${err.message}`, true);
  }
}

/* ---------------- 载入与事件流 ---------------- */

async function loadArchRun(id) {
  try {
    const run = await api(`/api/arch/runs/${id}`);
    archState.run = run;
    // 从链接直达时本地可能没存过工作区，用记录里的补上，
    // 否则左侧一直显示"未选择"，再点扫描会直接报错
    if (!archState.workspace && run.workspace) {
      archState.workspace = run.workspace;
      localStorage.setItem('orch.arch.workspace', run.workspace);
      renderArchWs();
    }
    archState.trail = (run.trace || []).map((t) => ({
      kind: t.kind,
      step: t.step,
      text: t.text,
      name: t.name,
      args: t.args,
      result: t.result,
      ok: t.ok,
    }));
    archState.step = run.step || 0;
    archState.scanStage = null;
    archState.preview = null;
    renderArchStage();
    history.replaceState(null, '', `#arch/${id}`);
    if (run.running) attachArchStream(id);
  } catch (err) {
    toast(err.message, true);
  }
}

function closeArchStream() {
  if (archState.es) {
    archState.es.close();
    archState.es = null;
  }
}

function attachArchStream(runId) {
  closeArchStream();
  const es = new EventSource(`/api/arch/runs/${runId}/events`);
  archState.es = es;
  es.onmessage = (e) => {
    try {
      handleArchEvent(JSON.parse(e.data), runId);
    } catch {
      /* 忽略坏帧 */
    }
  };
  es.onerror = () => {
    // 服务端主动结束时这里也会触发，不用报错，静静关闭即可
    if (ARCH_TERMINAL.includes(archState.run?.status)) closeArchStream();
  };
}

function handleArchEvent(evt, runId) {
  const run = archState.run;
  if (!run || run.id !== runId) return;

  switch (evt.type) {
    case 'arch:snapshot':
      run.status = evt.status;
      if (evt.diagnosis) run.diagnosis = evt.diagnosis;
      if (evt.docs) run.docs = evt.docs;
      if (evt.selectedOptionId) run.selectedOptionId = evt.selectedOptionId;
      if (evt.summary) run.summary = evt.summary;
      if (evt.decisions) run.decisions = evt.decisions;
      if (evt.risks) run.risks = evt.risks;
      if (evt.remaining) run.remaining = evt.remaining;
      if (evt.error) run.error = evt.error;
      if (!archState.trail.length && evt.trace?.length) {
        archState.trail = evt.trace.map((t) => ({ ...t }));
      }
      archState.scanStage = null;
      renderArchStage();
      break;

    case 'arch:status':
      run.status = evt.status;
      if (evt.optionId) run.selectedOptionId = evt.optionId;
      if (ARCH_TERMINAL.includes(evt.status)) {
        archState.scanStage = null;
        closeArchStream();
        refreshArchRuns();
      }
      renderArchStage();
      break;

    case 'arch:scan:start':
      archState.scanStage = 'scan';
      renderArchStage();
      break;

    case 'arch:scan:done':
      archState.scanStage = 'analyze';
      renderArchStage();
      break;

    case 'arch:analyzing':
      archState.scanStage = 'analyze';
      renderArchStage();
      break;

    case 'arch:diagnose:done':
      run.diagnosis = evt.diagnosis;
      archState.scanStage = null;
      renderArchStage();
      refreshArchRuns();
      break;

    case 'arch:step':
      archState.step = evt.step;
      archState.trail.push({ kind: 'sep', step: evt.step });
      paintArchTrail();
      break;

    case 'arch:assistant':
      archState.trail.push({ kind: 'assistant', step: evt.step, text: evt.text });
      paintArchTrail();
      break;

    case 'arch:tool':
      archState.trail.push({ kind: 'tool', step: evt.step, name: evt.name, args: evt.args });
      paintArchTrail();
      break;

    case 'arch:tool:result': {
      const last = [...archState.trail]
        .reverse()
        .find((t) => t.kind === 'tool' && t.step === evt.step && t.name === evt.name && t.result === undefined);
      if (last) {
        last.result = evt.preview;
        last.ok = evt.ok;
      }
      paintArchTrail();
      break;
    }

    case 'arch:doc':
      if (!run.docs) run.docs = [];
      {
        const prev = run.docs.find((d) => d.path === evt.path);
        if (prev) {
          prev.bytes = evt.bytes;
          prev.lines = evt.lines;
        } else {
          run.docs.push({ path: evt.path, action: evt.action, bytes: evt.bytes, lines: evt.lines });
        }
      }
      renderArchStage();
      break;

    case 'arch:warning':
      archState.trail.push({ kind: 'warn', text: evt.message });
      paintArchTrail();
      break;

    case 'arch:error':
      run.status = 'FAILED';
      run.error = evt.error;
      archState.scanStage = null;
      renderArchStage();
      break;

    case 'arch:done':
      run.docs = evt.docs || run.docs;
      run.summary = evt.summary;
      run.decisions = evt.decisions;
      run.risks = evt.risks;
      run.remaining = evt.remaining;
      run.status = 'DONE';
      renderArchStage();
      refreshArchRuns();
      break;

    default:
      break;
  }
}

/* ---------------- 渲染 ---------------- */

function renderArchStage() {
  const box = $('#archStage');
  if (!box) return;
  const run = archState.run;

  if (!run) {
    box.innerHTML = `<div class="empty">
      <div class="et">还没有架构任务</div>
      <div class="es">选一个代码目录，说清楚要解决的问题，它会先告诉你现状和几个可选方向</div>
    </div>`;
    return;
  }

  if (run.status === 'SCANNING' || archState.scanStage) {
    const stageText =
      archState.scanStage === 'analyze' ? '已扫完结构，正在读关键代码并推理' : '正在扫描目录结构、依赖关系与耦合热点';
    box.innerHTML = `<div class="empty">
      <div class="et">${stageText}…</div>
      <div class="es">${escapeHtml(run.goal)}</div>
      <div class="scan-bar"><span></span></div>
    </div>`;
    return;
  }

  if (run.status === 'FAILED' || run.status === 'INTERRUPTED') {
    box.innerHTML = `
      <div class="result-card bad">
        <div class="result-head"><h2>${run.status === 'INTERRUPTED' ? '这次运行被中断' : '诊断失败'}</h2></div>
        <div class="result-body"><p style="color:#fca5a5">${escapeHtml(run.error || '未知错误')}</p></div>
      </div>`;
    return;
  }

  const done = run.status === 'DONE' || run.status === 'ROLLED_BACK';
  const parts = [];

  if (done) {
    // 完成后首屏应该是产出，而不是几十条诊断和轨迹。
    // 用户这时候只关心"写出了什么、定了什么"，过程材料折叠起来备查。
    parts.push(renderArchResult(run));
    if (run.diagnosis) {
      parts.push(
        fold(
          `现状诊断与候选方案（已选 ${escapeHtml(run.selectedOptionId || '')}）`,
          renderAnalysis(run),
        ),
      );
    }
    if (archState.trail.length) parts.push(fold('写文档过程', renderArchTrail(run)));
  } else {
    if (run.diagnosis) parts.push(renderAnalysis(run));
    if (run.status === 'DESIGNING' || archState.trail.length) parts.push(renderArchTrail(run));
  }

  box.innerHTML = parts.join('');
  paintArchTrail();
}

/** 可折叠区块。用原生 details，不写 JS 状态，刷新后也不丢 */
function fold(title, inner) {
  return `<details class="fold"><summary>${title}</summary>${inner}</details>`;
}

function sevLabel(s) {
  return { high: '严重', medium: '中等', low: '轻微' }[s] || s;
}

function renderAnalysis(run) {
  const d = run.diagnosis;
  if (!d) return '';

  const decided = run.status === 'DESIGNING' || run.status === 'DONE' || run.status === 'ROLLED_BACK';

  const issuesHtml = d.issues.length
    ? `<div class="issue-list">${d.issues
        .map(
          (i) => `<div class="issue sev-${i.severity}">
            <div class="issue-top">
              <span class="sev ${i.severity}">${sevLabel(i.severity)}</span>
              <span class="issue-title">${escapeHtml(i.title)}</span>
            </div>
            ${i.evidence ? `<div class="issue-line"><b>证据</b>${escapeHtml(i.evidence)}</div>` : ''}
            ${i.impact ? `<div class="issue-line"><b>影响</b>${escapeHtml(i.impact)}</div>` : ''}
          </div>`,
        )
        .join('')}</div>`
    : `<p style="color:var(--text-faint)">这次扫描没有发现结构性问题。可能是项目本身健康，也可能是问题不在代码结构上（比如在部署或流程）。</p>`;

  const optionsHtml = d.options
    .map((o) => {
      const isRec = o.id === d.recommendation.optionId;
      const isChosen = o.id === run.selectedOptionId;
      return `<div class="opt-card${isRec ? ' rec' : ''}${isChosen ? ' chosen' : ''}">
        <div class="opt-head">
          <span class="opt-id">${escapeHtml(o.id)}</span>
          <span class="opt-name">${escapeHtml(o.name)}</span>
          ${isRec ? '<span class="opt-badge">推荐</span>' : ''}
          ${isChosen ? '<span class="opt-badge chosen">已选</span>' : ''}
        </div>
        <p class="opt-sum">${escapeHtml(o.summary)}</p>
        ${
          o.changes.length
            ? `<div class="opt-sec"><b>改什么</b><ul>${o.changes.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul></div>`
            : ''
        }
        ${
          o.pros.length
            ? `<div class="opt-sec"><b>好处</b><ul>${o.pros.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul></div>`
            : ''
        }
        ${
          o.cons.length
            ? `<div class="opt-sec cons"><b>代价</b><ul>${o.cons.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul></div>`
            : ''
        }
        <div class="opt-meta">
          <span>工作量 ${escapeHtml(o.effort || '未估')}</span>
          <span class="risk-${o.risk}">风险 ${o.risk === 'high' ? '高' : o.risk === 'medium' ? '中' : '低'}</span>
        </div>
        ${
          decided
            ? ''
            : `<button class="btn primary block sm" data-act="choose" data-opt="${escapeHtml(o.id)}">选这个方向</button>`
        }
      </div>`;
    })
    .join('');

  const recHtml =
    !decided && d.recommendation.why
      ? `<div class="rec-note"><b>为什么推荐 ${escapeHtml(d.recommendation.optionId)}</b>${escapeHtml(d.recommendation.why)}</div>`
      : '';

  const openQ = d.openQuestions?.length
    ? `<div class="openq"><b>需要你确认</b><ul>${d.openQuestions.map((q) => `<li>${escapeHtml(q)}</li>`).join('')}</ul></div>`
    : '';

  const p = d.profile || {};
  const stats = p.stats || {};
  const statLine = `${stats.codeFiles || 0} 个源码文件 / ${stats.sourceLines || 0} 行${
    stats.testFiles ? ` · ${stats.testFiles} 个测试文件` : ''
  }${p.cycles?.length ? ` · <span style="color:#f87171">${p.cycles.length} 处循环依赖</span>` : ''}${
    p.godModules?.length ? ` · <span style="color:#fcd34d">${p.godModules.length} 个过大模块</span>` : ''
  }`;

  return `<div class="design-card">
    <div class="design-head">
      <h2>现状诊断</h2>
      <span class="meta">${escapeHtml(d.asIs.style)}${d.model ? ` · ${escapeHtml(d.model)}` : ''}</span>
    </div>
    <div class="design-body">
      <div class="arch-stat">${statLine}</div>
      <p>${escapeHtml(d.summary)}</p>
      ${d.asIs.structure ? `<h3>代码怎么组织的</h3><p>${escapeHtml(d.asIs.structure)}</p>` : ''}
      ${d.asIs.dataFlow ? `<h3>典型请求怎么流转</h3><p>${escapeHtml(d.asIs.dataFlow)}</p>` : ''}
      ${
        d.asIs.strengths?.length
          ? `<h3>值得保留的部分</h3><ul>${d.asIs.strengths.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>`
          : ''
      }
      <h3>发现的问题（${d.issues.length}）</h3>
      ${issuesHtml}
      ${openQ}
      <h3>${decided ? '候选方案' : '选一个方向（选定后它才会写完整架构文档）'}</h3>
      <div class="opt-grid">${optionsHtml}</div>
      ${recHtml}
    </div>
  </div>`;
}

function toolBrief(name, args) {
  if (!args) return '';
  if (name === 'read_file' || name === 'deps_of') return args.path || '';
  if (name === 'search') return args.pattern || '';
  if (name === 'list_files') return args.dir || '';
  if (name === 'write_doc') return args.path || '';
  const s = JSON.stringify(args);
  return s.length > 90 ? `${s.slice(0, 90)}…` : s;
}

function renderArchTrail(run) {
  const running = run.status === 'DESIGNING';
  return `<div class="trail${running ? '' : ' done'}">
    <div class="trail-head">
      <span>${running ? '正在写架构文档' : '写文档过程'}</span>
      <span class="step-counter" id="archStepCounter">${archState.step} / ${archState.maxSteps}</span>
    </div>
    <div class="trail-body" id="archTrailBody"></div>
  </div>`;
}

function archTrailItem(t) {
  if (t.kind === 'sep') return `<div class="tl-item step-sep">第 ${t.step} 步</div>`;
  if (t.kind === 'assistant') {
    return `<div class="tl-item assistant"><span class="tl-icon">▸</span><span class="tl-text">${escapeHtml(t.text)}</span></div>`;
  }
  if (t.kind === 'warn') {
    return `<div class="tl-item assistant"><span class="tl-icon" style="color:var(--amber)">!</span><span class="tl-text" style="color:#fcd34d">${escapeHtml(t.text)}</span></div>`;
  }
  if (t.kind === 'tool') {
    const cn =
      { read_file: '读文件', search: '搜索', list_files: '看目录', deps_of: '查依赖', write_doc: '写文档', finish: '交付' }[t.name] ||
      t.name;
    return `<div class="tl-item tool"><span class="tl-icon">▸</span><span class="tl-text">${escapeHtml(cn)} ${escapeHtml(
      String(toolBrief(t.name, t.args)).slice(0, 120),
    )}</span></div>`;
  }
  return '';
}

function paintArchTrail() {
  const body = $('#archTrailBody');
  if (!body) return;
  const items = [];
  let lastStep = null;
  for (const t of archState.trail) {
    if (t.kind === 'sep') {
      if (t.step !== lastStep) {
        items.push(archTrailItem(t));
        lastStep = t.step;
      }
      continue;
    }
    const html = archTrailItem(t);
    if (html) items.push(html);
    if (t.kind === 'tool' && t.result !== undefined) {
      items.push(
        `<div class="tl-item result ${t.ok === false ? 'bad' : 'ok'}"><span class="tl-icon">${
          t.ok === false ? '✗' : '✓'
        }</span><span class="tl-text">${escapeHtml(String(t.result).slice(0, 220))}</span></div>`,
      );
    }
  }
  body.innerHTML = items.join('');
  const counter = $('#archStepCounter');
  if (counter) counter.textContent = `${archState.step} / ${archState.maxSteps}`;
  if (archState.run?.status === 'DESIGNING') body.scrollTop = body.scrollHeight;
}

/**
 * 去掉模型自己又写一遍的小标题。
 * 区块标题已经由界面给出，正文里再来一句「主要风险与前提：」就是重复。
 */
function stripLeadingTitle(text, title) {
  let s = String(text || '').trim();
  const re = new RegExp(`^\\s*(#{1,6}\\s*)?${title}\\s*[:：]?\\s*\\n?`);
  s = s.replace(re, '').trim();
  return s;
}

function renderArchResult(run) {
  const docs = run.docs || [];
  const docRows = docs.length
    ? `<div class="file-list">${docs
        .map(
          (d) => `<div class="file-row doc-row" data-doc="${escapeHtml(d.path)}">
            <span class="op create">${d.action === 'create' ? '新建' : '更新'}</span>
            <span class="p">${escapeHtml(d.path)}</span>
            <span class="why">${d.lines || 0} 行</span>
          </div>`,
        )
        .join('')}</div>`
    : '<p style="color:var(--text-faint)">没有产出文档</p>';

  const preview = archState.preview
    ? `<div class="doc-preview">
        <div class="doc-preview-head">
          <span>${escapeHtml(archState.preview.path)}</span>
          <button class="btn ghost sm" data-act="closePreview">收起</button>
        </div>
        <div class="doc-preview-body prose">${mdToHtml(archState.preview.content)}</div>
      </div>`
    : '';

  return `<div class="result-card ok">
    <div class="result-head">
      <h2>交付成果</h2>
      <span class="dur">${docs.reduce((n, d) => n + (d.lines || 0), 0)} 行 · 方案 ${escapeHtml(
        run.selectedOptionId || '',
      )}</span>
    </div>
    <div class="result-body">
      <h3>写出的文档（点开可预览）</h3>
      ${docRows}
      ${preview}
      ${run.decisions ? `<h3>定下来的决策</h3><div class="prose">${mdToHtml(stripLeadingTitle(run.decisions, '定下来的决策|关键决策|决策'))}</div>` : ''}
      ${run.risks ? `<h3>主要风险与前提</h3><div class="prose">${mdToHtml(stripLeadingTitle(run.risks, '主要风险与前提|风险与前提|风险'))}</div>` : ''}
      ${
        run.remaining && run.remaining !== '无'
          ? `<h3>还需要你拍板</h3><div class="prose">${mdToHtml(stripLeadingTitle(run.remaining, '还需要你拍板|需要拍板|遗留'))}</div>`
          : ''
      }
    </div>
    <div class="dev-actions">
      <button class="btn ghost" data-act="rollbackArch">回滚这批文档</button>
    </div>
  </div>`;
}

/* ---------------- 文档预览 ---------------- */

async function previewArchDoc(path) {
  const run = archState.run;
  if (!run) return;
  try {
    const doc = await api(`/api/arch/runs/${run.id}/doc?path=${encodeURIComponent(path)}`);
    archState.preview = doc;
    renderArchStage();
    const el = document.querySelector('.doc-preview');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    toast(`打不开：${err.message}`, true);
  }
}

/* ---------------- 事件绑定 ---------------- */

function bindArchEvents() {
  $('#btnArchWs')?.addEventListener('click', openArchPicker);
  $('#btnArchScan')?.addEventListener('click', archScan);
  $('#archGoal')?.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') archScan();
  });

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act], [data-arch], [data-doc]');
    if (!t) return;

    if (t.dataset.arch) return loadArchRun(t.dataset.arch);
    if (t.dataset.doc) return previewArchDoc(t.dataset.doc);

    const act = t.dataset.act;
    if (act === 'choose') return archDesign(t.dataset.opt);
    if (act === 'closePreview') {
      archState.preview = null;
      return renderArchStage();
    }
    if (act === 'rollbackArch') return archRollback();
  });
}

/* ---------------- 启动 ---------------- */

renderArchWs();
bindArchEvents();

// 首页带 #arch/<id> 直接打开对应记录
(async () => {
  const m = location.hash.match(/^#arch\/(.+)$/);
  if (!m) return;
  await loadArchRun(m[1]);
  switchView('arch');
})();
