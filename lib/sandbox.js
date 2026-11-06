import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.js';

/**
 * 工作区沙箱。开发智能体的所有文件操作与命令执行都必须经过这里。
 *
 * 四条硬边界（写错任何一条，这个智能体就是一颗定时炸弹）：
 * 1. 路径不得逃出 root —— 绝对路径一律拒绝，`..` 解析后必须仍在 root 内，
 *    已存在的符号链接要 realpath 再校验一次（防软链跳出去）。
 * 2. 命令走白名单，逐段校验（按 && || ; | 切分），不是黑名单补丁式拦截。
 * 3. 覆盖/删除前把原文件备份到 run 目录，任何一步都能整体回滚。
 * 4. 写入 .git / node_modules / .env 这类目录或文件直接拒绝，不做"善意放过"。
 */

const DENY_DIRS = new Set(['.git', 'node_modules', '.svn', '.hg', 'dist', 'build', 'target', '__pycache__', '.venv', 'venv']);
const DENY_WRITE_FILE = /(^|\/)(\.env(\..*)?|id_rsa|id_ed25519|.*\.(pem|key|p12|pfx|jks))$/i;

/** 只读命令：允许，且不需要在 workspace 内也有意义 */
const ALLOW_CMDS = new Set([
  // 跨平台通用
  'node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno',
  'git', 'gh',
  'python', 'python3', 'pip', 'pip3', 'pytest', 'poetry', 'uv',
  'mvn', 'mvnw', 'gradle', 'gradlew', 'javac', 'java', 'jar',
  'go', 'cargo', 'rustc', 'dotnet',
  'tsc', 'esbuild', 'vite', 'vitest', 'jest', 'mocha', 'eslint', 'prettier',
  'make', 'cmake', 'php', 'composer', 'ruby', 'bundle', 'rspec',
  // 文件查看/操作
  'ls', 'dir', 'cat', 'type', 'head', 'tail', 'less', 'more', 'find', 'grep', 'rg',
  'wc', 'tree', 'pwd', 'echo', 'which', 'where', 'printenv', 'date', 'uname',
  'mkdir', 'touch', 'cp', 'copy', 'mv', 'move', 'diff', 'fc', 'sort', 'uniq',
  'sed', 'awk', 'tr', 'cut', 'jq', 'tar', 'zip', 'unzip',
  'cd', 'pushd', 'popd',
]);

/** 破坏性片段：命中即拒绝，不做任何"看起来还行"的放行 */
const DENY_PATTERNS = [
  { re: /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rf]/i, why: '递归/强制删除' },
  { re: /\brmdir\s+.*\/s/i, why: '递归删除目录' },
  { re: /\bdel\s+.*\/[sf]/i, why: '强制/递归删除' },
  { re: /\b(rd|rmdir)\s+\/s/i, why: '递归删除目录' },
  { re: /\bformat\s+[a-z]:/i, why: '格式化磁盘' },
  { re: /\bmkfs\b/i, why: '格式化文件系统' },
  { re: /\bdd\s+.*of=/i, why: '裸写磁盘' },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/i, why: '开关机' },
  { re: /\b(taskkill|killall|pkill)\b/i, why: '杀进程' },
  { re: /\bgit\s+push\b/i, why: '推送远端' },
  { re: /\bgit\s+reset\s+--hard\b/i, why: '硬重置会丢改动' },
  { re: /\bgit\s+clean\s+-[a-zA-Z]*[fd]/i, why: '清理未跟踪文件' },
  { re: /\bgit\s+checkout\s+--\s/i, why: '丢弃工作区改动' },
  { re: /\bgit\s+branch\s+-D\b/i, why: '强删分支' },
  { re: /\bgit\s+rebase\b/i, why: '改基会重写历史' },
  { re: /\bnpm\s+(publish|unpublish)\b/i, why: '发布包' },
  { re: /\bnpm\s+(i|install)\s+(-g|--global)\b/i, why: '全局安装污染环境' },
  { re: /\b(curl|wget|Invoke-WebRequest|iwr)\b/i, why: '外网请求（防数据外传）' },
  { re: /\bchmod\s+777\b/i, why: '权限过宽' },
  { re: /\b(chown|chgrp)\b/i, why: '改归属' },
  { re: /:\(\)\s*\{.*\};:/, why: 'fork 炸弹' },
  { re: /\bscp\b|\brsync\b/i, why: '跨机器传输' },
  { re: /\bsudo\b|\brunas\b|\bStart-Process\b/i, why: '提权' },
  { re: />\s*(\/|[a-zA-Z]:\\)/i, why: '重定向到绝对路径' },
  { re: />\s*[^\s>]*\.\.\//, why: '重定向逃出工作区' },
  // 命令里的路径越界：cwd 固定在工作区，但 ../ 和盘符绝对路径能跳出去
  { re: /(^|[^a-zA-Z0-9_.])\.\.[\\/]/, why: '命令里出现上级目录路径（只能在工作区内操作）' },
  { re: /[a-zA-Z]:[\\/]/, why: '命令里出现盘符绝对路径（路径都应相对工作区）' },
];

