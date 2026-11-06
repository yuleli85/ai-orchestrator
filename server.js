import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { config } from './lib/config.js';
import { listRoles, upsertRole, deleteRole, listJobs, getJob, saveJob, deleteJob, newId } from './lib/store.js';
import { plan, computeLayers, normalizePlan } from './lib/planner.js';
import { startExecution, subscribe, cancel, isRunning, getRunning } from './lib/executor.js';
import { listDirs, readFile as readWorkspaceFile } from './lib/sandbox.js';
import {
  listRuns as listDevRuns,
  getRun as getDevRun,
  createRun as createDevRun,
  startDesign as startDevDesign,
  startExecute as startDevExecute,
  cancelRun as cancelDevRun,
  rollback as rollbackDevRun,
  subscribe as subscribeDev,
  isRunning as isDevRunning,
  deleteRun as deleteDevRun,
  validateWorkspace,
} from './lib/devrun.js';
import {
  listRuns as listArchRuns,
  getRun as getArchRun,
  createRun as createArchRun,
  startDiagnose as startArchDiagnose,
  startDesign as startArchDesign,
  cancelRun as cancelArchRun,
  rollback as rollbackArchRun,
  subscribe as subscribeArch,
  isRunning as isArchRunning,
  deleteRun as deleteArchRun,
} from './lib/archrun.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function ok(res, data) {
  sendJson(res, 200, { ok: true, data });
}

function fail(res, code, message) {
  sendJson(res, code, { ok: false, error: message });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 2 * 1024 * 1024) throw new Error('请求体过大');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath.replace(/^\/+/, ''));
  const full = path.join(PUBLIC_DIR, rel);
  // 防目录穿越：解析后必须仍在 public 目录内
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(full, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

function toMarkdown(job, roles) {
  const roleName = (id) => roles.find((r) => r.id === id)?.name || id;
  const lines = [];
  lines.push(`# ${job.title || '任务交付'}`);
  lines.push('');
  lines.push(`> 原始需求：${job.goal}`);
  lines.push(`> 生成时间：${new Date(job.createdAt).toLocaleString('zh-CN')}`);
  if (job.plan?.assumptions?.length) {
    lines.push(`> 已做假设：${job.plan.assumptions.join('；')}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  if (job.summary?.content) {
    lines.push(job.summary.content);
  } else {
    lines.push('_（尚未生成汇总，以下是各子任务产出）_');
    lines.push('');
    for (const t of job.plan?.tasks || []) {
      const run = job.runs?.find((r) => r.taskId === t.id);
      lines.push(`## ${t.title} · ${roleName(t.roleId)}`);
      lines.push('');
      lines.push(run?.status === 'DONE' ? run.output : `_未完成：${run?.error || '未执行'}_`);
      lines.push('');
    }
  }

  // 附录保留原始分工，方便追溯
  if (job.plan?.tasks?.length && job.summary?.content) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## 附录：分工与执行明细');
    lines.push('');
    for (const t of job.plan.tasks) {
      const run = job.runs?.find((r) => r.taskId === t.id);
      const status = run?.status || 'PENDING';
      const dur = run?.durationMs ? `${(run.durationMs / 1000).toFixed(1)}s` : '-';
      lines.push(`- **${t.id} ${t.title}** · ${roleName(t.roleId)} · ${status} · ${dur}`);
    }
  }
  return lines.join('\n');
}

function sseHandler(req, res, jobId) {
  const job = getJob(jobId);
  if (!job) return fail(res, 404, '任务不存在');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  // 心跳：防止中间代理掐断长连接
  const hb = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }, 15000);

  let closed = false;
  let unsub = () => {};
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(hb);
    unsub();
    try {
      res.end();
    } catch {
      /* ignore */
    }
  };

  // 连接建立时先补一份当前状态快照。
  // 原因：客户端是先 POST /execute 再订阅 SSE 的，这中间的几百毫秒里
  // 可能已经发出了 task:start / 部分 delta，只靠增量事件会漏掉。
  const snapshot = {
    type: 'job:snapshot',
    status: job.status,
    runs: (job.runs || []).map((r) => ({
      taskId: r.taskId,
      status: r.status,
      output: r.output || '',
      durationMs: r.durationMs,
      error: r.error || null,
    })),
    summary: job.summary?.content || '',
  };
  try {
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
  } catch {
    /* ignore */
  }

  // 任务已经结束时不要挂着连接
  if (!isRunning(jobId)) {
    setTimeout(cleanup, 120);
    req.on('close', cleanup);
    return;
  }

  unsub = subscribe(jobId, (evt) => {
    try {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    } catch {
      /* ignore */
    }
    // 终态事件送达后主动关闭，否则客户端会一直等 read() 返回 done
    if (evt.type === 'job:done') setTimeout(cleanup, 250);
  });

  req.on('close', cleanup);
  req.on('error', cleanup);
}

