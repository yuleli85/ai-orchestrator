import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { profile, depsOf } from '../lib/archprofiler.js';

/**
 * 画像扫描器的行为测试。全部用临时目录构造场景，不调模型、不烧 token。
 *
 * 重点验证的是"能不能抓到真问题"，而不是"会不会崩"：
 * 循环依赖、分层违规、测试代码污染、备份目录污染，这四类错一个，
 * 上层诊断就会给出看起来很有道理但完全错误的结论。
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'archprof-'));

function mk(files) {
  const dir = fs.mkdtempSync(path.join(TMP, 'p-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return dir;
}

function modNames(p) {
  return p.modules.map((m) => m.name).sort();
}

console.log('\n画像扫描器');

/* ---------- 循环依赖 ---------- */

t('能检出两个模块互相依赖', () => {
  const d = mk({
    'src/a/index.js': "require('../b/index.js');",
    'src/b/index.js': "require('../a/index.js');",
  });
  const p = profile(d);
  assert.equal(p.cycles.length, 1, `期望 1 个环，实际 ${p.cycles.length}`);
  const cyc = p.cycles[0];
  assert.ok(cyc.includes('a') && cyc.includes('b'), `环里应含 a 和 b，实际 ${JSON.stringify(cyc)}`);
});

t('能检出三个模块的环', () => {
  const d = mk({
    'src/a/x.js': "import '../b/x.js';",
    'src/b/x.js': "import '../c/x.js';",
    'src/c/x.js': "import '../a/x.js';",
  });
  const p = profile(d);
  assert.equal(p.cycles.length, 1);
  const names = new Set(p.cycles[0]);
  assert.ok(names.has('a') && names.has('b') && names.has('c'));
});

t('无环时不误报', () => {
  const d = mk({
    'src/a/x.js': "import '../b/x.js';",
    'src/b/x.js': "import '../c/x.js';",
    'src/c/x.js': 'export const c = 1;',
  });
  const p = profile(d);
  assert.equal(p.cycles.length, 0, `不该有环，实际 ${JSON.stringify(p.cycles)}`);
});

/* ---------- 分层违规 ---------- */

t('能检出领域层反向依赖基础设施层', () => {
  const d = mk({
    'src/domain/order.js': "import { db } from '../infra/db.js';",
    'src/infra/db.js': 'export const db = {};',
  });
  const p = profile(d);
  const v = p.violations.find((x) => x.fromLayer === 'domain' && x.toLayer === 'infrastructure');
  assert.ok(v, `应检出 domain→infrastructure，实际 ${JSON.stringify(p.violations)}`);
  assert.ok(v.samples[0].includes('order.js'));
});

t('应用层依赖基础设施层不报违规', () => {
  const d = mk({
    'src/service/order-service.js': "import { db } from '../repository/db.js';",
    'src/repository/db.js': 'export const db = {};',
  });
  const p = profile(d);
  const v = p.violations.find((x) => x.fromLayer === 'application');
  assert.equal(v, undefined, `不该报违规，实际 ${JSON.stringify(v)}`);
});

t('公共层被任意层依赖不报违规', () => {
  const d = mk({
    'src/domain/order.js': "import { u } from '../common/util.js';",
    'src/common/util.js': 'export const u = 1;',
  });
  const p = profile(d);
  assert.equal(p.violations.length, 0, `不该报违规，实际 ${JSON.stringify(p.violations)}`);
});

/* ---------- 污染排除 ---------- */

t('测试代码不计入源码与依赖分析', () => {
  const d = mk({
    'src/core/calc.js': 'export const add = (a,b)=>a+b;',
    'test/calc.test.js': "import '../src/core/calc.js';",
    'src/core/calcTest.java': 'class CalcTest {}',
  });
  const p = profile(d);
  assert.equal(p.stats.codeFiles, 1, `源码应只剩 1 个，实际 ${p.stats.codeFiles}`);
  assert.ok(p.stats.testFiles >= 1, '应识别出测试文件');
});

t('备份目录不会被当成源码扫进去', () => {
  const d = mk({
    'src/a/x.js': 'export const a = 1;',
    'data/dev-runs/run1/backup/src/a/x.js': "require('../b/x.js');",
    'data/dev-runs/run1/backup/src/b/x.js': "require('../a/x.js');",
  });
  const p = profile(d);
  assert.equal(p.stats.codeFiles, 1, `源码应只剩 1 个，实际 ${p.stats.codeFiles}`);
  assert.equal(p.cycles.length, 0, '备份里的假环不该被检出');
});

/* ---------- 解析正确性 ---------- */

