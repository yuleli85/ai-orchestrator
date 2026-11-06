import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { stream } from './llm.js';
import { computeLayers } from './planner.js';
import { findRole } from './roles.js';
import { saveJob } from './store.js';
import { execute as devExecute } from './devagent.js';
import { diagnose as archDiagnose } from './archagent.js';

/**
 * 执行引擎。
 *
 * 三个产品决策：
 * 1. 按依赖分层，层内并发 —— 没有依赖的任务必须同时跑，否则这个系统没有意义；
 * 2. 每个任务只拿到「自己需要的东西」：任务卡 + 上游产出 + 兄弟任务标题。
 *    把全部上下文塞给它会让模型跑偏，只给它任务卡又会让它重复别人的活；
 * 3. 单个任务失败不拖垮全局：标 FAILED 并继续，汇总时把失败项列出来，
 *    因为"6 个成功 + 1 个失败"比"整体失败"有用得多。
 */

const running = new Map(); // jobId -> { emitter, abort, cancelled }

function commonRules() {
  return `【通用工作准则】
- 直接给交付物。不要写"好的，我来帮你"、"以下是..."这类开场白。
- 不要复述任务要求，读者已经知道要什么。
- 不确定的地方按最合理的方式假设，并在开头用一行「> 假设：…」注明，不要停下来反问。
- 用 Markdown 输出，结构清晰，能被直接拿去用。
- 涉及数字、路径、接口、代码时给具体的，不给占位符。`;
}

