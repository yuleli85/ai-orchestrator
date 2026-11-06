/**
 * 架构智能体 HTTP 全链路测试：建任务 → 诊断 → 选方向 → 写文档 → 校验落盘。
 *
 * 用真实 SSE 消费事件，顺带验证事件流本身没漏。
 * 默认只跑到「诊断」就停（快，约 2 分钟），加 --full 才跑完写文档阶段（约 5 分钟）。
 *
 * 用法：
 *   node scripts/archhttp.mjs <工作区绝对路径> "<要解决的架构问题>"
 *   node scripts/archhttp.mjs <工作区绝对路径> "<问题>" --full
 */

const BASE = process.env.BASE || 'http://127.0.0.1:5180';
const workspace = process.argv[2];
const goal = process.argv[3];
const FULL = process.argv.includes('--full');

if (!workspace || !goal) {
  console.error('用法: node scripts/archhttp.mjs <工作区绝对路径> "<架构问题>" [--full]');
  process.exit(2);
}

const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(0) + 's';

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

const get = async (p) => {
  const r = await fetch(BASE + p);
  const j = await r.json();
  if (!j.ok) throw new Error(j.error);
  return j.data;
};

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
        const res = await fetch(`${BASE}/api/arch/runs/${runId}/events`, { signal: ctrl.signal });
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
        clearTimeout(timer);
        if (err.name === 'AbortError') return resolve(null);
        reject(err);
      }
    })();
  });
}

let ok = 0;
let bad = 0;
function check(name, cond, detail = '') {
  if (cond) {
    ok++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    bad++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/* ---------------- 1. 建任务 ---------------- */

console.log(`\n[1] 建任务  ${el()}`);
const run = await post('/api/arch/runs', { workspace, goal });
check('创建成功', Boolean(run.id), run.id);
check('工作区已解析为绝对路径', /^[A-Za-z]:[\\/]|^\//.test(run.workspace), run.workspace);

/* ---------------- 2. 诊断 ---------------- */

console.log(`\n[2] 扫描诊断（只读，不改任何文件）  ${el()}`);
let sawScanDone = false;
const diagStream = consume(run.id, (e) => e.type === 'arch:diagnose:done' || e.type === 'arch:error', (e) => {
  if (e.type === 'arch:scan:done') {
    sawScanDone = true;
    const s = e.profile?.stats || {};
    console.log(`     扫描：${s.codeFiles} 个源码 / ${s.sourceLines} 行，模块 ${e.profile?.modules?.length || 0} 个`);
  }
  if (e.type === 'arch:error') console.log(`     \x1b[31m错误：${e.error}\x1b[0m`);
});
await post(`/api/arch/runs/${run.id}/diagnose`);
await diagStream;

const afterDiag = await get(`/api/arch/runs/${run.id}`);
const d = afterDiag.diagnosis;
check('扫描事件已推送', sawScanDone);
check('状态进入 DIAGNOSED（停下来等人选方向）', afterDiag.status === 'DIAGNOSED', afterDiag.status);
check('产出了问题清单', d?.issues?.length > 0, `${d?.issues?.length || 0} 条`);
check('产出了候选方案', d?.options?.length >= 2, `${d?.options?.length || 0} 个`);
check('推荐了其中一个方案', d?.options?.some((o) => o.id === d.recommendation?.optionId), d?.recommendation?.optionId);
check('每条问题都有证据', (d?.issues || []).every((i) => i.evidence && i.evidence.length > 4));
check('每个方案都写了代价', (d?.options || []).every((o) => o.cons?.length > 0));

console.log('\n     问题：');
for (const i of d?.issues || []) console.log(`       [${i.severity}] ${i.title}`);
console.log('     方案：');
for (const o of d?.options || []) console.log(`       ${o.id} ${o.name}（风险 ${o.risk}，${o.effort}）`);

if (!FULL) {
  console.log(`\n结果：${ok} 通过 / ${bad} 失败（未跑写文档阶段，加 --full 跑完整链路）`);
  console.log(`打开：${BASE}/#arch/${run.id}`);
  process.exit(bad ? 1 : 0);
}

/* ---------------- 3. 选方向并写文档 ---------------- */

const chosen = d.recommendation.optionId;
console.log(`\n[3] 选方案 ${chosen}，写架构文档  ${el()}`);

let docEvents = 0;
const designStream = consume(
  run.id,
  (e) => (e.type === 'arch:status' && ['DONE', 'FAILED', 'CANCELLED'].includes(e.status)) || e.type === 'arch:error',
  (e) => {
    if (e.type === 'arch:doc') {
      docEvents++;
      console.log(`     ${e.action === 'create' ? '新建' : '更新'} ${e.path}（${e.lines} 行）`);
    }
    if (e.type === 'arch:warning') console.log(`     \x1b[33m提醒：${e.message}\x1b[0m`);
    if (e.type === 'arch:error') console.log(`     \x1b[31m错误：${e.error}\x1b[0m`);
  },
);
await post(`/api/arch/runs/${run.id}/design`, { optionId: chosen });
await designStream;

const done = await get(`/api/arch/runs/${run.id}`);
console.log(`\n[4] 验收  ${el()}`);
check('状态为 DONE', done.status === 'DONE', done.status);
check('至少写了 2 份文档', (done.docs || []).length >= 2, `${(done.docs || []).length} 份`);
check('文档都落在 docs/ 下且是 md', (done.docs || []).every((x) => /^docs\//.test(x.path) && /\.md$/.test(x.path)));
check('文档总行数合理（>80）', (done.docs || []).reduce((n, x) => n + (x.lines || 0), 0) > 80);
check('给出了决策结论', Boolean(done.decisions && done.decisions.length > 20));
check('说明了风险', Boolean(done.risks && done.risks.length > 10));

// 文档预览接口：能读回本次产出的文档
const first = done.docs?.[0];
if (first) {
  const doc = await get(`/api/arch/runs/${run.id}/doc?path=${encodeURIComponent(first.path)}`);
  check('文档内容可读回', doc.content.length > 100, `${doc.content.length} 字符`);
}

// 越权读取必须被拒
try {
  await get(`/api/arch/runs/${run.id}/doc?path=${encodeURIComponent('package.json')}`);
  check('越权读取被拒绝', false, '竟然读到了 package.json');
} catch {
  check('越权读取被拒绝', true);
}

console.log('\n     产出：');
for (const x of done.docs || []) console.log(`       ${x.path}（${x.lines} 行）`);

console.log(`\n结果：${ok} 通过 / ${bad} 失败`);
console.log(`打开：${BASE}/#arch/${run.id}`);
process.exit(bad ? 1 : 0);