function sseDevHandler(req, res, runId) {
  const run = getDevRun(runId);
  if (!run) return fail(res, 404, '运行记录不存在');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  const hb = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }, 15000);

  let closed = false;
  let unsub = () => {};
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(hb);
    unsub();
    try {
      res.end();
    } catch {
      /* ignore */
    }
  };

  // 补状态快照：刷新页面后能恢复已有的方案与轨迹
  const snapshot = {
    type: 'dev:snapshot',
    status: run.status,
    step: run.step || 0,
    design: run.design,
    trace: run.trace || [],
    changes: run.changes || [],
    commands: run.commands || [],
    summary: run.summary,
    verification: run.verification,
    remaining: run.remaining,
    error: run.error,
    running: isDevRunning(runId),
  };
  try {
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
  } catch {
    /* ignore */
  }

  // 只有终态才收工。
  // 注意这里不能写成 `if (!isDevRunning) 立即关闭`：前端是先连 SSE 再 POST 启动的，
  // 那一瞬间任务还没开始跑，立即关闭会把 design:start 之后的所有事件全丢掉。
  if (!isDevRunning(runId) && ['DONE', 'FAILED', 'CANCELLED', 'ROLLED_BACK'].includes(run.status)) {
    setTimeout(cleanup, 150);
    req.on('close', cleanup);
    return;
  }

  unsub = subscribeDev(runId, (evt) => {
    try {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    } catch {
      /* ignore */
    }
    // 只有终态才关连接：设计完成还要接着执行，不能在这里断
    if (evt.type === 'dev:error' || (evt.type === 'dev:status' && ['DONE', 'FAILED', 'CANCELLED'].includes(evt.status))) {
      setTimeout(cleanup, 400);
    }
  });

  req.on('close', cleanup);
  req.on('error', cleanup);
}

