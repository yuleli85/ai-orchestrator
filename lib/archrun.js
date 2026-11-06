import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { diagnose as runDiagnose, design as runDesign } from './archagent.js';
import { resolveSafe } from './sandbox.js';

/**
 * 架构设计的运行生命周期。
 *
 * 状态机比开发智能体多一个中间态：
 *   CREATED → SCANNING → DIAGNOSED（停下来，等人选方案）→ DESIGNING → DONE
 *
 * 这个"停下来"是刻意的。架构设计的分水岭不在写文档，在选方向；
 * 如果让模型自己选完继续写，用户拿到的是一份他不知道为什么这么切的文档。
 */

const DIR = path.resolve(process.cwd(), config.dataDir);
const FILE = path.join(DIR, 'arch.json');
const RUNS_DIR = path.join(DIR, 'arch-runs');

let state = null;
let writeQueue = Promise.resolve();
const live = new Map(); // runId -> { abort, cancelled }
const emitters = new Map(); // runId -> EventEmitter，跨阶段复用

function emitterFor(runId) {
  let e = emitters.get(runId);
  if (!e) {
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

// 这些状态只可能存在于进程内存里：进程一没，它们就永远是假的"进行中"。
const LIVE_STATUSES = new Set(['CREATED', 'SCANNING', 'DESIGNING']);

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

  // 上次进程被关掉时正在跑的任务，落盘状态会停在 SCANNING / DESIGNING，
  // 重启后既不会推进也不会失败，列表里永远显示"进行中"——必须在这里收尾。
  // 已经写到磁盘上的文档不动，用户能自己看、自己回滚。
  let orphans = 0;
  for (const r of state.runs) {
    if (!LIVE_STATUSES.has(r.status)) continue;
    r.status = 'INTERRUPTED';
    r.error = '服务重启，这次运行被中断。已写到磁盘上的文档仍保留在工作区。';
    r.finishedAt = Date.now();
    orphans++;
  }
  if (orphans) {
    console.log(`[archstore] ${orphans} 个上次没跑完的架构任务已标记为「已中断」`);
    persist();
  }
  return state;
}

function persist() {
  const snapshot = JSON.stringify(state);
  writeQueue = writeQueue.then(
    () =>
      new Promise((resolve) => {
        try {
          ensureDir();
          const tmp = `${FILE}.tmp`;
          fs.writeFileSync(tmp, snapshot, 'utf8');
          fs.renameSync(tmp, FILE);
        } catch (err) {
          console.error('[archstore] 写盘失败:', err.message);
        }
        resolve();
      }),
  );
  return writeQueue;
}

function newId() {
  return `arch_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/* ---------------- 查询 ---------------- */

export function listRuns({ limit = 30 } = {}) {
  return [...load().runs]
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, limit)
    .map((r) => ({
      id: r.id,
      goal: r.goal,
      workspace: r.workspace,
      status: r.status,
      createdAt: r.createdAt,
      finishedAt: r.finishedAt,
      issueCount: (r.diagnosis?.issues || []).length,
      optionCount: (r.diagnosis?.options || []).length,
      docCount: (r.docs || []).length,
      docLines: (r.docs || []).reduce((n, d) => n + (d.lines || 0), 0),
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
  if (s.runs.length > 80) s.runs.length = 80;
  persist();
  return run;
}

export function deleteRun(id) {
  const s = load();
  const before = s.runs.length;
  s.runs = s.runs.filter((r) => r.id !== id);
  if (s.runs.length === before) return false;
  persist();
  try {
    fs.rmSync(path.join(RUNS_DIR, id), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  return true;
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

/* ---------------- 工作区锁 ---------------- */

const locks = new Map();

function acquire(workspace, runId) {
  const holder = locks.get(workspace);
  if (holder && live.has(holder)) {
    throw new Error('这个工作区正有另一个架构任务在跑，等它结束再来（会写同一批文档）');
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

export function createRun({ workspace, goal, model }) {
  const abs = path.resolve(String(workspace || '').trim());
  if (!fs.existsSync(abs)) throw new Error(`目录不存在：${abs}`);
  if (!fs.statSync(abs).isDirectory()) throw new Error(`不是目录：${abs}`);

  const text = String(goal || '').trim();
  if (text.length < 6) throw new Error('设计目标太短，至少 6 个字。说清你要解决什么架构问题');
  if (text.length > 6000) throw new Error('设计目标太长（上限 6000 字）');

  const run = {
    id: newId(),
    goal: text,
    workspace: abs,
    status: 'CREATED',
    model: model || config.archModel,
    createdAt: Date.now(),
    scannedAt: null,
    diagnosedAt: null,
    startedAt: null,
    finishedAt: null,
    diagnosis: null,
    selectedOptionId: null,
    docs: [],
    summary: null,
    decisions: null,
    risks: null,
    remaining: null,
    step: 0,
    error: null,
    usage: null,
    trace: [],
  };
  saveRun(run);
  return run;
}

/* ---------------- 事件与阶段 ---------------- */

function makeEmitter(run, runId) {
  const emitter = emitterFor(runId);
  const abort = new AbortController();
  const ctx = { abort, cancelled: false };
  live.set(runId, ctx);

  const emit = (evt) => {
    if (evt.type === 'arch:step') run.step = evt.step;
    if (evt.type === 'arch:assistant') run.trace.push({ kind: 'assistant', step: evt.step, text: evt.text, at: Date.now() });
    if (evt.type === 'arch:tool') run.trace.push({ kind: 'tool', step: evt.step, name: evt.name, args: evt.args, at: Date.now() });
    if (evt.type === 'arch:tool:result') {
      const last = [...run.trace].reverse().find((t) => t.kind === 'tool' && t.step === evt.step && t.name === evt.name && t.result === undefined);
      if (last) {
        last.result = evt.preview;
        last.ok = evt.ok;
        last.durationMs = evt.durationMs;
      }
    }
    if (evt.type === 'arch:doc') {
      const prev = run.docs.find((d) => d.path === evt.path);
      if (prev) {
        prev.bytes = evt.bytes;
        prev.lines = evt.lines;
        prev.at = Date.now();
      } else {
        run.docs.push({ path: evt.path, action: evt.action, bytes: evt.bytes, lines: evt.lines, at: Date.now() });
      }
    }
    try {
      emitter.emit('event', { ...evt, at: Date.now() });
    } catch (err) {
      console.error('[archrun] emit 失败:', err.message);
    }
  };

  return { ctx, emit };
}

/** 第一阶段：扫描 + 诊断，只读 */
export function startDiagnose(runId) {
  const run = getRun(runId);
  if (!run) throw new Error('运行记录不存在');
  if (live.has(runId)) throw new Error('这个任务正在运行中');

  const { ctx, emit } = makeEmitter(run, runId);

  (async () => {
    run.status = 'SCANNING';
    run.error = null;
    saveRun(run);
    emit({ type: 'arch:status', status: 'SCANNING' });

    try {
      const d = await runDiagnose({
        workspace: run.workspace,
        goal: run.goal,
        emit,
        signal: ctx.abort.signal,
        model: config.archModel,
      });
      run.diagnosis = d;
      run.scannedAt = Date.now();
      run.diagnosedAt = Date.now();
      run.status = 'DIAGNOSED';
      run.usage = d.usage;
      saveRun(run);
      emit({ type: 'arch:status', status: 'DIAGNOSED' });
    } catch (err) {
      const cancelled = ctx.cancelled || err.name === 'AbortError';
      run.status = cancelled ? 'CANCELLED' : 'FAILED';
      run.error = cancelled ? '已取消' : err.message;
      run.finishedAt = Date.now();
      saveRun(run);
      emit({ type: 'arch:error', error: run.error });
      emit({ type: 'arch:status', status: run.status });
    } finally {
      live.delete(runId);
    }
  })();

  return { started: true };
}

/** 第二阶段：按选定方向写文档 */
export function startDesign(runId, optionId) {
  const run = getRun(runId);
  if (!run) throw new Error('运行记录不存在');
  if (live.has(runId)) throw new Error('这个任务正在运行中');
  if (!run.diagnosis) throw new Error('还没有诊断结果，先做诊断');

  const chosen = optionId || run.selectedOptionId || run.diagnosis.recommendation.optionId;
  if (!run.diagnosis.options.some((o) => o.id === chosen)) {
    throw new Error(`方案 ${chosen} 不存在`);
  }

  acquire(run.workspace, runId);
  const { ctx, emit } = makeEmitter(run, runId);

  (async () => {
    run.status = 'DESIGNING';
    run.selectedOptionId = chosen;
    run.startedAt = Date.now();
    run.step = 0;
    run.trace = [];
    run.docs = [];
    run.error = null;
    saveRun(run);
    emit({ type: 'arch:status', status: 'DESIGNING', optionId: chosen });

    const backupDir = backupDirOf(runId);
    fs.mkdirSync(backupDir, { recursive: true });

    try {
      const r = await runDesign({
        workspace: run.workspace,
        goal: run.goal,
        diagnosis: run.diagnosis,
        optionId: chosen,
        emit,
        signal: ctx.abort.signal,
        backupDir,
        model: run.model,
      });

      run.docs = r.docs;
      run.summary = r.summary;
      run.decisions = r.decisions;
      run.risks = r.risks;
      run.remaining = r.remaining;
      run.usage = { ...(run.usage || {}), ...r.usage };
      run.stepsCount = r.steps;
      run.status = ctx.cancelled ? 'CANCELLED' : 'DONE';
      run.finishedAt = Date.now();
      saveRun(run);
      emit({
        type: 'arch:done',
        summary: run.summary,
        decisions: run.decisions,
        risks: run.risks,
        remaining: run.remaining,
        docs: run.docs,
        durationMs: run.finishedAt - run.startedAt,
      });
      emit({ type: 'arch:status', status: run.status });
    } catch (err) {
      const cancelled = ctx.cancelled || err.name === 'AbortError';
      run.status = cancelled ? 'CANCELLED' : 'FAILED';
      run.error = cancelled ? '已取消' : err.message;
      run.finishedAt = Date.now();
      saveRun(run);
      emit({ type: 'arch:error', error: run.error });
      emit({ type: 'arch:status', status: run.status });
    } finally {
      live.delete(runId);
      release(run.workspace, runId);
      const em = emitterFor(runId);
      setTimeout(() => em.removeAllListeners(), 60000).unref?.();
    }
  })();

  return { started: true };
}

/* ---------------- 回滚 ---------------- */

export function rollback(runId) {
  const run = getRun(runId);
  if (!run) throw new Error('运行记录不存在');
  if (live.has(runId)) throw new Error('任务还在跑，先取消再回滚');

  const backupDir = backupDirOf(runId);
  const restored = [];
  const removed = [];
  const failed = [];

  for (const d of run.docs || []) {
    try {
      const target = resolveSafe(run.workspace, d.path);
      const backup = path.join(backupDir, d.path);
      if (fs.existsSync(backup)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(backup, target);
        restored.push(d.path);
      } else if (d.action === 'create' && fs.existsSync(target)) {
        fs.unlinkSync(target);
        removed.push(d.path);
      }
    } catch (err) {
      failed.push(`${d.path}: ${err.message}`);
    }
  }

  if (!restored.length && !removed.length && !failed.length) {
    throw new Error('这次运行没有产出的文档，没有可回滚的内容');
  }

  run.status = 'ROLLED_BACK';
  run.rolledBackAt = Date.now();
  saveRun(run);
  return { restored, removed, failed };
}
