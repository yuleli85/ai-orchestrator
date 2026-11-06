/**
 * 沙箱安全边界自测。
 *
 * 这个文件的存在意义：让"它不会乱删文件"这句话变成可验证的事实，而不是承诺。
 * 每次改 sandbox.js 都跑一遍：node scripts/sandbox.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkCommand, editFile, readFile, resolveSafe, runCommand, writeFile } from '../lib/sandbox.js';

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    fail++;
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

function checkAsync(name, fn) {
  return fn().then(
    () => {
      pass++;
      console.log(`  PASS  ${name}`);
    },
    (err) => {
      fail++;
      console.log(`  FAIL  ${name}\n        ${err.message}`);
    },
  );
}

console.log('--- 命令白名单 ---');
const allowed = [
  'node test/run.js',
  'npm test',
  'npm run build',
  'mvn -q -DskipTests package',
  'git status --short',
  'git diff --stat',
  'cd src && node index.js',
  'ls -la',
  'mkdir -p build',
];
for (const c of allowed) {
  check(`允许: ${c}`, () => assert.equal(checkCommand(c).ok, true, `应允许，却被拒：${checkCommand(c).reason}`));
}

const denied = [
  ['rm -rf node_modules', '递归删除'],
  ['rm -r src', '递归删除'],
  ['del /s /q src', '递归删除'],
  ['format c:', '格式化'],
  ['git push origin main', '推送'],
  ['git reset --hard HEAD', '硬重置'],
  ['git clean -fd', '清理'],
  ['curl https://example.com', '外网请求'],
  ['wget http://x/y', '外网请求'],
  ['cat ../../etc/passwd', '路径越界'],
  ['sed -i s/a/b/ ../conf.txt', '路径越界'],
  ['cp a.txt C:\\Windows\\x.txt', '盘符绝对路径'],
  ['shutdown -h now', '关机'],
  ['taskkill /f /im node.exe', '杀进程'],
  ['sudo rm x', '提权'],
  ['evilcmd --do-thing', '不在白名单'],
];
for (const [c, why] of denied) {
  check(`拒绝(${why}): ${c}`, () => assert.equal(checkCommand(c).ok, false, `应该拒绝，却放行了：${c}`));
}

// 用临时目录做真实文件操作测试
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-test-'));
fs.mkdirSync(path.join(root, 'src'), { recursive: true });
fs.writeFileSync(path.join(root, 'src', 'a.js'), 'const x = 1;\n', 'utf8');
fs.writeFileSync(path.join(root, '.env'), 'SECRET=1\n', 'utf8');
const backupDir = path.join(root, '.backup');

console.log('\n--- 路径边界 ---');
check('允许工作区内相对路径', () => assert.ok(resolveSafe(root, 'src/a.js').endsWith('a.js')));
check('拒绝上级目录', () => assert.throws(() => resolveSafe(root, '../outside.txt'), /逃出工作区/));
check('拒绝绝对路径', () => assert.throws(() => resolveSafe(root, 'C:\\Windows\\win.ini'), /绝对路径|只接受/));
check('拒绝深层穿越', () => assert.throws(() => resolveSafe(root, 'src/../../x'), /逃出工作区/));

console.log('\n--- 写保护 ---');
check('拒绝写 .env', () => assert.throws(() => writeFile(root, '.env', 'HACKED'), /敏感文件/));
check('拒绝写 node_modules', () =>
  assert.throws(() => writeFile(root, 'node_modules/x/index.js', 'x'), /目录/));
check('拒绝写 .git', () => assert.throws(() => writeFile(root, '.git/config', 'x'), /目录/));

console.log('\n--- 备份与写文件 ---');
check('覆盖时产生备份', () => {
  const r = writeFile(root, 'src/a.js', 'const x = 2;\n', { backupDir });
  assert.equal(r.action, 'modify');
  const b = path.join(backupDir, 'src', 'a.js');
  assert.ok(fs.existsSync(b), '备份文件应存在');
  assert.equal(fs.readFileSync(b, 'utf8'), 'const x = 1;\n');
  assert.equal(fs.readFileSync(path.join(root, 'src', 'a.js'), 'utf8'), 'const x = 2;\n');
});
check('新建文件标记为 create', () => {
  const r = writeFile(root, 'src/b.js', 'ok\n');
  assert.equal(r.action, 'create');
});
check('edit_file 找不到原文时明确报错', () => {
  assert.throws(() => editFile(root, 'src/a.js', '不存在的片段', 'x'), /找不到要替换的内容/);
});
check('edit_file 多处匹配时拒绝', () => {
  writeFile(root, 'src/c.js', 'aa\naa\n');
  assert.throws(() => editFile(root, 'src/c.js', 'aa', 'bb'), /出现 2 次/);
});
check('read_file 读回内容', () => {
  assert.match(readFile(root, 'src/a.js'), /const x = 2/);
});

console.log('\n--- 命令执行 ---');
await checkAsync('执行 node -e 并拿到输出', async () => {
  const r = await runCommand(root, 'node -e "console.log(1+1)"', { timeoutMs: 20000 });
  assert.equal(r.ok, true, `实际 exit=${r.exitCode} stderr=${r.stderr}`);
  assert.match(r.stdout, /2/);
});

await checkAsync('危险命令被拦下且不执行', async () => {
  const r = await runCommand(root, 'rm -rf src', { timeoutMs: 20000 });
  assert.equal(r.ok, false);
  assert.equal(r.blocked, true);
  assert.ok(fs.existsSync(path.join(root, 'src', 'a.js')), '文件不应被删除');
});

await checkAsync('命令失败返回非零退出码而不是抛异常', async () => {
  const r = await runCommand(root, 'node -e "process.exit(3)"', { timeoutMs: 20000 });
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 3);
  assert.equal(r.blocked, false);
});

await checkAsync('超时会被终止', async () => {
  const started = Date.now();
  const r = await runCommand(root, 'node -e "setTimeout(()=>{},60000)"', { timeoutMs: 3000 });
  const cost = Date.now() - started;
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.ok(cost < 20000, `应在 3s 左右终止，实际 ${cost}ms`);
});

// 清理
try {
  fs.rmSync(root, { recursive: true, force: true });
} catch {
  /* ignore */
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
