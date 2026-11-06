/**
 * 开发智能体核心链路自测（不经过 HTTP，直接跑模块）。
 *
 * 用法：node scripts/devtest.mjs "<任务描述>" [工作区]
 *
 * 打印每一次工具调用与结果，最后校验：真的产生了文件、真的跑过命令、命令真的成功。
 */
import path from 'node:path';
import fs from 'node:fs';
import { createRun, startDesign, startExecute, getRun, subscribe } from '../lib/devrun.js';

const task = process.argv[2] || '在工作区里实现一个字符串工具：新建 src/strings.js，导出 slugify(text) 把任意文本转成 URL slug（小写、空格转连字符、去掉非字母数字连字符、连续连字符合并、去首尾连字符）。再新建 test/run.js 用 node:assert 覆盖至少 5 个用例（含中文输入、连续空格、首尾空格、特殊字符），运行 node test/run.js 全部通过。';
const workspace = path.resolve(process.argv[3] || '.scratch/demo-proj');

console.log(`工作区: ${workspace}`);
console.log(`任务: ${task.slice(0, 80)}...\n`);

const run = createRun({ workspace, task });
console.log(`runId: ${run.id}\n`);

const attach = () => {
  subscribe(run.id, (e) => {
    const t = e.type;
    if (t === 'dev:design:start') console.log('── 设计阶段 ──');
    if (t === 'dev:design:done') {
      const d = e.design;
      console.log(`理解: ${d.understanding}`);
      console.log(`方案:`);
      d.approach.forEach((a) => console.log(`  · ${a}`));
      console.log(`文件: ${d.files.map((f) => `${f.path}(${f.action})`).join(', ')}`);
      console.log(`验证: ${d.verify.join(' / ')}`);
      console.log('');
    }
    if (t === 'dev:step') process.stdout.write(`\n[步骤 ${e.step}] `);
    if (t === 'dev:assistant') console.log(`\n💬 ${e.text.replace(/\n/g, ' ').slice(0, 160)}`);
    if (t === 'dev:tool') {
      const a = e.args || {};
      const brief = a.path || a.command || a.pattern || a.dir || '';
      console.log(`  🔧 ${e.name}(${String(brief).slice(0, 90)})`);
    }
    if (t === 'dev:tool:result') {
      console.log(`  ${e.ok ? '✓' : '✗'} ${(e.durationMs / 1000).toFixed(1)}s  ${String(e.preview || '').replace(/\n/g, ' ⏎ ').slice(0, 150)}`);
    }
    if (t === 'dev:warning') console.log(`  ⚠ ${e.message}`);
    if (t === 'dev:error') console.log(`\n❌ ${e.error}`);
  });
};

attach();

const t0 = Date.now();
startDesign(run.id);

// 等设计完成
while (getRun(run.id).status === 'DESIGNING' || getRun(run.id).status === 'CREATED') {
  await new Promise((r) => setTimeout(r, 500));
}
const afterDesign = getRun(run.id);
if (afterDesign.status === 'FAILED') {
  console.error(`\n设计失败: ${afterDesign.error}`);
  process.exit(1);
}
console.log(`\n设计耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，开始执行…\n`);

startExecute(run.id);
while (['RUNNING'].includes(getRun(run.id).status)) {
  await new Promise((r) => setTimeout(r, 800));
}

const done = getRun(run.id);
const total = ((Date.now() - t0) / 1000).toFixed(1);

console.log('\n' + '='.repeat(60));
console.log(`状态: ${done.status} | 总耗时 ${total}s | 步数 ${done.stepsCount || done.step}`);
console.log(`改动文件: ${done.changes.length}`);
done.changes.forEach((c) => console.log(`  ${c.action === 'create' ? '+' : '~'} ${c.path} (${c.bytes}B)`));
console.log(`命令: ${done.commands.length}`);
done.commands.forEach((c) => console.log(`  ${c.ok ? '✓' : '✗'} ${c.command} (exit ${c.exitCode}, ${(c.durationMs / 1000).toFixed(1)}s)`));
if (done.summary) console.log(`\n总结:\n${done.summary}`);
if (done.verification) console.log(`\n验证:\n${done.verification}`);
if (done.remaining) console.log(`\n遗留:\n${done.remaining}`);
if (done.error) console.log(`\n错误: ${done.error}`);

// 硬校验：不只看模型怎么说，看磁盘上到底有什么
const checks = [];
for (const c of done.changes) {
  checks.push([`文件存在 ${c.path}`, fs.existsSync(path.join(workspace, c.path))]);
}
checks.push(['至少跑过一次命令', done.commands.length > 0]);
checks.push(['至少有一次命令成功', done.commands.some((c) => c.ok)]);

console.log('\n--- 硬校验 ---');
let bad = 0;
for (const [name, pass] of checks) {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`);
  if (!pass) bad++;
}
console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`);
process.exit(bad === 0 ? 0 : 1);