/** 表格单元格转义：证据里常带 | 和换行，不处理会把表格撑坏 */
function cell(s) {
  return String(s || '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
}

/** 把架构诊断结果转成一份自包含的 Markdown，供下游任务和汇总使用 */
function formatArchReport(task, d) {
  const L = [];
  const sevCn = { high: '严重', medium: '中等', low: '轻微' };
  const riskCn = { high: '高', medium: '中', low: '低' };

  L.push(`## ${task.title}`);
  L.push('');
  L.push(`> 形态判断：**${d.asIs.style}**　（基于对工作区 ${d.profile?.stats?.codeFiles || 0} 个源码文件、${d.profile?.stats?.sourceLines || 0} 行的实际扫描）`);
  L.push('');
  L.push(d.summary);
  L.push('');

  if (d.asIs.structure) {
    L.push('### 现状：代码是怎么组织的');
    L.push(d.asIs.structure);
    L.push('');
  }
  if (d.asIs.dataFlow) {
    L.push('### 关键数据流');
    L.push(d.asIs.dataFlow);
    L.push('');
  }
  if (d.asIs.strengths?.length) {
    L.push('### 值得保留的部分');
    d.asIs.strengths.forEach((s) => L.push(`- ${s}`));
    L.push('');
  }

  if (d.issues?.length) {
    L.push(`### 发现的问题（${d.issues.length}）`);
    L.push('');
    L.push('| 严重程度 | 问题 | 证据 | 实际影响 |');
    L.push('|---|---|---|---|');
    for (const i of d.issues) {
      L.push(`| ${sevCn[i.severity] || i.severity} | ${cell(i.title)} | ${cell(i.evidence)} | ${cell(i.impact)} |`);
    }
    L.push('');
  }

  if (d.options?.length) {
    L.push('### 候选方案');
    L.push('');
    for (const o of d.options) {
      const rec = o.id === d.recommendation?.optionId ? '（推荐）' : '';
      L.push(`#### 方案 ${o.id}：${o.name}${rec}`);
      L.push('');
      L.push(o.summary);
      L.push('');
      if (o.changes?.length) {
        L.push('**改什么**');
        o.changes.forEach((c) => L.push(`- ${c}`));
        L.push('');
      }
      if (o.pros?.length) {
        L.push('**好处**');
        o.pros.forEach((c) => L.push(`- ${c}`));
        L.push('');
      }
      if (o.cons?.length) {
        L.push('**代价**');
        o.cons.forEach((c) => L.push(`- ${c}`));
        L.push('');
      }
      L.push(`> 工作量：${o.effort || '未估'}　风险：${riskCn[o.risk] || o.risk}　适用：${o.fit || '—'}`);
      L.push('');
    }
  }

  if (d.recommendation?.why) {
    L.push('### 推荐结论');
    L.push(`选 **方案 ${d.recommendation.optionId}**：${d.recommendation.why}`);
    L.push('');
  }

  if (d.openQuestions?.length) {
    L.push('### 需要确认的前提');
    d.openQuestions.forEach((q) => L.push(`- ${q}`));
    L.push('');
  }

  return L.join('\n').trim();
}

function taskSystemPrompt(role) {
  return `${role.persona}

${commonRules()}`;
}

function taskUserPrompt({ job, task, roles, outputs }) {
  const role = findRole(roles, task.roleId);
  const upstream = (task.dependsOn || [])
    .map((id) => {
      const t = job.plan.tasks.find((x) => x.id === id);
      const out = outputs.get(id);
      if (!t || !out) return null;
      const clip = out.length > config.upstreamClip ? `${out.slice(0, config.upstreamClip)}\n\n…（上游产出过长已截断）` : out;
      return `### ${t.id} · ${findRole(roles, t.roleId)?.name || t.roleId} · ${t.title}\n\n${clip}`;
    })
    .filter(Boolean);

  const siblings = job.plan.tasks
    .filter((t) => t.id !== task.id && !(task.dependsOn || []).includes(t.id))
    .map((t) => `- ${t.id} ${t.title}（${findRole(roles, t.roleId)?.name || t.roleId}）`);

  const parts = [
    `【整体目标】\n${job.goal}`,
    job.plan.understanding ? `【总控对任务的理解】\n${job.plan.understanding}` : '',
    `【你的子任务：${task.title}】\n角色：${role?.name || task.roleId}\n目标：${task.objective}\n已知输入：${task.input}\n产出要求：${task.deliverable}\n验收标准：\n${task.acceptance.map((a) => `- ${a}`).join('\n')}`,
  ];

  if (upstream.length) parts.push(`【上游产出（直接基于它继续做，不要重复它的内容）】\n${upstream.join('\n\n')}`);
  if (siblings.length) parts.push(`【团队里还有人在并行做这些，你不要越界重复】\n${siblings.join('\n')}`);

  parts.push('现在开始交付。');
  return parts.filter(Boolean).join('\n\n');
}

function summaryPrompt(job, roles) {
  const blocks = job.plan.tasks.map((t) => {
    const run = (job.runs || []).find((r) => r.taskId === t.id);
    const role = findRole(roles, t.roleId);
    if (!run || run.status !== 'DONE') {
      return `### ${t.id} · ${role?.name || t.roleId} · ${t.title}\n\n（该子任务未成功完成：${run?.error || '未执行'}）`;
    }
    const clip = run.output.length > 12000 ? `${run.output.slice(0, 12000)}\n\n…（已截断）` : run.output;
    return `### ${t.id} · ${role?.name || t.roleId} · ${t.title}\n\n${clip}`;
  });

  return `你是总控台。你的团队刚完成一个任务的拆分执行，现在把所有人的产出合并成一份可以直接交付的成果。

【原始目标】
${job.goal}

【总控的理解】
${job.plan.understanding}

${job.plan.assumptions?.length ? `【已做的假设】\n${job.plan.assumptions.map((a) => `- ${a}`).join('\n')}\n` : ''}
【各子任务产出】
${blocks.join('\n\n')}

【合并要求】
1. 按「用户拿到能直接用」的顺序组织，不要按子任务顺序机械堆叠。
2. 去掉重复内容。发现冲突时，以更具体、更可执行的为准，并在末尾「需要你确认的分歧」里列出。
3. 补上子任务之间的衔接，读起来要像一个人写的，不要出现"如 T2 所述"这类内部编号。
4. 开头给 3~5 行结论要点，让人 10 秒内知道结果。
5. 保留关键细节（数字、路径、代码、接口），不要为了简洁丢掉可执行信息。
6. 用 Markdown。不要写"以下是汇总"这类废话开场。
7. 如果有子任务失败了，在末尾单独一节说明缺哪块、对整体有什么影响。`;
}

async function runPool(items, limit, worker) {
  const queue = [...items];
  const n = Math.max(1, Math.min(limit, queue.length));
  const runners = Array.from({ length: n }, async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/**
 * 工作区串行锁。
 * 同一层里可能有多个 dev 任务，它们改的是同一批文件——并行跑必然互相覆盖。
 * 所以按工作区排队：其它角色照常并行，只有真要写盘的任务排队。
 */
const wsQueues = new Map();

function withWorkspaceLock(workspace, fn) {
  const prev = wsQueues.get(workspace) || Promise.resolve();
  const next = prev.then(fn, fn);
  wsQueues.set(
    workspace,
    next.then(
      () => {},
      () => {},
    ),
  );
  return next;
}

/** 把开发任务的结果整理成可读的交付段落（会进汇总） */
function formatDevReport(r) {
  const lines = [];
  lines.push(`> 工作区：已在项目目录内实际改动，共 ${r.changes.length} 个文件、执行 ${r.commands.length} 条命令。`);
  lines.push('');
  lines.push('## 改动文件');
  if (!r.changes.length) lines.push('（没有产生文件改动）');
  for (const c of r.changes) {
    lines.push(`- ${c.action === 'create' ? '新建' : '修改'} \`${c.path}\`${c.lines ? `（${c.lines} 行）` : ''}`);
  }
  lines.push('');
  lines.push('## 执行过的命令');
  if (!r.commands.length) lines.push('（没有执行命令，未能验证）');
  for (const c of r.commands) {
    lines.push(`- ${c.ok ? '通过' : c.blocked ? '被拒绝' : '失败'}：\`${c.command}\`${c.exitCode != null ? `（exit ${c.exitCode}，${(c.durationMs / 1000).toFixed(1)}s）` : ''}`);
  }
  lines.push('');
  lines.push('## 实现说明');
  lines.push(r.summary || '（模型未给出说明）');
  lines.push('');
  lines.push('## 自测结论');
  lines.push(r.verification || '（未提供）');
  if (r.remaining && r.remaining !== '无') {
    lines.push('');
    lines.push('## 遗留问题');
    lines.push(r.remaining);
  }
  return lines.join('\n');
}

export function getRunning(jobId) {
  return running.get(jobId) || null;
}

export function subscribe(jobId, fn) {
  const ctx = running.get(jobId);
  if (!ctx) return () => {};
  ctx.emitter.on('event', fn);
  return () => ctx.emitter.off('event', fn);
}

export function isRunning(jobId) {
  return running.has(jobId);
}

export function cancel(jobId) {
  const ctx = running.get(jobId);
  if (!ctx) return false;
  ctx.cancelled = true;
  ctx.abort.abort();
  return true;
}

/**
 * 启动执行。立即返回，进度通过事件推送。
 */
export function startExecution(job, roles) {
  if (running.has(job.id)) throw new Error('这个任务正在执行中');

  const emitter = new EventEmitter();
  const abort = new AbortController();
  const ctx = { emitter, abort, cancelled: false };
  running.set(job.id, ctx);

  const emit = (type, data) => {
    try {
      emitter.emit('event', { type, at: Date.now(), ...data });
    } catch (err) {
      console.error('[executor] emit 失败:', err.message);
    }
  };

  (async () => {
    const outputs = new Map();
    job.status = 'RUNNING';
    job.startedAt = Date.now();
    job.error = null;
    job.runs = job.plan.tasks.map((t) => ({
      taskId: t.id,
      status: 'PENDING',
      attempt: 0,
      output: '',
      error: null,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      usage: null,
      changes: [],
      commands: [],
    }));
    saveJob(job);
    emit('job:start', { status: 'RUNNING' });

    const layers = computeLayers(job.plan.tasks);
    emit('job:layers', { layers: layers.map((l) => ({ level: l.level, taskIds: l.tasks.map((t) => t.id) })) });

    try {
      for (const layer of layers) {
        if (ctx.cancelled) break;
        emit('layer:start', { level: layer.level, taskIds: layer.tasks.map((t) => t.id) });

        await runPool(layer.tasks, config.concurrency, async (task) => {
          if (ctx.cancelled) return;
          const run = job.runs.find((r) => r.taskId === task.id);
          const role = findRole(roles, task.roleId);
          const model = role?.tools
            ? config.devModel
            : role?.tier === 'strong'
              ? config.modelStrong
              : config.modelFast;

          let lastErr = null;
          for (let attempt = 1; attempt <= config.taskRetries; attempt++) {
            if (ctx.cancelled) break;
            run.status = 'RUNNING';
            run.attempt = attempt;
            run.startedAt = Date.now();
            run.error = null;
            saveJob(job);
            emit('task:start', { taskId: task.id, attempt, model, roleName: role?.name });

            try {
              let content = '';
              let usage = null;

              if (role?.tools && job.workspace) {
                /* ---- 开发任务：走工具循环，在工作区里真改代码 ---- */
                emit('task:dev', { taskId: task.id, evt: { type: 'dev:status', status: 'RUNNING' } });
                const backupDir = path.resolve(process.cwd(), config.dataDir, 'dev-runs', `${job.id}__${task.id}`, 'backup');
                fs.mkdirSync(backupDir, { recursive: true });

                const devRes = await withWorkspaceLock(job.workspace, () =>
                  devExecute({
                    workspace: job.workspace,
                    task: [
                      task.title,
                      `目标：${task.objective}`,
                      `产出要求：${task.deliverable}`,
                      `验收标准：\n${(task.acceptance || []).map((a) => `- ${a}`).join('\n')}`,
                      `整体背景：${job.goal}`,
                      task.input ? `已知信息：${task.input}` : '',
                    ]
                      .filter(Boolean)
                      .join('\n'),
                    design: {
                      understanding: job.plan.understanding || '',
                      approach: [task.objective],
                      files: [],
                      steps: [task.deliverable],
                      verify: ['按验收标准自行验证'],
                    },
                    emit: (evt) => {
                      emit('task:dev', { taskId: task.id, evt });
                      // 把关键动作实时写进任务卡：不然用户盯着卡片几十秒没有任何变化
                      if (evt.type === 'dev:file') {
                        emit('task:delta', {
                          taskId: task.id,
                          text: `${evt.action === 'create' ? '新建' : '修改'} ${evt.path}\n`,
                        });
                      } else if (evt.type === 'dev:cmd') {
                        emit('task:delta', {
                          taskId: task.id,
                          text: `$ ${evt.command}\n  → ${evt.ok ? 'exit 0' : evt.blocked ? '被拒绝' : `exit ${evt.exitCode}`}（${((evt.durationMs || 0) / 1000).toFixed(1)}s）\n`,
                        });
                      }
                    },
                    signal: abort.signal,
                    backupDir,
                  }),
                );

                content = formatDevReport(devRes);
                usage = devRes.usage;
                run.changes = devRes.changes;
                run.commands = devRes.commands;
                emit('task:delta', { taskId: task.id, text: content });
              } else if (role?.scan && job.workspace) {
                /* ---- 架构任务：先真的扫一遍代码再下判断 ----
                   不这么做的话，架构师只能凭任务描述写一段看起来专业、实际和代码无关的文字。 */
                emit('task:delta', { taskId: task.id, text: '正在扫描代码结构（模块边界、依赖方向、循环依赖）…\n' });

                const diag = await archDiagnose({
                  workspace: job.workspace,
                  goal: [
                    task.title,
                    `目标：${task.objective}`,
                    `产出要求：${task.deliverable}`,
                    `整体背景：${job.goal}`,
                  ]
                    .filter(Boolean)
                    .join('\n'),
                  emit: (evt) => {
                    if (evt.type === 'arch:scan:done') {
                      const s = evt.profile?.stats || {};
                      emit('task:delta', {
                        taskId: task.id,
                        text: `扫描完成：${s.codeFiles || 0} 个源码文件 / ${s.sourceLines || 0} 行${
                          evt.profile?.cycles?.length ? `，发现 ${evt.profile.cycles.length} 处循环依赖` : ''
                        }\n`,
                      });
                    } else if (evt.type === 'arch:diagnose:done') {
                      emit('task:delta', {
                        taskId: task.id,
                        text: `诊断完成：${evt.diagnosis.issues.length} 个问题 / ${evt.diagnosis.options.length} 个候选方案\n`,
                      });
                    }
                  },
                  signal: abort.signal,
                  model: config.archModel,
                });

                content = formatArchReport(task, diag);
                usage = diag.usage;
                emit('task:delta', { taskId: task.id, text: content });
              } else {
                /* ---- 其它角色：产出文字交付物 ---- */
                // 重试时把预算翻倍：上一次如果是被 max_tokens 截断，原样重跑只会再失败一次
                const budget = attempt === 1 ? config.maxTokensTask : Math.min(config.maxTokensTask * 2, 32000);
                const res = await stream({
                  model,
                  system: taskSystemPrompt(role || { persona: '', name: task.roleId }),
                  user: taskUserPrompt({ job, task, roles, outputs }),
                  maxTokens: budget,
                  temperature: 0.6,
                  signal: abort.signal,
                  onDelta: (t) => emit('task:delta', { taskId: task.id, text: t }),
                  onReasoning: (t) => emit('task:reasoning', { taskId: task.id, text: t }),
                });

                if (!res.content.trim()) {
                  throw new Error(
                    res.finishReason === 'length'
                      ? '输出被 max_tokens 截断，正文为空'
                      : '模型返回空正文',
                  );
                }
                content = res.content.trim();
                usage = res.usage;
              }

              run.status = 'DONE';
              run.output = content;
              run.usage = usage;
              run.finishedAt = Date.now();
              run.durationMs = run.finishedAt - run.startedAt;
              outputs.set(task.id, run.output);
              saveJob(job);
              emit('task:done', {
                taskId: task.id,
                output: run.output,
                durationMs: run.durationMs,
                usage,
                chars: run.output.length,
                changes: run.changes || [],
                commands: run.commands || [],
              });
              lastErr = null;
              break;
            } catch (err) {
              lastErr = err;
              const aborted = ctx.cancelled || err.name === 'AbortError';
              run.error = err.message;
              run.finishedAt = Date.now();
              if (aborted) {
                run.status = 'FAILED';
                run.error = '已取消';
                saveJob(job);
                emit('task:error', { taskId: task.id, error: '已取消' });
                return;
              }
              if (attempt < config.taskRetries) {
                emit('task:retry', { taskId: task.id, attempt, error: err.message });
                await new Promise((r) => setTimeout(r, 1200));
              } else {
                run.status = 'FAILED';
                saveJob(job);
                emit('task:error', { taskId: task.id, error: err.message });
              }
            }
          }
        });
      }

      if (ctx.cancelled) {
        job.status = 'CANCELLED';
        saveJob(job);
        emit('job:done', { status: 'CANCELLED' });
        return;
      }

      // 汇总
      const okCount = job.runs.filter((r) => r.status === 'DONE').length;
      if (okCount === 0) {
        job.status = 'FAILED';
        job.error = '所有子任务都失败了，跳过汇总';
        saveJob(job);
        emit('job:done', { status: 'FAILED', error: job.error });
        return;
      }

      emit('summary:start', {});
      let summaryText = '';
      try {
        const res = await stream({
          model: config.summaryModel,
          system: '你是总控台，负责把团队产出合并成一份可直接交付的成果。你的文字要干净、有信息量、没有废话。',
          user: summaryPrompt(job, roles),
          maxTokens: config.maxTokensSummary,
          temperature: 0.4,
          effort: config.summaryEffort || undefined,
          signal: abort.signal,
          onDelta: (t) => {
            summaryText += t;
            emit('summary:delta', { text: t });
          },
        });
        job.summary = {
          content: res.content.trim() || summaryText.trim(),
          createdAt: Date.now(),
          model: res.model,
          usage: res.usage,
        };
        emit('summary:done', { content: job.summary.content });
      } catch (err) {
        job.summary = {
          content: `汇总失败：${err.message}\n\n各子任务产出仍可在任务卡中查看。`,
          createdAt: Date.now(),
          failed: true,
        };
        emit('summary:error', { error: err.message });
      }

      job.status = job.runs.every((r) => r.status === 'DONE') ? 'DONE' : 'PARTIAL';
      job.finishedAt = Date.now();
      saveJob(job);
      emit('job:done', { status: job.status });
    } catch (err) {
      job.status = 'FAILED';
      job.error = err.message;
      job.finishedAt = Date.now();
      saveJob(job);
      emit('job:done', { status: 'FAILED', error: err.message });
    } finally {
      running.delete(job.id);
      setTimeout(() => emitter.removeAllListeners(), 60000).unref?.();
    }
  })();

  return { ok: true };
}