export class SandboxError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SandboxError';
  }
}

/** 校验并解析一个相对路径，返回绝对路径。任何越界都抛错。 */
export function resolveSafe(root, rel) {
  const raw = String(rel == null ? '' : rel).trim();
  if (!raw) throw new SandboxError('路径不能为空');
  if (raw.includes('\0')) throw new SandboxError('路径含非法字符');
  // 绝对路径一律拒绝：模型说"写到 /tmp"这种必须挡住
  if (path.isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('~')) {
    throw new SandboxError(`只接受工作区内的相对路径，收到绝对路径：${raw}`);
  }

  const rootAbs = path.resolve(root);
  const full = path.resolve(rootAbs, raw);
  const relToRoot = path.relative(rootAbs, full);
  if (relToRoot === '' ) return rootAbs;
  if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
    throw new SandboxError(`路径逃出工作区：${raw}`);
  }

  // 已存在的路径再校验一次真实路径，防符号链接跳出
  try {
    const real = fs.realpathSync(full);
    const realRoot = fs.realpathSync(rootAbs);
    const r = path.relative(realRoot, real);
    if (r.startsWith('..') || path.isAbsolute(r)) {
      throw new SandboxError(`符号链接指向工作区外：${raw}`);
    }
  } catch (err) {
    if (err instanceof SandboxError) throw err;
    // 不存在是正常的（新建文件），忽略
  }
  return full;
}

function denyWriteCheck(root, rel) {
  const norm = String(rel).replace(/\\/g, '/');
  if (DENY_WRITE_FILE.test(norm)) throw new SandboxError(`拒绝写入敏感文件：${rel}`);
  const parts = norm.split('/');
  for (const p of parts) {
    if (DENY_DIRS.has(p)) throw new SandboxError(`拒绝写入 ${p} 目录（生成物/依赖/版本库）`);
  }
}

function humanSize(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

const MAX_READ = 120 * 1024;

/* ---------------- 读 ---------------- */

export function listTree(root, { depth = 2, maxEntries = 300 } = {}) {
  const out = [];
  const rootAbs = path.resolve(root);
  const skip = new Set([...DENY_DIRS, '.idea', '.vscode', '.next', '.cache', 'coverage', '.gradle']);

  (function walk(dir, level) {
    if (out.length >= maxEntries) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const e of entries) {
      if (out.length >= maxEntries) return;
      if (e.name.startsWith('.') && e.name !== '.env.example') continue;
      const rel = path.relative(rootAbs, path.join(dir, e.name)).replace(/\\/g, '/');
      if (e.isDirectory()) {
        if (skip.has(e.name)) continue;
        out.push({ path: rel, type: 'dir' });
        if (level < depth) walk(path.join(dir, e.name), level + 1);
      } else {
        let size = 0;
        try {
          size = fs.statSync(path.join(dir, e.name)).size;
        } catch {
          /* ignore */
        }
        out.push({ path: rel, type: 'file', size });
      }
    }
  })(rootAbs, 0);

  return out;
}

