import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { PRESET_ROLES } from './roles.js';

/**
 * 单文件 JSON 存储。
 *
 * 为什么不上数据库：这个工具的数据量是「几十个任务 + 十来个角色」，
 * 引数据库只会让部署多一步。真要上量，把这一层换掉即可，上层无感。
 *
 * 写盘用「写临时文件 + rename」保证原子性，避免进程被杀时留下半个 JSON。
 */

const DIR = path.resolve(process.cwd(), config.dataDir);
const FILE = path.join(DIR, 'state.json');

const EMPTY = { version: 1, roles: [], jobs: [] };

let state = null;
let writeQueue = Promise.resolve();

function ensureDir() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
}

function load() {
  if (state) return state;
  ensureDir();
  if (!fs.existsSync(FILE)) {
    state = structuredClone(EMPTY);
    return state;
  }
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const parsed = JSON.parse(raw);
    state = {
      version: parsed.version || 1,
      roles: Array.isArray(parsed.roles) ? parsed.roles : [],
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
    };
  } catch (err) {
    // 文件坏了不要直接崩，备份一份再从空库起步
    const bad = `${FILE}.broken-${Date.now()}`;
    try {
      fs.copyFileSync(FILE, bad);
    } catch {
      /* ignore */
    }
    console.error(`[store] state.json 解析失败，已备份到 ${bad}：${err.message}`);
    state = structuredClone(EMPTY);
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
          console.error('[store] 写盘失败:', err.message);
        }
        resolve();
      }),
  );
  return writeQueue;
}

/* ---------------- 角色 ---------------- */

export function listRoles() {
  const s = load();
  // 预置角色始终在，自定义角色可覆盖同 id 的预置项
  const map = new Map(PRESET_ROLES.map((r) => [r.id, { ...r, builtin: true }]));
  for (const r of s.roles) map.set(r.id, { ...r, builtin: false });
  return [...map.values()];
}

export function upsertRole(role) {
  const s = load();
  const id = String(role.id || '').trim();
  if (!id) throw new Error('角色 id 不能为空');
  const clean = {
    id,
    name: String(role.name || id).trim(),
    badge: String(role.badge || role.name || '?').slice(0, 1),
    color: /^#[0-9a-fA-F]{3,8}$/.test(role.color || '') ? role.color : '#6366f1',
    tier: role.tier === 'strong' ? 'strong' : 'fast',
    summary: String(role.summary || '').slice(0, 200),
    persona: String(role.persona || '').slice(0, 2000),
    // 自定义角色也可以声明"要真的动手写代码"
    tools: role.tools === true,
    scan: role.scan === true,
  };
  const idx = s.roles.findIndex((r) => r.id === id);
  if (idx >= 0) s.roles[idx] = clean;
  else s.roles.push(clean);
  persist();
  return clean;
}

export function deleteRole(id) {
  const s = load();
  const before = s.roles.length;
  s.roles = s.roles.filter((r) => r.id !== id);
  const removed = s.roles.length !== before;
  if (removed) persist();
  return removed;
}

/* ---------------- 任务 ---------------- */

export function listJobs({ limit = 50 } = {}) {
  const s = load();
  return [...s.jobs]
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, limit)
    .map((j) => ({
      id: j.id,
      title: j.title,
      goal: j.goal,
      status: j.status,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
      taskCount: j.plan?.tasks?.length || 0,
      doneCount: (j.runs || []).filter((r) => r.status === 'DONE').length,
      roleIds: [...new Set((j.plan?.tasks || []).map((t) => t.roleId))],
    }));
}

export function getJob(id) {
  const s = load();
  return s.jobs.find((j) => j.id === id) || null;
}

export function saveJob(job) {
  const s = load();
  const idx = s.jobs.findIndex((j) => j.id === job.id);
  job.updatedAt = Date.now();
  if (idx >= 0) s.jobs[idx] = job;
  else s.jobs.unshift(job);
  // 只保留最近 200 个任务，避免 JSON 无限膨胀
  if (s.jobs.length > 200) s.jobs.length = 200;
  persist();
  return job;
}

export function deleteJob(id) {
  const s = load();
  const before = s.jobs.length;
  s.jobs = s.jobs.filter((j) => j.id !== id);
  const removed = s.jobs.length !== before;
  if (removed) persist();
  return removed;
}

export function newId(prefix) {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 6);
  return `${prefix}_${t}${r}`;
}
