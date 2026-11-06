/**
 * 端到端自测：真实调用模型，跑完「拆解 → 执行 → 汇总」全流程。
 *
 *   node scripts/e2e.mjs
 *   node scripts/e2e.mjs "你自己的任务描述"
 *
 * 不做断言框架，只把关键事实打出来——这类工具看的是"拆得对不对、跑得快不快"，
 * 断言反而会把注意力从产出质量上挪开。
 */

const BASE = process.env.ORCH_BASE || 'http://127.0.0.1:5180';

const goal =
  process.argv[2] ||
  '帮我策划一个 15 秒的投资类短视频，讲 Python 全栈技术路线图：要能直接开拍的脚本、口播文案、画面提示，以及前 3 秒的钩子设计。';

const ts = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const log = (...a) => console.log(`[${ts()}]`, ...a);

async function j(path, opts = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) throw new Error(json.error || `HTTP ${res.status}`);
  return json.data;
}

function layersOf(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const lv = new Map();
  const calc = (id, g = new Set()) => {
    if (lv.has(id)) return lv.get(id);
    if (g.has(id)) return 0;
    g.add(id);
    const deps = (byId.get(id)?.dependsOn || []).filter((d) => byId.has(d));
    const v = deps.length ? Math.max(...deps.map((d) => calc(d, g))) + 1 : 0;
    g.delete(id);
    lv.set(id, v);
    return v;
  };
  for (const t of tasks) calc(t.id);
  const buckets = new Map();
  for (const t of tasks) {
    const l = lv.get(t.id) || 0;
    if (!buckets.has(l)) buckets.set(l, []);
    buckets.get(l).push(t);
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
}

const t0 = Date.now();

// ---------- 1. 规划 ----------
log('提交任务：', goal.slice(0, 40) + (goal.length > 40 ? '…' : ''));
const job = await j('/api/jobs', { method: 'POST', body: { goal } });
const planMs = Date.now() - t0;

log(`规划完成，耗时 ${(planMs / 1000).toFixed(1)}s | 模型 ${job.planMeta?.model}`);
console.log(`\n  理解：${job.plan.understanding}`);
if (job.plan.assumptions?.length) console.log(`  假设：${job.plan.assumptions.join(' / ')}`);

const layers = layersOf(job.plan.tasks);
console.log(`\n  分工（${job.plan.tasks.length} 个任务 / ${layers.length} 波）：`);
layers.forEach((list, i) => {
  console.log(`  L${i + 1}${list.length > 1 ? `（${list.length} 个并行）` : ''}`);
  for (const t of list) {
    console.log(`     ${t.id} [${t.roleId}] ${t.title}  ← ${t.dependsOn.join(',') || '无依赖'}`);
  }
});

// ---------- 2. 执行 ----------
console.log('');
log('开始执行…');
await j(`/api/jobs/${job.id}/execute`, { method: 'POST' });

const started = Date.now();
const res = await fetch(`${BASE}/api/jobs/${job.id}/events`);
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buf = '';
const timeline = [];
let finished = false;

while (!finished) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });

  let idx;
  while ((idx = buf.indexOf('\n\n')) >= 0) {
    const chunk = buf.slice(0, idx);
    buf = buf.slice(idx + 2);
    const line = chunk.split('\n').find((l) => l.startsWith('data:'));
    if (!line) continue;

    let evt;
    try {
      evt = JSON.parse(line.slice(5).trim());
    } catch {
      continue;
    }

    const t = ((Date.now() - started) / 1000).toFixed(1);

    if (evt.type === 'layer:start') {
      log(`L${evt.level + 1} 开始，${evt.taskIds.length} 个同时跑`);
    }
    if (evt.type === 'task:start') {
      timeline.push({ id: evt.taskId, start: Date.now() });
      log(`  → ${evt.taskId} 开工 [${evt.roleName}] ${evt.model}`);
    }
    if (evt.type === 'task:retry') {
      log(`  ! ${evt.taskId} 第 ${evt.attempt} 次失败重试：${evt.error}`);
    }
    if (evt.type === 'task:done') {
      const rec = timeline.find((x) => x.id === evt.taskId);
      if (rec) rec.end = Date.now();
      log(`  ✓ ${evt.taskId} 交付 ${evt.chars} 字，用时 ${(evt.durationMs / 1000).toFixed(1)}s`);
    }
    if (evt.type === 'task:error') {
      log(`  ✗ ${evt.taskId} 失败：${evt.error}`);
    }
    if (evt.type === 'summary:start') log('所有子任务结束，总控开始合并…');
    if (evt.type === 'summary:done') log(`汇总完成，${evt.content.length} 字`);
    if (evt.type === 'job:done') {
      log(`执行结束，最终状态 ${evt.status}，总耗时 ${t}s`);
      finished = true;
    }
  }
}

// ---------- 3. 结果核对 ----------
const final = await j(`/api/jobs/${job.id}`);
const doneRuns = final.runs.filter((r) => r.status === 'DONE');

console.log('\n──────── 结果 ────────');
console.log(`状态        ${final.status}`);
console.log(`任务完成    ${doneRuns.length} / ${final.runs.length}`);
console.log(`规划耗时    ${(planMs / 1000).toFixed(1)}s`);
console.log(`执行耗时    ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`汇总字数    ${final.summary?.content?.length || 0}`);

// 并行度：直接用服务端记录的开始/结束时间算重叠，不依赖 SSE 事件（订阅有几百毫秒延迟）
let overlapped = 0;
for (const l of layers) {
  if (l.length < 2) continue;
  const recs = l
    .map((t) => final.runs.find((r) => r.taskId === t.id))
    .filter((r) => r?.startedAt && r?.finishedAt);
  for (let i = 0; i < recs.length; i++) {
    for (let k = i + 1; k < recs.length; k++) {
      if (recs[i].startedAt < recs[k].finishedAt && recs[k].startedAt < recs[i].finishedAt) overlapped++;
    }
  }
}
console.log(`并行验证    ${overlapped > 0 ? `有 ${overlapped} 对任务时间重叠，确实并行` : '未检测到重叠（可能都是串行任务）'}`);

const md = await fetch(`${BASE}/api/jobs/${job.id}/export`).then((r) => r.text());
console.log(`\n导出预览（前 400 字）：\n${md.slice(0, 400)}\n…`);
console.log(`\n任务 ID: ${job.id}  可用 GET /api/jobs/${job.id}/export 下载完整 Markdown`);
