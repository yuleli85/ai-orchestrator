import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { complete, extractJson } from './llm.js';
import { checkCommand, editFile, listTree, readFile, resolveSafe, runCommand, searchContent, treeText, writeFile } from './sandbox.js';

/**
 * 开发智能体。
 *
 * 和"会说话的角色"最大的区别：它真的动文件、真的跑命令、真的自己验证。
 *
 * 两阶段设计（必须分两阶段，不能一步到底）：
 * 1. design —— 先读工作区、出实施方案（改哪些文件、怎么改、怎么验），
 *    交给人看一眼。跳过这步直接写代码，一旦方向错就是一堆白改的文件。
 * 2. execute —— 工具循环：读 → 写 → 跑 → 看报错 → 再改，直到自测通过。
 *
 * 工具循环里最重要的一个决策：工具报错不抛异常，而是作为工具结果回喂给模型。
 * 只有让模型看见 "找不到要替换的片段"，它才会自己去 read_file 确认原文，
 * 这才是"会干活"，而不是"一遇错就整轮失败"。
 */

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: '列出工作区目录结构。第一次接触项目时先调这个，不要凭猜测假设文件存在。',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: '相对工作区的目录，根目录传 "."' },
          depth: { type: 'integer', description: '递归深度，默认 2，最大 6' },
        },
        required: ['dir'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取文件完整内容。修改任何文件之前必须先读它，否则会破坏原有代码。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '相对工作区的文件路径' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search',
      description: '在工作区所有文本文件里按正则搜索，返回 文件:行号: 内容。找定义、找引用、确认命名时用。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '正则表达式' },
          glob: { type: 'string', description: '可选，文件名通配，如 "*.java" 或 "*.ts"' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '写入文件全文（不存在则创建，存在则覆盖）。用于新建文件或整体重写。覆盖会自动备份。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区的文件路径' },
          content: { type: 'string', description: '完整文件内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: '局部替换文件中的一段文本。改已有文件优先用这个，不要整文件重写。old_string 必须在文件里唯一且完全一致（含缩进）。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string', description: '要被替换的原文，必须唯一' },
          new_string: { type: 'string', description: '替换后的内容' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: '在工作区根目录执行命令，返回退出码和输出。用于构建、跑测试、装依赖、看 git 状态。命令有白名单，破坏性操作会被拒绝。',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: '完整命令行' } },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: '声明任务完成。必须真的跑过验证命令并看到通过，才能调用这个工具。',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '做了什么，改了哪些文件，按条目写' },
          verification: { type: 'string', description: '跑了什么验证命令，结果如何（贴关键输出）' },
          remaining: { type: 'string', description: '没做完或需要人确认的部分，没有就写"无"' },
        },
        required: ['summary', 'verification'],
      },
    },
  },
];

function devSystemPrompt() {
  return `你是开发工程师，负责在工作区里真正把代码改出来。你不是顾问，只出方案不写代码是不合格的。

【工作纪律】
1. 先看再写。动手前先 list_files 看结构，改任何已有文件前先 read_file 读全文。凭想象写 import 和 API 是最常见的失败原因。
2. 小步推进。一次只做一件事：先写一个文件、跑一次验证、看结果，再进下一步。不要一口气写十几个文件然后祈祷它能跑。
3. 必须验证。写完代码要用 run_command 真的跑起来（构建 / 测试 / 执行脚本）。没跑过就说"已完成"是不允许的。
4. 自己修错。命令报错时先读懂错误信息，定位到文件和行，改掉再重跑。连续 3 次修不好就停下来，把错误原文和你的判断写进 finish 的 remaining，不要无限重试。
5. 保持风格。新代码沿用项目现有的命名、目录结构、缩进和依赖。不要为了写一个函数引入新的第三方库。
6. 不留半成品。不要写 TODO、占位实现、"此处后续补全"。做不到就说做不到。
7. 边界自查。测试是你自己写的，很容易只覆盖你实现的那条路径。写完之后额外用几个"写测试时没想到的"输入跑一遍：
   空字符串、刚好等于边界值、边界值 ±1、参数传 null。发现输出反直觉就改代码，不要改测试去迁就实现。

【禁止事项】
- 不要删除或重写与任务无关的文件。
- 不要修改 package.json 的依赖版本、不要升级框架，除非任务明确要求。
- 不要在代码里留下调试输出、注释掉的旧代码、或者是假的 mock 数据冒充实现。
- 不要执行 git push / 删库 / 格式化这类操作（也会被系统拦掉）。

【输出】
- 正文用简短中文说明你现在要做什么，一两句即可，不要长篇解释设计理念。
- 代码一律通过 write_file / edit_file 落到文件里，不要在正文里贴大段代码——正文里的代码不会被执行，等于没做。`;
}