export function treeText(root, opts) {
  const items = listTree(root, opts);
  if (!items.length) return '（空目录）';
  return items
    .map((i) => (i.type === 'dir' ? `  ${i.path}/` : `  ${i.path}  (${humanSize(i.size || 0)})`))
    .join('\n');
}

export function readFile(root, rel, { maxBytes = MAX_READ } = {}) {
  const full = resolveSafe(root, rel);
  if (!fs.existsSync(full)) throw new SandboxError(`文件不存在：${rel}`);
  const st = fs.statSync(full);
  if (st.isDirectory()) throw new SandboxError(`${rel} 是目录，不是文件`);
  if (st.size > maxBytes) {
    const buf = Buffer.alloc(maxBytes);
    const fd = fs.openSync(full, 'r');
    fs.readSync(fd, buf, 0, maxBytes, 0);
    fs.closeSync(fd);
    return `${buf.toString('utf8')}\n\n…（文件 ${humanSize(st.size)}，仅读取前 ${humanSize(maxBytes)}）`;
  }
  const text = fs.readFileSync(full, 'utf8');
  // 二进制兜底：出现大量不可打印字符就只报类型
  if (/\u0000/.test(text.slice(0, 2000))) return `（二进制文件，${humanSize(st.size)}，无法以文本显示）`;
  return text;
}

export function searchContent(root, pattern, { glob: globPat = '', maxHits = 60, ignoreCase = true } = {}) {
  let re;
  try {
    re = new RegExp(pattern, ignoreCase ? 'i' : '');
  } catch (e) {
    throw new SandboxError(`正则不合法：${e.message}`);
  }
  const hits = [];
  const files = listTree(root, { depth: 12, maxEntries: 4000 }).filter((i) => i.type === 'file');
  // glob 带斜杠说明是按路径匹配（如 "public/app.js"），不带才按文件名（如 "*.java"）。
  // 之前统一拿 basename 去比，导致传路径形式的 glob 永远匹配不到。
  const globUsesPath = globPat.includes('/');
  const extFilter = globPat ? new RegExp(`^(${globPat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')})$`, 'i') : null;

  for (const f of files) {
    if (hits.length >= maxHits) break;
    if (extFilter && !extFilter.test(globUsesPath ? f.path : path.basename(f.path))) continue;
    if (f.size > 512 * 1024) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(root, f.path), 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\u0000')) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        hits.push(`${f.path}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        if (hits.length >= maxHits) break;
      }
    }
  }
  return hits;
}

/* ---------------- 写 ---------------- */

/**
 * 备份 + 写入。备份目录结构镜像工作区相对路径，便于整体还原。
 * 返回 { action: 'create'|'modify', bytes, backup }
 */
export function writeFile(root, rel, content, { backupDir } = {}) {
  denyWriteCheck(root, rel);
  const full = resolveSafe(root, rel);
  const existed = fs.existsSync(full);
  let backup = null;

  if (existed && backupDir) {
    const bPath = path.join(backupDir, String(rel));
    fs.mkdirSync(path.dirname(bPath), { recursive: true });
    fs.copyFileSync(full, bPath);
    backup = bPath;
  }

  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return { action: existed ? 'modify' : 'create', bytes: Buffer.byteLength(content), backup };
}

/** 字符串替换式编辑：比整文件重写省 token，也更不容易误伤大文件 */
export function editFile(root, rel, oldStr, newStr, { backupDir, all = false } = {}) {
  denyWriteCheck(root, rel);
  const full = resolveSafe(root, rel);
  if (!fs.existsSync(full)) throw new SandboxError(`文件不存在：${rel}`);
  const text = fs.readFileSync(full, 'utf8');
  if (!oldStr) throw new SandboxError('old_string 不能为空');
  const count = text.split(oldStr).length - 1;
  if (count === 0) throw new SandboxError(`在 ${rel} 里找不到要替换的内容，请先 read_file 确认原文`);
  if (count > 1 && !all) throw new SandboxError(`要替换的内容在 ${rel} 里出现 ${count} 次，请提供更长且唯一的片段`);

  const updated = all ? text.split(oldStr).join(newStr) : text.replace(oldStr, newStr);

  let backup = null;
  if (backupDir) {
    const bPath = path.join(backupDir, String(rel));
    fs.mkdirSync(path.dirname(bPath), { recursive: true });
    fs.copyFileSync(full, bPath);
    backup = bPath;
  }
  fs.writeFileSync(full, updated, 'utf8');
  return { action: 'modify', replaced: all ? count : 1, bytes: Buffer.byteLength(updated), backup };
}

