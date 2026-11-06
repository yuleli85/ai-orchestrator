/**
 * 开发智能体 HTTP 全链路测试：建任务 → 出方案 → 执行 → 校验落盘结果。
 *
 * 用真实 SSE 消费事件（不用轮询），所以它也在验证事件流本身没漏。
 */
const BASE = process.env.BASE || 'http://127.0.0.1:5180';
const workspace = process.argv[2];
const task = process.argv[3];

if (!workspace || !task) {
  console.error('用法: node scripts/devhttp.mjs <工作区绝对路径> "<任务描述>"');
  process.exit(2);
}

const post = async (p, body) => {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error);
  return j.data;
};

const t0 = Date.now();
const run = await post('/api/dev/runs', { workspace, task });
console.log(`runId ${run.id} | 工作区 ${run.workspace}\n`);

/** 消费 SSE 直到 isDone(evt) 为真 */
function consume(runId, isDone, onEvent) {
  return new Promise((resolve, reject) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      ctrl.abort();
      reject(new Error('SSE 等待超时'));
    }, 900000);

    (async () => {
      try {
        const res = await fetch(`${BASE}/api/dev/runs/${runId}/events`, { signal: ctrl.signal });
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const line = chunk.split('\n').find((l) => l.startsWith('data:'));
            if (!line) continue;
            let evt;
            try {
              evt = JSON.parse(line.slice(5).trim());
            } catch {
              continue;
            }
            onEvent?.(evt);
            if (isDone(evt)) {
              clearTimeout(timer);
              ctrl.abort();
              resolve(evt);
              return;
            }
          }
        }
        clearTimeout(timer);
        resolve(null);
      } catch (err) {
        if (err.name === 'AbortError') return;
        clearTimeout(timer);
        reject(err);
      }
    })();
  });
}

// ---- 设计 ----
const onDesignEvt = (e) => {
  if (e.type === 'dev:design:done') {
    const d = e.design;
    console.log('── 实施方案 ──');
    console.log('理解：', d.understanding);
    d.approach.forEach((a) => console.log('  ·', a));
    console.log('文件：', d.files.map((f) => `${f.path}(${f.action})`).join(', '));
    console.log('验证：', d.verify.join(' / '));
    console.log('');
  }
  if (e.type === 'dev:error') console.log('❌', e.error);
};

const designStream = consume(run.id, (e) => e.type === 'dev:design:done' || e.type === 'dev:error', onDesignEvt);
await post(`/api/dev/runs/${run.id}/design`);
const dEvt = await designStream;
if (dEvt?.type === 'dev:error') process.exit(1);
console.log(`设计完成 ${((Date.now() - t0) / 1000).toFixed(1)}s，开始执行\n`);

// ---- 执行 ----
const onExecEvt = (e) => {
  if (e.type === 'dev:step') process.stdout.write(`\n[${e.step}] `);
  if (e.type === 'dev:assistant') console.log(`\n💬 ${String(e.text).replace(/\s+/g, ' ').slice(0, 150)}`);
  if (e.type === 'dev:tool') {
    const a = e.args || {};
    console.log(`  🔧 ${e.name}(${String(a.path || a.command || a.pattern || a.dir || '').slice(0, 100)})`);
  }
  if (e.type === 'dev:tool:result') {
    console.log(`  ${e.ok ? '✓' : '✗'} ${(e.durationMs / 1000).toFixed(1)}s ${String(e.preview || '').replace(/\s+/g, ' ').slice(0, 120)}`);
  }
  if (e.type === 'dev:warning') console.log(`  ⚠ ${e.message}`);
  if (e.type === 'dev:error') console.log(`\n❌ ${e.error}`);
};

const TERMINAL = ['DONE', 'FAILED', 'CANCELLED'];
const execStream = consume(run.id, (e) => e.type === 'dev:status' && TERMINAL.includes(e.status), onExecEvt);
await post(`/api/dev/runs/${run.id}/execute`);
const sEvt = await execStream;
console.log(`\n\n状态: ${sEvt?.status}`);

const final = (await (await fetch(`${BASE}/api/dev/runs/${run.id}`)).json()).data;
const total = ((Date.now() - t0) / 1000).toFixed(1);

console.log('='.repeat(60));
console.log(`总耗时 ${total}s | 步数 ${final.stepsCount || final.step} | 改动 ${final.changes.length} 文件 | 命令 ${final.commands.length} 条`);
final.changes.forEach((c) => console.log(`  ${c.action === 'create' ? '+' : '~'} ${c.path} ${c.bytes}B`));
final.commands.forEach((c) => console.log(`  ${c.ok ? '✓' : '✗'} ${c.command} exit=${c.exitCode} ${(c.durationMs / 1000).toFixed(1)}s`));
console.log('\n总结:\n' + (final.summary || '-'));
console.log('\n验证:\n' + (final.verification || '-'));
if (final.remaining) console.log('\n遗留:\n' + final.remaining);
if (final.error) console.log('\n错误: ' + final.error);

const bad = [];
if (final.status !== 'DONE') bad.push(`状态是 ${final.status}`);
if (!final.changes.length) bad.push('没有产生文件改动');
if (!final.commands.some((c) => c.ok)) bad.push('没有成功的验证命令');

console.log('\n--- 硬校验 ---');
if (bad.length) {
  bad.forEach((b) => console.log('  FAIL ' + b));
  process.exit(1);
}
console.log('  PASS 状态 DONE / 有文件改动 / 有成功命令');
process.exit(0);
