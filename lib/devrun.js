import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { design as runDesign, execute as runExecute } from './devagent.js';
import { resolveSafe } from './sandbox.js';

/**
 * 开发运行的生命周期管理。
 *
 * 与 executor.js 分开的原因：那个是"分层并行派活"，这个是"单线程改一个工作区"。
 * 两个开发运行同时改同一目录必然打架，所以这里按工作区加锁，串行执行。
 */

const DIR = path.resolve(process.cwd(), config.dataDir);
const FILE = path.join(DIR, 'dev.json');
const RUNS_DIR = path.join(DIR, 'dev-runs');

let state = null;
let writeQueue = Promise.resolve();
const live = new Map(); // runId -> { emitter, abort, cancelled }
/**
 * 事件发射器跨阶段复用。
 * 踩过的坑：最初每个阶段（设计/执行）都新建 EventEmitter，前端只建立了一条 SSE，
 * 阶段切换后旧订阅挂在被丢弃的实例上，用户看到的是"方案出完就没反应了"。
 * 所以 emitter 按 runId 常驻，阶段切换只换 abort 控制器。
 */
const emitters = new Map(); // runId -> EventEmitter

function emitterFor(runId) {
  let e = emitters.get(runId);
  if (!e) {
    // 简单回收：超过 200 个且没人监听的就丢掉，避免长期运行下无限堆积
    if (emitters.size > 200) {
      for (const [k, v] of emitters) {
        if (v.listenerCount('event') === 0 && !live.has(k)) emitters.delete(k);
      }
    }
    e = new EventEmitter();
    e.setMaxListeners(20);
    emitters.set(runId, e);
  }
  return e;
}

function ensureDir() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
}

function load() {
  if (state) return state;
  ensureDir();
  if (!fs.existsSync(FILE)) {
    state = { version: 1, runs: [] };
    return state;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    state = { version: 1, runs: Array.isArray(parsed.runs) ? parsed.runs : [] };
  } catch {
    state = { version: 1, runs: [] };
  }
  return state;
}

function persist() {
  const snapshot = JSON.stringify(state, null, 2);
  writeQueue = writeQueue.then(
    () =>
      new Promise((resolve) => {
        try {
          ensureDir();
          const tmp = `${FILE}.tmp`;
          fs.writeFileSync(tmp, snapshot, 'utf8');
          fs.renameSync(tmp, FILE);
        } catch (err) {
          console.error('[devstore] 写盘失败:', err.message);
        }
        resolve();
      }),
  );
  return writeQueue;
}