/* ---------------- 命令 ---------------- */

/**
 * 校验命令是否可以执行。逐段校验首命令在允许表内，并检查危险片段。
 * 返回 { ok, reason }。
 */
export function checkCommand(cmd) {
  const raw = String(cmd || '').trim();
  if (!raw) return { ok: false, reason: '命令为空' };
  if (raw.length > 2000) return { ok: false, reason: '命令过长' };

  for (const { re, why } of DENY_PATTERNS) {
    if (re.test(raw)) return { ok: false, reason: `命令包含被禁止的操作（${why}）` };
  }

  // 按命令连接符切段，每段首词都必须在白名单
  const segments = raw
    .split(/&&|\|\||[;|]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!segments.length) return { ok: false, reason: '命令为空' };

  for (const seg of segments) {
    // 去掉前置的环境变量赋值，如 NODE_ENV=test npm test
    const cleaned = seg.replace(/^(\w+=\S*\s+)+/, '').trim();
    const first = cleaned.split(/\s+/)[0] || '';
    if (!first) continue;
    const base = first.replace(/^\.\//, '').replace(/\.(cmd|exe|bat|sh)$/i, '').toLowerCase();
    if (!ALLOW_CMDS.has(base)) {
      return { ok: false, reason: `命令「${first}」不在白名单内（可用：构建/测试/git 查看/包管理/文本处理）` };
    }
  }
  return { ok: true };
}

const MAX_OUT = 20000;

function clip(s) {
  if (s.length <= MAX_OUT) return s;
  return `${s.slice(0, MAX_OUT * 0.6)}\n\n…（中间省略 ${s.length - MAX_OUT} 字符）…\n\n${s.slice(-MAX_OUT * 0.4)}`;
}

/**
 * 执行命令。cwd 固定在 workspace，stdin 关闭（防交互命令挂死），超时强杀。
 * 永不抛错：失败也返回结构化结果，让模型自己看输出调整。
 */
export function runCommand(root, cmd, { timeoutMs = config.devCmdTimeout } = {}) {
  const check = checkCommand(cmd);
  if (!check.ok) {
    return Promise.resolve({ ok: false, blocked: true, exitCode: null, stdout: '', stderr: check.reason, durationMs: 0 });
  }

  return new Promise((resolve) => {
    const started = Date.now();
    const isWin = process.platform === 'win32';
    const child = spawn(cmd, {
      cwd: root,
      shell: isWin ? true : '/bin/bash',
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1', CI: '1', GIT_PAGER: 'cat', PAGER: 'cat' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let killed = false;
    let settled = false;

    const timer = setTimeout(() => {
      killed = true;
      try {
        if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { windowsHide: true });
        else child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      if (stdout.length < MAX_OUT * 2) stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < MAX_OUT * 2) stderr += d.toString('utf8');
    });

    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: !killed && code === 0,
        blocked: false,
        exitCode: code,
        signal,
        timedOut: killed,
        stdout: clip(stdout),
        stderr: clip(stderr),
        durationMs: Date.now() - started,
      });
    };

    child.on('error', (err) => {
      stderr += `\n[执行失败] ${err.message}`;
      finish(-1, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}

/** 列出可挂载的工作区候选：给前端目录选择器用 */
export function listDirs(base, rel = '') {
  const root = path.resolve(base);
  const target = rel ? resolveSafe(root, rel) : root;
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new SandboxError('目录不存在');
  const entries = fs
    .readdirSync(target, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !DENY_DIRS.has(e.name))
    .map((e) => ({ name: e.name, path: path.relative(root, path.join(target, e.name)).replace(/\\/g, '/') }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { abs: target, parent: path.dirname(target) === target ? null : path.dirname(target), entries };
}