function sseArchHandler(req, res, runId) {
  const run = getArchRun(runId);
  if (!run) return fail(res, 404, '运行记录不存在');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  const hb = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }, 15000);

  let closed = false;
  let unsub = () => {};
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(hb);
    unsub();
    try {
      res.end();
    } catch {
      /* ignore */
    }
  };

  const snapshot = {
    type: 'arch:snapshot',
    status: run.status,
    step: run.step || 0,
    diagnosis: run.diagnosis,
    selectedOptionId: run.selectedOptionId,
    docs: run.docs || [],
    trace: run.trace || [],
    summary: run.summary,
    decisions: run.decisions,
    risks: run.risks,
    remaining: run.remaining,
    error: run.error,
    running: isArchRunning(runId),
  };
  try {
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
  } catch {
    /* ignore */
  }

  // DIAGNOSED 不是终态：用户还要选方案，连接得留着
  if (!isArchRunning(runId) && ['DONE', 'FAILED', 'CANCELLED', 'ROLLED_BACK'].includes(run.status)) {
    setTimeout(cleanup, 150);
    req.on('close', cleanup);
    return;
  }

  unsub = subscribeArch(runId, (evt) => {
    try {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    } catch {
      /* ignore */
    }
    if (evt.type === 'arch:error' || (evt.type === 'arch:status' && ['DONE', 'FAILED', 'CANCELLED', 'ROLLED_BACK'].includes(evt.status))) {
      setTimeout(cleanup, 400);
    }
  });

  req.on('close', cleanup);
  req.on('error', cleanup);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  try {
    if (p.startsWith('/api/')) {
      // ---- 健康检查 ----
      if (p === '/api/health' && req.method === 'GET') {
        return ok(res, {
          status: 'up',
          model: config.planModel,
          modelFast: config.modelFast,
          modelStrong: config.modelStrong,
          devModel: config.devModel,
          archModel: config.archModel,
          devRoot: config.devRoot,
          baseUrl: config.baseUrl,
          hasKey: Boolean(config.apiKey),
          concurrency: config.concurrency,
          roles: listRoles().length,
          runningJobs: [...new Set([...listJobs({ limit: 200 }).filter((j) => j.status === 'RUNNING').map((j) => j.id)])].length,
        });
      }

      // ---- 角色 ----
      if (p === '/api/roles' && req.method === 'GET') {
        return ok(res, listRoles());
      }
      if (p === '/api/roles' && req.method === 'POST') {
        const body = await readBody(req);
        const role = upsertRole(body);
        return ok(res, role);
      }
      if (p.startsWith('/api/roles/') && req.method === 'DELETE') {
        const id = p.split('/')[3];
        return ok(res, { removed: deleteRole(id) });
      }

      // ---- 开发智能体 ----
      if (p === '/api/dev/runs' && req.method === 'GET') {
        return ok(res, listDevRuns({ limit: Number(url.searchParams.get('limit') || 30) }));
      }

      if (p === '/api/dev/runs' && req.method === 'POST') {
        const body = await readBody(req);
        try {
          let ws = body.workspace;
          if (!ws) throw new Error('请先选择工作区目录');
          ws = validateWorkspace(ws);
          const run = createDevRun({ workspace: ws, task: body.task, model: body.model });
          return ok(res, run);
        } catch (err) {
          return fail(res, 400, err.message);
        }
      }

      // 目录浏览：给工作区选择器用。只在 ORCH_DEV_ROOT 之内浏览
      if (p === '/api/fs/list' && req.method === 'GET') {
        const target = url.searchParams.get('path');
        try {
          const listing = listDirs(target ? path.resolve(target) : config.devRoot);
          return ok(res, { ...listing, root: config.devRoot, home: config.devRoot });
        } catch (err) {
          return fail(res, 400, err.message);
        }
      }

      const devMatch = p.match(/^\/api\/dev\/runs\/([^/]+)(\/.*)?$/);
      if (devMatch) {
        const runId = decodeURIComponent(devMatch[1]);
        const sub = devMatch[2] || '';

        if (!sub && req.method === 'GET') {
          const run = getDevRun(runId);
          if (!run) return fail(res, 404, '运行记录不存在');
          return ok(res, { ...run, running: isDevRunning(runId) });
        }

        if (!sub && req.method === 'DELETE') {
          if (isDevRunning(runId)) return fail(res, 409, '还在运行，先取消');
          return ok(res, { removed: deleteDevRun(runId) });
        }

        if (sub === '/design' && req.method === 'POST') {
          if (isDevRunning(runId)) return fail(res, 409, '已经在运行了');
          try {
            startDevDesign(runId);
            return ok(res, { started: true });
          } catch (err) {
            return fail(res, 400, err.message);
          }
        }

        if (sub === '/execute' && req.method === 'POST') {
          if (isDevRunning(runId)) return fail(res, 409, '已经在运行了');
          const body = await readBody(req);
          try {
            startDevExecute(runId, body.design || null);
            return ok(res, { started: true });
          } catch (err) {
            return fail(res, 409, err.message);
          }
        }

        if (sub === '/cancel' && req.method === 'POST') {
          return cancelDevRun(runId) ? ok(res, { cancelled: true }) : fail(res, 409, '当前没有在跑');
        }

        if (sub === '/rollback' && req.method === 'POST') {
          try {
            return ok(res, rollbackDevRun(runId));
          } catch (err) {
            return fail(res, 400, err.message);
          }
        }

        if (sub === '/events' && req.method === 'GET') {
          return sseDevHandler(req, res, runId);
        }
      }

      // ---- 架构智能体 ----
      if (p === '/api/arch/runs' && req.method === 'GET') {
        return ok(res, listArchRuns({ limit: Number(url.searchParams.get('limit') || 30) }));
      }

      if (p === '/api/arch/runs' && req.method === 'POST') {
        const body = await readBody(req);
        try {
          let ws = body.workspace;
          if (!ws) throw new Error('请先选择要分析的代码目录');
          ws = validateWorkspace(ws);
          const run = createArchRun({ workspace: ws, goal: body.goal, model: body.model });
          return ok(res, run);
        } catch (err) {
          return fail(res, 400, err.message);
        }
      }

      const archMatch = p.match(/^\/api\/arch\/runs\/([^/]+)(\/.*)?$/);
      if (archMatch) {
        const runId = decodeURIComponent(archMatch[1]);
        const sub = archMatch[2] || '';

        if (!sub && req.method === 'GET') {
          const run = getArchRun(runId);
          if (!run) return fail(res, 404, '运行记录不存在');
          return ok(res, { ...run, running: isArchRunning(runId) });
        }

        if (!sub && req.method === 'DELETE') {
          if (isArchRunning(runId)) return fail(res, 409, '还在运行，先取消');
          return ok(res, { removed: deleteArchRun(runId) });
        }

        // 第一阶段：只读扫描 + 诊断，出候选方案后停下等人选
        if (sub === '/diagnose' && req.method === 'POST') {
          if (isArchRunning(runId)) return fail(res, 409, '已经在运行了');
          try {
            startArchDiagnose(runId);
            return ok(res, { started: true });
          } catch (err) {
            return fail(res, 400, err.message);
          }
        }

        // 第二阶段：按选定方案写文档
        if (sub === '/design' && req.method === 'POST') {
          if (isArchRunning(runId)) return fail(res, 409, '已经在运行了');
          const body = await readBody(req);
          try {
            startArchDesign(runId, body.optionId);
            return ok(res, { started: true });
          } catch (err) {
            return fail(res, 409, err.message);
          }
        }

        if (sub === '/cancel' && req.method === 'POST') {
          return cancelArchRun(runId) ? ok(res, { cancelled: true }) : fail(res, 409, '当前没有在跑');
        }

        if (sub === '/rollback' && req.method === 'POST') {
          try {
            return ok(res, rollbackArchRun(runId));
          } catch (err) {
            return fail(res, 400, err.message);
          }
        }

        if (sub === '/events' && req.method === 'GET') {
          return sseArchHandler(req, res, runId);
        }

        // 文档预览：只允许读本次运行自己产出的那几份，防止拿它当任意文件读取器
        if (sub === '/doc' && req.method === 'GET') {
          const run = getArchRun(runId);
          if (!run) return fail(res, 404, '运行记录不存在');
          const docPath = url.searchParams.get('path') || '';
          const hit = (run.docs || []).find((d) => d.path === docPath);
          if (!hit) return fail(res, 404, '这份文档不属于本次运行');
          try {
            const content = readWorkspaceFile(run.workspace, docPath, { maxBytes: 200000 });
            return ok(res, { path: docPath, content });
          } catch (err) {
            return fail(res, 400, err.message);
          }
        }
      }

      // ---- 任务列表 ----
      if (p === '/api/jobs' && req.method === 'GET') {
        return ok(res, listJobs({ limit: Number(url.searchParams.get('limit') || 50) }));
      }

      // ---- 新建任务：直接规划 ----
      if (p === '/api/jobs' && req.method === 'POST') {
        const body = await readBody(req);
        const goal = String(body.goal || '').trim();
        if (goal.length < 4) return fail(res, 400, '任务描述太短，至少 4 个字');
        if (goal.length > 8000) return fail(res, 400, '任务描述太长（上限 8000 字）');

        // 带了工作区，编码类子任务就能真写代码；没带则退化为出方案
        let workspace = null;
        if (body.workspace) {
          try {
            workspace = validateWorkspace(body.workspace);
          } catch (err) {
            return fail(res, 400, `工作区不可用：${err.message}`);
          }
        }

        const roles = listRoles();
        const result = await plan({ goal, roles, extra: body.extra, workspace });

        const job = {
          id: newId('job'),
          title: result.plan.title,
          goal,
          workspace,
          status: 'PLANNED',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          plan: result.plan,
          planMeta: { model: result.model, usage: result.usage },
          runs: [],
          summary: null,
          history: [{ at: Date.now(), action: 'plan', note: '初次规划' }],
        };
        saveJob(job);
        return ok(res, job);
      }

      // ---- 单个任务 ----
      const jobMatch = p.match(/^\/api\/jobs\/([^/]+)(\/.*)?$/);
      if (jobMatch) {
        const jobId = decodeURIComponent(jobMatch[1]);
        const sub = jobMatch[2] || '';

        if (!sub && req.method === 'GET') {
          const job = getJob(jobId);
          if (!job) return fail(res, 404, '任务不存在');
          return ok(res, { ...job, running: isRunning(jobId) });
        }

        if (!sub && req.method === 'DELETE') {
          if (isRunning(jobId)) return fail(res, 409, '任务正在执行，请先取消');
          return ok(res, { removed: deleteJob(jobId) });
        }

        if (sub === '/replan' && req.method === 'POST') {
          const job = getJob(jobId);
          if (!job) return fail(res, 404, '任务不存在');
          if (isRunning(jobId)) return fail(res, 409, '任务正在执行，无法重新规划');
          const body = await readBody(req);
          const roles = listRoles();
          const result = await plan({ goal: job.goal, roles, extra: body.extra, workspace: job.workspace });
          job.plan = result.plan;
          job.title = result.plan.title;
          job.status = 'PLANNED';
          job.runs = [];
          job.summary = null;
          job.planMeta = { model: result.model, usage: result.usage };
          job.history = job.history || [];
          job.history.push({ at: Date.now(), action: 'replan', note: String(body.extra || '').slice(0, 200) });
          saveJob(job);
          return ok(res, job);
        }

        if (sub === '/plan' && req.method === 'PATCH') {
          const job = getJob(jobId);
          if (!job) return fail(res, 404, '任务不存在');
          if (isRunning(jobId)) return fail(res, 409, '任务正在执行，无法修改分工');
          const body = await readBody(req);
          const roles = listRoles();
          job.plan = normalizePlan(body.plan || body, roles, job.goal);
          job.title = job.plan.title;
          job.status = 'PLANNED';
          job.runs = [];
          job.summary = null;
          job.history = job.history || [];
          job.history.push({ at: Date.now(), action: 'edit', note: '手工调整分工' });
          saveJob(job);
          return ok(res, job);
        }

        if (sub === '/execute' && req.method === 'POST') {
          const job = getJob(jobId);
          if (!job) return fail(res, 404, '任务不存在');
          if (isRunning(jobId)) return fail(res, 409, '已经在执行了');
          if (!job.plan?.tasks?.length) return fail(res, 400, '还没有分工方案，先规划');
          startExecution(job, listRoles());
          return ok(res, { started: true, jobId });
        }

        if (sub === '/cancel' && req.method === 'POST') {
          const done = cancel(jobId);
          if (!done) return fail(res, 409, '当前没有在执行');
          return ok(res, { cancelled: true });
        }

        if (sub === '/events' && req.method === 'GET') {
          return sseHandler(req, res, jobId);
        }

        if (sub === '/layers' && req.method === 'GET') {
          const job = getJob(jobId);
          if (!job) return fail(res, 404, '任务不存在');
          return ok(res, computeLayers(job.plan.tasks));
        }

        if (sub === '/export' && req.method === 'GET') {
          const job = getJob(jobId);
          if (!job) return fail(res, 404, '任务不存在');
          const md = toMarkdown(job, listRoles());
          const filename = encodeURIComponent(`${job.title || 'task'}.md`);
          res.writeHead(200, {
            'Content-Type': 'text/markdown; charset=utf-8',
            'Content-Disposition': `attachment; filename*=UTF-8''${filename}`,
          });
          return res.end(md);
        }
      }

      return fail(res, 404, `接口不存在：${req.method} ${p}`);
    }

    // ---- 静态资源 ----
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, p);
    return res.writeHead(405).end('method not allowed');
  } catch (err) {
    console.error(`[api] ${req.method} ${p} 出错:`, err.message);
    return fail(res, 500, err.message || '服务内部错误');
  }
});

server.requestTimeout = 30 * 60 * 1000; // 规划/执行可能很久
server.headersTimeout = 30 * 60 * 1000;

server.listen(config.port, config.host, () => {
  const roles = listRoles();
  console.log('');
  console.log('  总控台 AI Orchestrator');
  console.log('  ────────────────────────────────────────');
  console.log(`  服务地址   http://${config.host}:${config.port}`);
  console.log(`  模型       规划 ${config.planModel} / 汇总 ${config.summaryModel}`);
  console.log(`              ${config.modelFast} / ${config.modelStrong}（执行）`);
  console.log(`  接口       ${config.baseUrl}`);
  console.log(`  密钥       ${config.apiKey ? '已配置' : '未配置（请设置 DEEPSEEK_API_KEY）'}`);
  console.log(`  角色       ${roles.length} 个`);
  console.log(`  并发       ${config.concurrency}`);
  console.log('  ────────────────────────────────────────');
  console.log('');
  if (!config.apiKey) {
    console.error('  [!] 没有检测到模型密钥，规划和执行都会失败。');
    console.error('      请设置环境变量 DEEPSEEK_API_KEY 后重启。');
    console.error('');
  }
});

process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err?.message || err);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err?.message || err);
});
