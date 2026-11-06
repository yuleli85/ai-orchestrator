import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';

/**
 * 架构智能体的两条硬边界，用可执行断言验证：
 * 1. 只能写 docs/ 下的 .md —— 它不该有能力改业务代码
 * 2. 回滚能真的还原/删除写过的文档
 *
 * 不调模型、不联网，秒级跑完。
 */

let pass = 0;
let fail = 0;
const failures = [];

function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    fail++;
    failures.push({ name, msg: err.message });
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${err.message.split('\n')[0]}`);
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'archguard-'));
// 必须在使用 config 前设置：archrun 在模块加载时就固化了数据目录
process.env.ORCH_DATA_DIR = path.join(TMP, 'data');

// 预埋一条"上次进程被杀时正在跑"的记录：重启后它必须被收尾，
// 否则列表里永远是"进行中"，用户点了也没反应。
const SEEDED_ID = 'arch_orphan_seed';
fs.mkdirSync(path.join(TMP, 'data'), { recursive: true });
fs.writeFileSync(
  path.join(TMP, 'data', 'arch.json'),
  JSON.stringify({
    version: 1,
    runs: [
      { id: SEEDED_ID, workspace: TMP, goal: '预埋的中断任务', status: 'DESIGNING', docs: [], trace: [] },
      { id: 'arch_orphan_scanning', workspace: TMP, goal: '预埋的扫描中断任务', status: 'SCANNING', docs: [] },
      { id: 'arch_keep_done', workspace: TMP, goal: '预埋的已完成任务', status: 'DONE', docs: [] },
    ],
  }),
  'utf8',
);

const { docPathCheck, overwriteVerdict } = await import('../lib/archagent.js');
const { createRun, getRun, rollback } = await import('../lib/archrun.js');

console.log('\n重启后的状态收尾');

t('上次被杀掉的设计任务标记为已中断', () => {
  const r = getRun(SEEDED_ID);
  assert.equal(r.status, 'INTERRUPTED');
  assert.match(r.error, /重启/);
  assert.ok(r.finishedAt > 0, '必须补上结束时间，否则列表排序会乱');
});

t('上次被杀掉的扫描任务同样收尾', () => {
  assert.equal(getRun('arch_orphan_scanning').status, 'INTERRUPTED');
});

t('已完成的任务不受影响', () => {
  assert.equal(getRun('arch_keep_done').status, 'DONE');
});

// persist() 走的是微任务队列，同步断言会读到旧文件，得先让出一拍
await new Promise((r) => setTimeout(r, 30));

t('收尾结果写回磁盘', () => {
  const onDisk = JSON.parse(fs.readFileSync(path.join(TMP, 'data', 'arch.json'), 'utf8'));
  assert.equal(onDisk.runs.find((x) => x.id === SEEDED_ID).status, 'INTERRUPTED');
});

console.log('\n文档写入边界');

t('允许写 docs/ 下的 md', () => {
  assert.equal(docPathCheck('docs/architecture/README.md'), 'docs/architecture/README.md');
  assert.equal(docPathCheck('docs/a.md'), 'docs/a.md');
});

t('规范化 Windows 分隔符', () => {
  assert.equal(docPathCheck('docs\\architecture\\x.md'), 'docs/architecture/x.md');
});

t('拒绝写到 docs 之外', () => {
  assert.throws(() => docPathCheck('src/server.js'), /只能写到 docs/);
  assert.throws(() => docPathCheck('server.js'), /只能写到 docs/);
  assert.throws(() => docPathCheck('lib/http/sse.js'), /只能写到 docs/);
});

t('拒绝非 md 文件', () => {
  assert.throws(() => docPathCheck('docs/x.js'), /只能是 \.md/);
  assert.throws(() => docPathCheck('docs/x.html'), /只能是 \.md/);
});

t('拒绝路径穿越', () => {
  assert.throws(() => docPathCheck('docs/../../etc/passwd.md'), /不能包含/);
  assert.throws(() => docPathCheck('docs/../server.js'), /不能包含/);
});

t('拒绝空路径', () => {
  assert.throws(() => docPathCheck(''), /不能为空/);
});

console.log('\n历史文档覆盖防护');

t('本轮自己写过的文档允许改写（修订）', () => {
  const proj = makeProject();
  const rel = 'docs/architecture/architecture.md';
  fs.writeFileSync(path.join(proj, rel), '# 第一版', 'utf8');
  const docs = [{ path: rel, action: 'create' }];
  assert.equal(overwriteVerdict({ workspace: proj, rel, docs }), null);
});

t('不存在的文件直接放行', () => {
  const proj = makeProject();
  const rel = 'docs/architecture/ADR-007-new.md';
  assert.equal(overwriteVerdict({ workspace: proj, rel, docs: [] }), null);
});

t('别的运行留下的同名文件会被拒绝', () => {
  const proj = makeProject();
  const rel = 'docs/architecture/ADR-001-http-routers-by-domain.md';
  fs.writeFileSync(path.join(proj, rel), '# 上一轮的决策', 'utf8');

  const deny = overwriteVerdict({ workspace: proj, rel, docs: [] });
  assert.ok(deny, '必须给出拒绝原因');
  assert.match(deny, /已经存在/);
  assert.match(deny, /overwrite/);
});

t('显式 overwrite 才允许取代历史文档', () => {
  const proj = makeProject();
  const rel = 'docs/architecture/README.md';
  fs.writeFileSync(path.join(proj, rel), '# 上一轮的索引', 'utf8');
  assert.equal(overwriteVerdict({ workspace: proj, rel, docs: [], overwrite: true }), null);
  // 只认真布尔 true，不认字符串 "true"——JSON 参数传错类型时不能悄悄放行
  assert.ok(overwriteVerdict({ workspace: proj, rel, docs: [], overwrite: 'true' }));
});

console.log('\n回滚');

function makeProject() {
  const dir = fs.mkdtempSync(path.join(TMP, 'proj-'));
  fs.mkdirSync(path.join(dir, 'docs/architecture'), { recursive: true });
  return dir;
}

t('回滚会删掉本次新建的文档', () => {
  const proj = makeProject();
  const file = path.join(proj, 'docs/architecture/README.md');
  fs.writeFileSync(file, '# 新建的文档', 'utf8');

  const run = createRun({ workspace: proj, goal: '测试回滚：删除新建文档' });
  run.docs = [{ path: 'docs/architecture/README.md', action: 'create', bytes: 20, lines: 1 }];

  const r = rollback(run.id);
  assert.deepEqual(r.removed, ['docs/architecture/README.md']);
  assert.equal(fs.existsSync(file), false, '文件应已删除');
  assert.equal(fs.existsSync(path.join(proj, 'docs/architecture')), true, '空目录保留即可');
});

t('回滚会把覆盖过的文档恢复成原文', () => {
  const proj = makeProject();
  const rel = 'docs/architecture/architecture.md';
  const file = path.join(proj, rel);
  fs.writeFileSync(file, '# 原始内容', 'utf8');

  const run = createRun({ workspace: proj, goal: '测试回滚：恢复被覆盖文档' });
  run.docs = [{ path: rel, action: 'modify', bytes: 10, lines: 1 }];

  // 模拟执行阶段：先备份到 run 目录，再覆盖
  const backup = path.join(TMP, 'data', 'arch-runs', run.id, 'backup', rel);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.writeFileSync(backup, '# 原始内容', 'utf8');
  fs.writeFileSync(file, '# 被智能体改过的内容', 'utf8');

  const r = rollback(run.id);
  assert.deepEqual(r.restored, [rel]);
  assert.equal(fs.readFileSync(file, 'utf8'), '# 原始内容');
});

t('回滚后状态标记为 ROLLED_BACK', () => {
  const proj = makeProject();
  fs.writeFileSync(path.join(proj, 'docs/architecture/x.md'), '# x', 'utf8');
  const run = createRun({ workspace: proj, goal: '测试回滚状态标记' });
  run.docs = [{ path: 'docs/architecture/x.md', action: 'create' }];

  rollback(run.id);
  assert.equal(getRun(run.id).status, 'ROLLED_BACK');
});

t('没有产出文档时回滚给出明确错误', () => {
  const proj = makeProject();
  const run = createRun({ workspace: proj, goal: '测试没有产出文档时回滚的表现' });
  assert.throws(() => rollback(run.id), /没有可回滚/);
});

t('越界路径不会删掉工作区外的文件', () => {
  const proj = makeProject();
  const outside = path.join(TMP, 'outside-secret.txt');
  fs.writeFileSync(outside, 'keep me', 'utf8');

  const run = createRun({ workspace: proj, goal: '测试越界路径的防护' });
  // 手工伪造一条越界记录（正常流程写不进这种路径，这里是防御性测试）
  run.docs = [{ path: '../../outside-secret.txt', action: 'create' }];

  const r = rollback(run.id);
  assert.equal(fs.existsSync(outside), true, '工作区外的文件必须还在');
  assert.equal(r.failed.length, 1, '应记为失败而不是静默跳过');
});

// 「运行中禁止回滚」这条依赖内部 live 状态，无法从模块外构造，
// 与其写一条永远通过的假断言，不如不写——那种测试只会让人误以为有覆盖。

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`- ${f.name}\n  ${f.msg}`);
}

try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
  /* ignore */
}

process.exit(fail ? 1 : 0);