t('JS 能解析到目录下的 index.js', () => {
  const d = mk({
    'src/a/index.js': 'export const a = 1;',
    'src/b/main.js': "require('../a');",
  });
  const p = profile(d);
  const b = p.modules.find((m) => m.name === 'b');
  assert.deepEqual(b.outbound, ['a'], `b 应依赖 a，实际 ${JSON.stringify(b.outbound)}`);
});

t('JS 能解析 .js 后缀指向 .ts 文件（TS ESM 常见写法）', () => {
  const d = mk({
    'src/a/util.ts': 'export const u = 1;',
    'src/b/main.ts': "import { u } from '../a/util.js';",
  });
  const p = profile(d);
  const b = p.modules.find((m) => m.name === 'b');
  assert.deepEqual(b.outbound, ['a']);
});

t('Java 能按包名解析到源文件', () => {
  const d = mk({
    'src/main/java/com/x/order/OrderService.java': 'package com.x.order;\nimport com.x.pay.PayService;\npublic class OrderService {}',
    'src/main/java/com/x/pay/PayService.java': 'package com.x.pay;\npublic class PayService {}',
  });
  const p = profile(d);
  assert.deepEqual(modNames(p), ['order', 'pay'], `模块应为 order/pay，实际 ${JSON.stringify(modNames(p))}`);
  const o = p.modules.find((m) => m.name === 'order');
  assert.deepEqual(o.outbound, ['pay']);
});

t('Python 能解析包路径', () => {
  const d = mk({
    'app/order/service.py': 'from app.pay.client import PayClient\n',
    'app/pay/client.py': 'class PayClient: pass\n',
  });
  const p = profile(d);
  const o = p.modules.find((m) => m.name === 'order');
  assert.deepEqual(o.outbound, ['pay'], `实际 ${JSON.stringify(o.outbound)}`);
});

/* ---------- 模块边界推断 ---------- */

t('平铺的 lib 目录不会被当成源根', () => {
  const d = mk({
    'lib/a.js': 'export const a = 1;',
    'lib/b.js': 'export const b = 1;',
    'public/app.js': 'console.log(1);',
    'server.js': "import './lib/a.js';",
  });
  const p = profile(d);
  assert.equal(p.sourceRoot, '', `源根应为空，实际 "${p.sourceRoot}"`);
  assert.ok(modNames(p).includes('lib'), `模块应含 lib，实际 ${JSON.stringify(modNames(p))}`);
});

t('平铺的 lib 不会被误报为上帝模块', () => {
  const files = {};
  for (let i = 0; i < 12; i++) files[`lib/m${i}.js`] = 'export const x = 1;';
  files['server.js'] = "import './lib/m0.js';";
  const p = profile(mk(files));
  const lib = p.godModules.find((g) => g.name === 'lib');
  assert.equal(lib, undefined, `lib 不该算上帝模块，实际 ${JSON.stringify(p.godModules)}`);
});

t('真正过大的业务模块会被识别为上帝模块', () => {
  const files = {};
  for (let i = 0; i < 10; i++) files[`src/huge/m${i}.js`] = 'export const x = 1;';
  for (let i = 0; i < 2; i++) files[`src/tiny/m${i}.js`] = 'export const x = 1;';
  const p = profile(mk(files));
  const huge = p.godModules.find((g) => g.name === 'huge');
  assert.ok(huge, `huge 应被识别为上帝模块，实际 ${JSON.stringify(p.godModules)}`);
  assert.ok(huge.share > 0.8);
});

/* ---------- depsOf ---------- */

t('depsOf 返回模块上下游', () => {
  const d = mk({
    'src/a/x.js': "import '../b/x.js';",
    'src/b/x.js': 'export const b = 1;',
    'src/c/x.js': "import '../a/x.js';",
  });
  const p = profile(d);
  const r = depsOf(d, 'src/a/x.js', { profiled: p });
  assert.equal(r.module, 'a');
  assert.deepEqual(r.outbound, ['b']);
  assert.deepEqual(r.inbound, ['c']);
});

t('depsOf 拒绝路径穿越', () => {
  const d = mk({ 'src/a/x.js': '' });
  const p = profile(d);
  assert.throws(() => depsOf(d, '../../../etc/passwd', { profiled: p }), /找不到|不存在/);
});

/* ---------- 文本输出 ---------- */

t('画像文本包含关键小节', () => {
  const d = mk({
    'src/a/x.js': "import '../b/x.js';",
    'src/b/x.js': "import '../a/x.js';",
    'package.json': '{"name":"t"}',
  });
  const p = profile(d);
  for (const key of ['【项目】', '【规模】', '【模块', '循环依赖']) {
    assert.ok(p.text.includes(key), `文本缺少 ${key}`);
  }
});

t('空目录不会崩，且报告 0 代码文件', () => {
  const d = mk({ 'README.md': '# empty' });
  const p = profile(d);
  assert.equal(p.stats.codeFiles, 0);
});

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