function newId() {
  return `dev_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/* ---------------- 工作区校验 ---------------- */

const FORBIDDEN_ROOTS = [
  /^[a-zA-Z]:[\\/]?$/,
  /^[a-zA-Z]:[\\/]Windows/i,
  /^[a-zA-Z]:[\\/]Program Files/i,
  /^[a-zA-Z]:[\\/]ProgramData/i,
  /^\/(bin|etc|usr|var|sys|proc|dev|boot)$/i,
  /^\/$/,
];

export function validateWorkspace(input) {
  const abs = path.resolve(String(input || '').trim());
  if (!fs.existsSync(abs)) throw new Error(`目录不存在：${abs}`);
  if (!fs.statSync(abs).isDirectory()) throw new Error(`不是目录：${abs}`);
  if (FORBIDDEN_ROOTS.some((re) => re.test(abs))) {
    throw new Error(`这个目录太危险，拒绝挂载：${abs}。请选一个具体的项目目录。`);
  }
  return abs;
}

/* ---------------- 查询 ---------------- */

export function listRuns({ limit = 30 } = {}) {
  const s = load();
  return [...s.runs]
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, limit)
    .map((r) => ({
      id: r.id,
      task: r.task,
      workspace: r.workspace,
      status: r.status,
      createdAt: r.createdAt,
      finishedAt: r.finishedAt,
      step: r.step || 0,
      changeCount: (r.changes || []).length,
      cmdCount: (r.commands || []).length,
    }));
}

export function getRun(id) {
  return load().runs.find((r) => r.id === id) || null;
}

function saveRun(run) {
  const s = load();
  const idx = s.runs.findIndex((r) => r.id === run.id);
  run.updatedAt = Date.now();
  if (idx >= 0) s.runs[idx] = run;
  else s.runs.unshift(run);
  if (s.runs.length > 100) s.runs.length = 100;
  persist();
  return run;
}

export function deleteRun(id) {
  const s = load();
  const before = s.runs.length;
  s.runs = s.runs.filter((r) => r.id !== id);
  const removed = s.runs.length !== before;
  if (removed) {
    persist();
    try {
      fs.rmSync(path.join(RUNS_DIR, id), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  return removed;
}

export function isRunning(id) {
  return live.has(id);
}

export function subscribe(id, fn) {
  const e = emitterFor(id);
  e.on('event', fn);
  return () => e.off('event', fn);
}

export function cancelRun(id) {
  const ctx = live.get(id);
  if (!ctx) return false;
  ctx.cancelled = true;
  ctx.abort.abort();
  return true;
}

/* ---------------- 工作区锁：同一目录同时只允许一个开发运行 ---------------- */

const locks = new Map(); // workspace -> runId

function acquire(workspace, runId) {
  const holder = locks.get(workspace);
  if (holder && live.has(holder)) {
    throw new Error('这个工作区正有另一个开发任务在跑，等它结束再来（同时改同一目录会互相覆盖）');
  }
  locks.set(workspace, runId);
}

function release(workspace, runId) {
  if (locks.get(workspace) === runId) locks.delete(workspace);
}

function backupDirOf(runId) {
  return path.join(RUNS_DIR, runId, 'backup');
}

/* ---------------- 创建 ---------------- */

export function createRun({ workspace, task, model }) {
  const abs = validateWorkspace(workspace);
  const text = String(task || '').trim();
  if (text.length < 4) throw new Error('任务描述太短，至少 4 个字');
  if (text.length > 6000) throw new Error('任务描述太长（上限 6000 字）');

  const run = {
    id: newId(),
    task: text,
    workspace: abs,
    status: 'CREATED',
    model: model || config.devModel,
    createdAt: Date.now(),
    design: null,
    designStartedAt: null,
    startedAt: null,
    finishedAt: null,
    step: 0,
    steps: [],
    changes: [],
    commands: [],
    summary: null,
    verification: null,
    remaining: null,
    error: null,
    usage: null,
    trace: [],
  };
  saveRun(run);
  return run;
}

/* ---------------- 执行 ---------------- */

function makeEmitter(run, runId) {
  const emitter = emitterFor(runId);
  const abort = new AbortController();
  const ctx = { emitter, abort, cancelled: false };
  live.set(runId, ctx);

  const emit = (evt) => {
    // 同步进 run 记录，保证刷新页面也能看到进度
    if (evt.type === 'dev:step') run.step = evt.step;
    if (evt.type === 'dev:assistant') run.trace.push({ kind: 'assistant', step: evt.step, text: evt.text, at: Date.now() });
    if (evt.type === 'dev:tool') run.trace.push({ kind: 'tool', step: evt.step, name: evt.name, args: evt.args, at: Date.now() });
    if (evt.type === 'dev:tool:result') {
      const last = [...run.trace].reverse().find((t) => t.kind === 'tool' && t.step === evt.step && t.name === evt.name && t.result === undefined);
      if (last) {
        last.result = evt.preview;
        last.ok = evt.ok;
        last.durationMs = evt.durationMs;
      }
    }
    // 运行期间就要能看到"已经改了几个文件、跑了几条命令"，
    // 否则界面上一直是 0，用户会以为它什么都没干。
    if (evt.type === 'dev:file') {
      const prev = run.changes.find((c) => c.path === evt.path);
      if (prev) {
        prev.bytes = evt.bytes;
        prev.at = Date.now();
      } else {
        run.changes.push({ path: evt.path, action: evt.action, bytes: evt.bytes, lines: evt.lines || 0, at: Date.now() });
      }
    }
    if (evt.type === 'dev:cmd') {
      run.commands.push({
        command: evt.command,
        ok: evt.ok,
        exitCode: evt.exitCode,
        durationMs: evt.durationMs,
        blocked: evt.blocked,
        timedOut: evt.timedOut,
        at: Date.now(),
      });
    }
    try {
      emitter.emit('event', { ...evt, at: Date.now() });
    } catch (err) {
      console.error('[devrun] emit 失败:', err.message);
    }
  };

  return { ctx, emit };
}

/** 设计阶段：只读，出方案 */
export function startDesign(runId) {
  const run = getRun(runId);
  if (!run) throw new Error('运行记录不存在');
  if (live.has(runId)) throw new Error('这个任务正在运行中');

  const { ctx, emit } = makeEmitter(run, runId);

  (async () => {
    run.status = 'DESIGNING';
    run.designStartedAt = Date.now();
    run.error = null;
    saveRun(run);
    emit({ type: 'dev:status', status: 'DESIGNING' });

    try {
      const d = await runDesign({
        workspace: run.workspace,
        task: run.task,
        emit,
        signal: ctx.abort.signal,
        model: config.devDesignModel,
      });
      run.design = d;
      run.status = 'PLANNED';
      saveRun(run);
      emit({ type: 'dev:status', status: 'PLANNED' });
    } catch (err) {
      run.status = 'FAILED';
      run.error = err.message;
      run.finishedAt = Date.now();
      saveRun(run);
      emit({ type: 'dev:error', error: err.message });
      emit({ type: 'dev:status', status: 'FAILED' });
    } finally {
      live.delete(runId);
    }
  })();

  return { started: true };
}

/** 执行阶段：真改文件。plan 可选，没有就按 run.design 走 */
export function startExecute(runId, overrideDesign) {
  const run = getRun(runId);
  if (!run) throw new Error('运行记录不存在');
  if (live.has(runId)) throw new Error('这个任务正在运行中');
  if (overrideDesign) {
    run.design = overrideDesign;
    saveRun(run);
  }
  if (!run.design) throw new Error('还没有实施方案，先出方案再执行');

  acquire(run.workspace, runId);
  const { ctx, emit } = makeEmitter(run, runId);

  (async () => {
    run.status = 'RUNNING';
    run.startedAt = Date.now();
    run.step = 0;
    run.trace = [];
    run.changes = [];
    run.commands = [];
    run.error = null;
    saveRun(run);
    emit({ type: 'dev:status', status: 'RUNNING' });

    const backupDir = backupDirOf(runId);
    fs.mkdirSync(backupDir, { recursive: true });

    try {
      const r = await runExecute({
        workspace: run.workspace,
        task: run.task,
        design: run.design,
        emit,
        signal: ctx.abort.signal,
        backupDir,
        run,
        model: run.model,
      });

      run.changes = r.changes;
      run.commands = r.commands;
      run.summary = r.summary;
      run.verification = r.verification;
      run.remaining = r.remaining;
      run.usage = r.usage;
      run.stepsCount = r.steps;
      run.status = ctx.cancelled ? 'CANCELLED' : 'DONE';
      run.finishedAt = Date.now();
      saveRun(run);
      emit({
        type: 'dev:done',
        summary: run.summary,
        verification: run.verification,
        remaining: run.remaining,
        changes: run.changes,
        commands: run.commands,
        durationMs: run.finishedAt - run.startedAt,
      });
      emit({ type: 'dev:status', status: run.status });
    } catch (err) {
      const cancelled = ctx.cancelled || err.name === 'AbortError';
      run.status = cancelled ? 'CANCELLED' : 'FAILED';
      run.error = cancelled ? '已取消' : err.message;
      run.finishedAt = Date.now();
      saveRun(run);
      emit({ type: 'dev:error', error: run.error });
      emit({ type: 'dev:status', status: run.status });
    } finally {
      live.delete(runId);
      release(run.workspace, runId);
      setTimeout(() => ctx.emitter.removeAllListeners(), 60000).unref?.();
    }
  })();

  return { started: true };
}

/* ---------------- 回滚 ---------------- */

/**
 * 把本次运行改过的文件恢复到运行前状态。
 * 只恢复"运行前已存在"的文件；本次新建的文件直接删掉（在备份目录里没有对应副本）。
 */
export function rollback(runId) {
  const run = getRun(runId);
  if (!run) throw new Error('运行记录不存在');
  if (live.has(runId)) throw new Error('任务还在跑，先取消再回滚');

  const backupDir = backupDirOf(runId);
  if (!fs.existsSync(backupDir)) throw new Error('这次运行没有备份（可能是纯新增文件，无需回滚）');

  const restored = [];
  const removed = [];
  const failed = [];

  for (const c of run.changes || []) {
    try {
      const target = resolveSafe(run.workspace, c.path);
      const backup = path.join(backupDir, c.path);
      if (fs.existsSync(backup)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(backup, target);
        restored.push(c.path);
      } else if (c.action === 'create' && fs.existsSync(target)) {
        fs.unlinkSync(target);
        removed.push(c.path);
      }
    } catch (err) {
      failed.push(`${c.path}: ${err.message}`);
    }
  }

  run.status = 'ROLLED_BACK';
  run.rolledBackAt = Date.now();
  saveRun(run);
  return { restored, removed, failed };
}