function designPrompt({ workspace, task, tree, manifests }) {
  return `你要为一个开发任务制定实施方案。现在只是方案阶段，不会真的改文件。

【工作区】${workspace}
【目录结构】
${tree}

${manifests.length ? `【关键文件内容】\n${manifests.map((m) => `--- ${m.path} ---\n${m.content}`).join('\n\n')}\n` : ''}
【开发任务】
${task}

【要求】
输出一个 JSON 对象（不要包 markdown 代码块，不要任何解释文字）：
{
  "understanding": "用两句话说明这个任务要达成什么，以及你从代码里看到的现状",
  "approach": "技术方案要点，3~6 条，每条一句话。说明关键取舍",
  "files": [{"path": "相对路径", "action": "create|modify", "purpose": "这个文件要做什么，一句话"}],
  "steps": ["实施步骤，按顺序，每条是一个可执行的动作"],
  "verify": ["验证命令，必须是真的能跑的命令，如 npm test / mvn -q compile"],
  "risks": ["可能会踩的坑，没有就给空数组"],
  "scale": "small|medium|large"
}

要求：
- files 必须具体到路径。不要写"若干相关文件"。
- steps 控制在 8 条以内，每条都要能对应到 files 里的某个文件或某次验证。
- 如果任务信息不足以定方案，在 understanding 里写清缺什么，不要编造。
- 规模控制在能一次验证通过的范围，宁可小也不要大。`;
}

const MANIFEST_NAMES = ['package.json', 'pom.xml', 'build.gradle', 'requirements.txt', 'go.mod', 'Cargo.toml', 'README.md', 'tsconfig.json'];

function readManifests(workspace) {
  const out = [];
  for (const name of MANIFEST_NAMES) {
    const full = path.join(workspace, name);
    if (!fs.existsSync(full)) continue;
    try {
      const st = fs.statSync(full);
      if (st.size > 20000) continue;
      out.push({ path: name, content: fs.readFileSync(full, 'utf8') });
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** 设计阶段：只读 + 出方案，不动任何文件 */
export async function design({ workspace, task, emit, signal, model }) {
  const tree = treeText(workspace, { depth: 2, maxEntries: 200 });
  const manifests = readManifests(workspace);

  emit?.({ type: 'dev:design:start' });

  const res = await complete({
    model: model || config.devDesignModel,
    system: '你是资深技术负责人，负责给开发任务定实施方案。你的方案必须具体到文件和命令，让人照着就能做。只输出 JSON。',
    user: designPrompt({ workspace, task, tree, manifests }),
    maxTokens: 4000,
    temperature: 0.3,
    effort: 'low',
    signal,
  });

  let raw;
  try {
    raw = extractJson(res.content);
  } catch (err) {
    throw new Error(`方案解析失败：${err.message}。模型输出前 300 字：${String(res.content).slice(0, 300)}`);
  }

  const design = {
    understanding: String(raw.understanding || '').trim(),
    approach: Array.isArray(raw.approach) ? raw.approach.map(String) : String(raw.approach || '').split('\n').filter(Boolean),
    files: Array.isArray(raw.files)
      ? raw.files
          .filter((f) => f && f.path)
          .map((f) => ({
            path: String(f.path),
            action: f.action === 'create' ? 'create' : 'modify',
            purpose: String(f.purpose || ''),
          }))
      : [],
    steps: Array.isArray(raw.steps) ? raw.steps.map(String) : [],
    verify: Array.isArray(raw.verify) ? raw.verify.map(String) : [],
    risks: Array.isArray(raw.risks) ? raw.risks.map(String) : [],
    scale: ['small', 'medium', 'large'].includes(raw.scale) ? raw.scale : 'medium',
    model: res.model,
    usage: res.usage,
    tree,
  };

  emit?.({ type: 'dev:design:done', design });
  return design;
}

/* ---------------- 工具分发 ---------------- */

function toolResultText(r) {
  if (r == null) return '（无返回）';
  if (typeof r === 'string') return r;
  return JSON.stringify(r);
}

async function execTool(name, args, ctx) {
  const { workspace, backupDir, changes, commands } = ctx;

  switch (name) {
    case 'list_files': {
      const dir = String(args.dir || '.');
      const depth = Math.max(0, Math.min(6, Number(args.depth ?? 2)));
      if (dir === '.' || dir === './' || dir === '') {
        return treeText(workspace, { depth, maxEntries: 400 });
      }
      const full = resolveSafe(workspace, dir);
      if (!fs.existsSync(full)) throw new Error(`目录不存在：${dir}`);
      const rel = path.relative(workspace, full).replace(/\\/g, '/');
      return `${rel}/\n${treeText(full, { depth, maxEntries: 300 })}`;
    }

    case 'read_file': {
      const p = String(args.path || '');
      return readFile(workspace, p);
    }

    case 'search': {
      const hits = searchContent(workspace, String(args.pattern || ''), { glob: args.glob ? String(args.glob) : '' });
      if (!hits.length) return '没有匹配结果。换个更短的关键词，或者先 list_files 看结构。';
      return hits.join('\n');
    }

    case 'write_file': {
      const p = String(args.path || '');
      const content = String(args.content ?? '');
      if (!content) throw new Error('content 为空，拒绝写入空文件（如果确实要清空，请写明意图并再调一次）');
      const r = writeFile(workspace, p, content, { backupDir });
      changes.push({ path: p, action: r.action, bytes: r.bytes, at: Date.now(), lines: content.split('\n').length });
      ctx.emit?.({ type: 'dev:file', path: p, action: r.action, bytes: r.bytes, lines: content.split('\n').length });
      return `已${r.action === 'create' ? '创建' : '覆盖'} ${p}（${r.bytes} 字节，${content.split('\n').length} 行）${r.backup ? '，原文件已备份' : ''}`;
    }

    case 'edit_file': {
      const p = String(args.path || '');
      const r = editFile(workspace, p, String(args.old_string ?? ''), String(args.new_string ?? ''), { backupDir });
      const entry = { path: p, action: 'modify', bytes: r.bytes, at: Date.now(), lines: 0 };
      const prev = changes.find((c) => c.path === p);
      if (prev) {
        prev.bytes = r.bytes;
        prev.at = Date.now();
      } else changes.push(entry);
      ctx.emit?.({ type: 'dev:file', path: p, action: 'modify', bytes: r.bytes, lines: 0 });
      return `已修改 ${p}（替换 ${r.replaced} 处）`;
    }

    case 'run_command': {
      const cmd = String(args.command || '');
      const r = await runCommand(workspace, cmd, { timeoutMs: config.devCmdTimeout });
      commands.push({ command: cmd, ok: r.ok, exitCode: r.exitCode, durationMs: r.durationMs, blocked: !!r.blocked, timedOut: !!r.timedOut });
      ctx.emit?.({
        type: 'dev:cmd',
        command: cmd,
        ok: r.ok,
        exitCode: r.exitCode,
        durationMs: r.durationMs,
        blocked: !!r.blocked,
        timedOut: !!r.timedOut,
      });

      if (r.blocked) return `命令被拒绝：${r.stderr}`;
      const parts = [`退出码 ${r.exitCode}${r.timedOut ? '（超时被终止）' : ''}，耗时 ${(r.durationMs / 1000).toFixed(1)}s`];
      if (r.stdout) parts.push(`--- stdout ---\n${r.stdout}`);
      if (r.stderr) parts.push(`--- stderr ---\n${r.stderr}`);
      if (!r.stdout && !r.stderr) parts.push('（没有任何输出）');
      return parts.join('\n');
    }

    case 'finish':
      return '__FINISH__';

    default:
      throw new Error(`未知工具：${name}`);
  }
}

/** 上下文压缩：只保留最近若干轮工具结果，避免 prompt 无限膨胀 */
function compactMessages(messages, budgetChars = 160000) {
  let total = messages.reduce((n, m) => n + String(m.content || '').length + JSON.stringify(m.tool_calls || '').length, 0);
  if (total <= budgetChars) return messages;

  // 从最早的工具结果开始替换成占位符，system 与最近 8 条不动
  for (let i = 1; i < messages.length - 8 && total > budgetChars; i++) {
    const m = messages[i];
    if (m.role === 'tool' && String(m.content || '').length > 400) {
      const before = m.content.length;
      m.content = `（早期工具结果已省略 ${before} 字符，需要时请重新读取）`;
      total -= before - m.content.length;
    }
  }
  return messages;
}

/**
 * 执行阶段：工具循环。
 * emit 事件：dev:step / dev:assistant / dev:tool / dev:tool:result / dev:progress
 */
export async function execute({ workspace, task, design: plan, emit, signal, backupDir, run, model }) {
  const messages = [
    { role: 'system', content: devSystemPrompt() },
    {
      role: 'user',
      content: `【开发任务】
${task}

${plan ? `【已确认的实施方案】\n目标理解：${plan.understanding}\n方案要点：\n${(plan.approach || []).map((a, i) => `${i + 1}. ${a}`).join('\n')}\n计划改动：\n${(plan.files || []).map((f) => `- ${f.path}（${f.action === 'create' ? '新建' : '修改'}）：${f.purpose}`).join('\n')}\n实施步骤：\n${(plan.steps || []).map((s, i) => `${i + 1}. ${s}`).join('\n')}\n验证命令：${(plan.verify || []).join(' / ')}\n` : ''}
【工作区】${workspace}
（所有路径都相对于这个目录，不要用绝对路径）

现在开始干活。第一步先 list_files 看清楚项目结构，然后按方案推进。`,
    },
  ];

  const changes = [];
  const commands = [];
  let totalTokens = 0;
  let finishPayload = null;
  let step = 0;
  let nudgeCount = 0;
  const trace = [];

  const useModel = model || config.devModel;

  while (step < config.devMaxSteps) {
    if (signal?.aborted) throw new Error('已取消');
    step++;

    if (totalTokens > config.devMaxTokens) {
      emit?.({ type: 'dev:warning', message: `token 预算已用尽（${totalTokens}），强制收尾` });
      finishPayload = {
        summary: '预算耗尽，未能完整完成',
        verification: (commands.filter((c) => c.ok).map((c) => `${c.command} ✓`) || []).join('\n') || '未执行验证',
        remaining: 'token 预算耗尽，请人工检查当前改动',
      };
      break;
    }

    emit?.({ type: 'dev:step', step, maxSteps: config.devMaxSteps });

    let res;
    try {
      res = await complete({
        model: useModel,
        messages: compactMessages(messages),
        tools: TOOLS,
        toolChoice: 'auto',
        maxTokens: 8000,
        temperature: 0.3,
        timeout: Math.max(config.requestTimeout, 600000),
        signal,
      });
    } catch (err) {
      // 单步请求失败不拖垮整个 run，把错误告诉模型让它重试一次
      emit?.({ type: 'dev:warning', message: `第 ${step} 步请求失败：${err.message}` });
      if (step >= 3) throw err;
      continue;
    }

    totalTokens += (res.usage?.total_tokens || 0);
    const calls = res.toolCalls || [];

    // 记录这一步的说明文字
    const text = String(res.content || '').trim();
    if (text || calls.length) {
      trace.push({ step, text, calls: calls.map((c) => ({ name: c.name, args: c.args })) });
      if (text) emit?.({ type: 'dev:assistant', step, text });
    }

    // 组装 assistant 消息。推理模型的多轮工具调用要求把 reasoning_content 一起带回。
    // 空响应（无正文无工具调用）不能进历史：协议要求 assistant 至少有一个，
    // 否则下一次请求会被 400 拒绝。
    if (text || calls.length) {
      const assistantMsg = { role: 'assistant', content: text || null };
      if (calls.length) {
        assistantMsg.tool_calls = calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.arguments },
        }));
      }
      if (res.reasoning) assistantMsg.reasoning_content = res.reasoning;
      messages.push(assistantMsg);
    }

    // 没有工具调用：模型在纯聊天，催它干活（最多催三次，避免死循环）。
    // 计数独立维护：空响应不进 trace，用 trace 推算会让连续空响应永远收敛不了。
    if (!calls.length) {
      nudgeCount++;
      if (nudgeCount >= 3) {
        finishPayload = {
          summary: text || '模型未产出可执行动作',
          verification: commands.filter((c) => c.ok).map((c) => `${c.command} ✓`).join('\n') || '未执行验证',
          remaining: '模型停止调用工具，任务可能未完成，请人工检查',
        };
        break;
      }
      messages.push({
        role: 'user',
        content: '你没有调用任何工具。光说不会改变任何文件——现在用 list_files / read_file / write_file / run_command 真正动手。如果已经全部完成并验证通过，调用 finish。',
      });
      continue;
    }

    // 逐个执行工具调用
    for (const call of calls) {
      if (call.name === 'finish') {
        finishPayload = { ...call.args };
        messages.push({ role: 'tool', tool_call_id: call.id, content: '已记录完成声明。' });
        continue;
      }

      emit?.({ type: 'dev:tool', step, name: call.name, args: call.args });

      let out;
      let ok = true;
      const t0 = Date.now();
      try {
        const r = await execTool(call.name, call.args || {}, {
          workspace,
          backupDir,
          changes,
          commands,
          emit,
        });
        if (r === '__FINISH__') {
          finishPayload = { summary: '完成', verification: '未说明' };
        }
        out = toolResultText(r);
      } catch (err) {
        ok = false;
        // 关键设计：工具失败不抛错，把原因回喂给模型，让它自己纠正
        out = `[工具执行失败] ${err.message}\n请调整参数后重试；如果是路径写错，先用 list_files 确认；如果是替换失败，先 read_file 看原文。`;
      }

      emit?.({
        type: 'dev:tool:result',
        step,
        name: call.name,
        ok,
        durationMs: Date.now() - t0,
        preview: String(out).slice(0, 400),
      });

      messages.push({ role: 'tool', tool_call_id: call.id, content: String(out).slice(0, 30000) });
    }

    // 这一轮真的动了手，催促计数归零
    nudgeCount = 0;

    if (finishPayload) break;
  }

  if (!finishPayload) {
    finishPayload = {
      summary: `达到最大步数 ${config.devMaxSteps}，任务未确认完成`,
      verification: commands.filter((c) => c.ok).map((c) => `${c.command} ✓`).join('\n') || '未执行验证',
      remaining: '步数用尽，请检查当前改动是否可用',
    };
  }

  return {
    summary: String(finishPayload.summary || '').trim(),
    verification: String(finishPayload.verification || '').trim(),
    remaining: String(finishPayload.remaining || '').trim(),
    changes,
    commands,
    steps: step,
    trace,
    usage: { totalTokens },
    model: useModel,
  };
}

export { TOOLS, checkCommand };
