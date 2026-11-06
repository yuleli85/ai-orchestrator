import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { complete, extractJson } from './llm.js';
import { listTree, readFile, resolveSafe, searchContent, treeText, writeFile } from './sandbox.js';
import { depsOf, profile } from './archprofiler.js';

/**
 * 架构智能体。
 *
 * 和开发智能体的根本区别：
 * - 开发智能体验证靠"跑测试"，结果客观；
 * - 架构设计没有客观答案，只有权衡。所以流程不能是"直接给个方案"，
 *   必须先摆出「现状证据 → 问题 → 候选方案对比」，让人选方向，再展开细节。
 *   直接给一个方案，等于替用户做了决策，而且他无法判断这个决策好在哪。
 *
 * 另一个硬约束：它只能写 docs/ 下的 Markdown，不能改一行业务代码。
 * 架构师可以提方案，但落地是开发的事——这条在工具层强制，不靠提示词自觉。
 */

/* ---------------- 诊断阶段 ---------------- */

const DIAGNOSE_PROMPT = (p, goal) => `你是一名资深架构师，正在做架构诊断。下面是这个项目**真实扫描出来的**结构数据，不是猜测。

【项目画像】
${p.text}

【你要解决的问题】
${goal}

【诊断要求】
1. 每一条问题都必须有证据。证据只能是上面画像里的数据（模块名、文件数、循环依赖、被引用次数），或者你接下来读到的真实代码。禁止写"可能""也许""一般而言"这类没有依据的判断。
2. 区分严重程度。high 只有一种情况：已经造成实际的开发阻塞或数据风险（例如循环依赖导致无法独立发布、领域层直接依赖数据库实现导致无法测试）。纯粹的"不够优雅"最多算 low。
3. 不要套模板。如果这个项目分层清晰、没有循环依赖，就直说它结构是健康的，把问题指向别处（比如缺少边界、模块粒度、外部依赖失控）。不要把"没有 DDD"当成问题。
4. 候选方案必须真的是不同路线，不是同一方案的三种措辞。每个方案说清"代价是什么"——没有代价的方案不存在。
5. 如果信息不足以判断（比如关键模块没读过），在 openQuestions 里写清需要什么，不要编。

【输出】只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释文字：
{
  "summary": "这个项目现在是什么形态，两三句话",
  "asIs": {
    "style": "分层单体 | 微服务 | 事件驱动 | 模块化单体 | 大泥球 | 其他（写出你的判断）",
    "structure": "现在代码是怎么组织的，按什么切的模块",
    "dataFlow": "一个典型请求从入口到落库经过哪些模块",
    "strengths": ["现有设计中值得保留的部分，没有就给空数组"]
  },
  "issues": [
    {
      "id": "I1",
      "title": "一句话说清问题",
      "severity": "high|medium|low",
      "evidence": "具体证据：哪个文件/哪个模块/哪组数据",
      "impact": "它实际造成了什么后果，不要写理论后果"
    }
  ],
  "options": [
    {
      "id": "A",
      "name": "方案名，不超过 10 字",
      "summary": "这个方案做什么，两三句话",
      "changes": ["具体改动，按模块写"],
      "pros": ["好处，要具体"],
      "cons": ["代价，必须写，没有代价的方案是假的"],
      "effort": "工作量估计，如 2 人 3 周",
      "risk": "low|medium|high",
      "fit": "什么情况下应该选它"
    }
  ],
  "recommendation": { "optionId": "A", "why": "为什么推荐它，要提到你放弃了什么" },
  "openQuestions": ["需要业务方确认的约束，没有就给空数组"]
}

issues 控制在 3~8 条，options 给 2~3 个。`;

/** 读一批最能反映架构的文件：入口、配置、以及各模块的代表文件 */
function sampleFiles(workspace, p) {
  const limit = config.archSampleFiles;
  const picks = [];
  const push = (rel) => {
    if (rel && !picks.includes(rel) && picks.length < limit) picks.push(rel);
  };

  // 配置与清单优先：能看出技术栈和依赖
  for (const c of p.configs) {
    if (/^(package\.json|pom\.xml|build\.gradle|go\.mod|requirements\.txt|pyproject\.toml|composer\.json|Cargo\.toml)$/.test(path.posix.basename(c))) push(c);
  }
  // 入口点
  for (const e of p.entryPoints) push(e);
  // 每个模块抽一个代表文件，优先挑 service/controller/index 这类
  for (const m of p.modules) {
    const preferred = m.sample.find((s) => /(index|main|service|controller|api|handler|domain|model)/i.test(s)) || m.sample[0];
    push(preferred);
  }
  // 热点文件（耦合中心）
  for (const h of p.hotspots.slice(0, 4)) push(h.path);

  return picks;
}

function readSamples(workspace, rels) {
  const out = [];
  for (const rel of rels) {
    try {
      const full = resolveSafe(workspace, rel);
      const st = fs.statSync(full);
      if (st.size > 24000) {
        const text = readFile(workspace, rel, { maxBytes: 24000 });
        out.push({ path: rel, content: text });
      } else {
        out.push({ path: rel, content: fs.readFileSync(full, 'utf8') });
      }
    } catch {
      /* 读不到就跳过，不影响诊断 */
    }
  }
  return out;
}

export async function diagnose({ workspace, goal, emit, signal, model }) {
  emit?.({ type: 'arch:scan:start' });

  const p = profile(workspace);
  emit?.({ type: 'arch:scan:done', profile: slimProfile(p) });

  if (!p.stats.codeFiles) {
    throw new Error('这个目录里没有识别到源码文件，无法做架构诊断。请确认选的是项目根目录。');
  }

  const samples = readSamples(workspace, sampleFiles(workspace, p));

  emit?.({ type: 'arch:analyzing', sampleCount: samples.length });

  const res = await complete({
    model: model || config.archModel,
    system: '你是资深系统架构师。你的判断必须建立在证据上，宁可说"这里我没看到问题"，也不要为了显得专业而编造问题。只输出 JSON。',
    user: `${DIAGNOSE_PROMPT(p, goal)}

【已读取的关键文件】
${samples.map((s) => `--- ${s.path} ---\n${s.content}`).join('\n\n')}`,
    maxTokens: 12000,
    temperature: 0.3,
    effort: 'high',
    timeout: Math.max(config.requestTimeout, 600000),
    signal,
  });

  let raw;
  try {
    raw = extractJson(res.content);
  } catch (err) {
    throw new Error(`诊断结果解析失败：${err.message}。模型输出前 300 字：${String(res.content).slice(0, 300)}`);
  }

  const sevRank = { high: 0, medium: 1, low: 2 };
  const issues = (Array.isArray(raw.issues) ? raw.issues : [])
    .filter((i) => i && i.title)
    .map((i, idx) => ({
      id: String(i.id || `I${idx + 1}`),
      title: String(i.title),
      severity: ['high', 'medium', 'low'].includes(i.severity) ? i.severity : 'medium',
      evidence: String(i.evidence || ''),
      impact: String(i.impact || ''),
    }))
    .sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);

  const options = (Array.isArray(raw.options) ? raw.options : [])
    .filter((o) => o && o.name)
    .map((o, idx) => ({
      id: String(o.id || String.fromCharCode(65 + idx)),
      name: String(o.name),
      summary: String(o.summary || ''),
      changes: Array.isArray(o.changes) ? o.changes.map(String) : [],
      pros: Array.isArray(o.pros) ? o.pros.map(String) : [],
      cons: Array.isArray(o.cons) ? o.cons.map(String) : [],
      effort: String(o.effort || ''),
      risk: ['low', 'medium', 'high'].includes(o.risk) ? o.risk : 'medium',
      fit: String(o.fit || ''),
    }));

  if (!options.length) {
    throw new Error('诊断没有产出可选方案，无法继续。可能是任务描述太笼统，试着说明你想解决的具体问题。');
  }

  const rec = raw.recommendation || {};
  const diagnosis = {
    summary: String(raw.summary || '').trim(),
    asIs: {
      style: String(raw.asIs?.style || '未判断'),
      structure: String(raw.asIs?.structure || ''),
      dataFlow: String(raw.asIs?.dataFlow || ''),
      strengths: Array.isArray(raw.asIs?.strengths) ? raw.asIs.strengths.map(String) : [],
    },
    issues,
    options,
    recommendation: {
      optionId: options.some((o) => o.id === rec.optionId) ? String(rec.optionId) : options[0].id,
      why: String(rec.why || ''),
    },
    openQuestions: Array.isArray(raw.openQuestions) ? raw.openQuestions.map(String) : [],
    profile: slimProfile(p),
    profileText: p.text,
    model: res.model,
    usage: res.usage,
  };

  emit?.({ type: 'arch:diagnose:done', diagnosis });
  return diagnosis;
}

/** 画像瘦身：存盘只留展示需要的，避免 state.json 爆掉 */
function slimProfile(p) {
  return {
    sourceRoot: p.sourceRoot,
    stats: p.stats,
    langs: p.langs.slice(0, 6),
    modules: p.modules.slice(0, 20).map((m) => ({
      name: m.name,
      files: m.files,
      lines: m.lines,
      outbound: m.outbound.slice(0, 8),
      inbound: m.inbound.slice(0, 8),
    })),
    cycles: p.cycles,
    violations: p.violations,
    godModules: p.godModules,
    hotspots: p.hotspots.slice(0, 10),
    externals: p.externals.slice(0, 12),
    layerStats: p.layerStats,
    entryPoints: p.entryPoints,
    truncated: p.truncated,
  };
}

/* ---------------- 设计阶段 ---------------- */

const DOC_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: '列出工作区目录结构。确认文件是否存在时用，不要凭想象假设路径。',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: '相对工作区的目录，根目录传 "."' },
          depth: { type: 'integer', description: '递归深度，默认 2，最大 5' },
        },
        required: ['dir'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取文件内容。写架构文档前，涉及的模块必须真的读过，否则写出来的边界是编的。',
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
      description: '按正则搜索代码，返回 文件:行号: 内容。确认某个类/函数到底被谁调用时用。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '正则表达式' },
          glob: { type: 'string', description: '可选，文件名通配，如 "*.java"' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'deps_of',
      description: '查某个文件的模块归属、上下游依赖、是否在循环依赖里。规划模块边界时用。',
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
      name: 'write_doc',
      description:
        '写入架构文档。只能写 docs/ 目录下的 .md 文件，不能写代码、不能写其他目录。 ' +
        '如果目标文件已存在且不是本次运行写的，会被拒绝（防止覆盖上一轮不同主题的产出）；确认要取代它时传 overwrite: true。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '如 docs/architecture/architecture.md' },
          content: { type: 'string', description: '完整 Markdown 内容' },
          overwrite: {
            type: 'boolean',
            description: '仅在确认要整体取代同一主题的历史文档时设为 true。默认不覆盖别人的文件。',
          },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: '交付完成。必须真的写过文档才能调用。',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '产出了哪些文档，各自讲什么，按条目写' },
          decisions: { type: 'string', description: '这次定下来的关键决策，3~5 条' },
          risks: { type: 'string', description: '这套架构方案的主要风险与前提条件' },
          remaining: { type: 'string', description: '需要人拍板或后续补充的部分，没有就写"无"' },
        },
        required: ['summary', 'decisions'],
      },
    },
  },
];

function docPathCheck(rel) {
  const norm = String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!norm) throw new Error('路径不能为空');
  if (norm.includes('..')) throw new Error('路径不能包含 ..');
  if (!/^docs\//.test(norm)) throw new Error('架构文档只能写到 docs/ 目录下（收到：' + norm + '）');
  if (!/\.md$/i.test(norm)) throw new Error('架构文档只能是 .md 文件（Mermaid 图写在 Markdown 的 ```mermaid 代码块里）');
  return norm;
}

function systemPrompt() {
  return `你是资深系统架构师，负责把一个模块/系统的架构设计说清楚，并写成能直接进代码库的文档。

你不是文档排版员。你的价值在于：判断哪些边界该切、哪些依赖是错的、为什么这么选而不是那么选。

【工作纪律】
1. 先看再写。画像给了你结构和依赖，但模块职责只能通过读代码确认。写任何"XX 模块负责 YY"之前，先 read_file 或 search 验证。写错职责描述比不写更糟——开发会照着错的去做。
2. 拒绝空话。下面这些句子一个字都不要写：
   "提高系统可维护性" "增强扩展性" "降低耦合度" "遵循最佳实践" "使用成熟框架"
   要写就写具体到能被反驳的："订单查询走独立只读库，避免报表把主库连接池打满"。
3. 每个决策都要有代价。只说好处不说代价的方案是在骗人。ADR 里的"后果"必须包含"这样做的坏处"。
4. 图不能用文字代替。模块关系、调用链路、状态流转都必须画 Mermaid。画图时节点不超过 15 个，多了说明粒度太粗。
5. 不写代码。你是架构师，产出是文档和接口契约，落地由开发做。可以在契约里写类型签名，但不要写实现。

【读的纪律】
最多读 8 个文件就必须写出第一篇文档，之后再按需补充阅读。
你最容易犯的错误是"把整个项目读完再动笔"——等你读完，token 预算也耗尽了，一份文档都写不出来。
正确顺序：读 3~5 个关键文件确认职责 → 写 README.md → 写 architecture.md → 需要细节时只读相关的那一个文件 → 写 ADR → 写 roadmap。
读完 8 个文件还没动笔，会被系统强制打断，那时你只能交出一份空结果。

【文档结构】按任务规模决定写几份，不要为了齐全而注水：
- docs/architecture/README.md —— 总览与导航。必须最先写，说明这次设计解决什么问题、文档怎么读。
- docs/architecture/architecture.md —— 目标架构。含：分层/模块划分（Mermaid 图）、每个模块的职责与边界、关键数据流（Mermaid 时序图）、与现状的差异。
- docs/architecture/ADR-00N-<短名>.md —— 关键决策记录。一个决策一个文件。格式见下。
- docs/architecture/contracts.md —— 接口契约。只在涉及跨模块/跨服务调用时写。写请求响应字段、错误码、幂等要求，不写实现。
- docs/architecture/roadmap.md —— 演进路径。分批落地，每批要能独立上线、可回滚。

【ADR 格式】（严格遵守，这是团队 review 的依据）
# ADR-00N: 决策标题
## 状态
已接受 / 待定
## 背景
什么问题逼着我们必须做这个决策。写事实，不写情绪。
## 备选方案
列出至少 2 个，每个说清做法与代价。
## 决策
选了哪个，为什么。
## 后果
- 好处：具体
- 代价：具体，必须写
- 后续约束：这个决策之后哪些事不能做了

【Mermaid 用法】
- 模块关系用 flowchart，节点标签写中文模块名，边上标依赖方式（同步调用/事件/共享库）
- 数据流用 sequenceDiagram
- 状态机用 stateDiagram-v2
- 不要用 graph TD 这类老语法，用 flowchart TD

【交付物】
你的成果是 docs/architecture/ 下的 Markdown 文件。写在聊天正文里的内容不会出现在磁盘上，等于没交付。
想调用 finish 之前先确认：docs 下已经有文件了吗？没有就先去写。

【收尾】写完所有文档后调用 finish。summary 里列出每个文件路径和它讲什么。`;
}

/**
 * 列出 docs/ 下已经存在的 Markdown。
 *
 * 存在的意义：同一工作区会被做很多轮架构设计，全都落在 docs/ 下。
 * 不告诉模型有哪些历史文件，它会心安理得地从 ADR-001 重新编号、把 README 整份覆盖，
 * 结果两轮不同主题的结论混在一个目录里互相矛盾。实测踩过。
 */
function listExistingDocs(workspace) {
  const root = path.join(workspace, 'docs');
  if (!fs.existsSync(root)) return [];
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (/^(node_modules|\.git)$/.test(e.name)) continue;
        walk(full, depth + 1);
        continue;
      }
      if (!/\.md$/i.test(e.name)) continue;
      let head = '';
      try {
        head = (fs.readFileSync(full, 'utf8').split('\n').find((l) => l.trim()) || '')
          .replace(/^#+\s*/, '')
          .trim()
          .slice(0, 60);
      } catch {
        /* 读不到标题不影响列名字 */
      }
      out.push({ path: path.relative(workspace, full).replace(/\\/g, '/'), head });
    }
  };
  walk(root, 1);
  return out.slice(0, 40);
}

function designUserPrompt({ workspace, goal, diagnosis, option, profileText, existingDocs = [] }) {
  const existingBlock = existingDocs.length
    ? `
【docs/ 下已经存在的文档（都是历史产出，不属于本次运行）】
${existingDocs.map((d) => `- ${d.path}${d.head ? ` —— ${d.head}` : ''}`).join('\n')}

写文档前必须遵守：
1. 不要覆盖上面这些文件。README 被整份换掉，等于把上一轮的索引直接抹了；两个不同主题的结论混在一个目录里会互相矛盾。
2. ADR 编号接着已有的最大号往后排，不要从 001 重来。文件名带上本次主题，让两轮能共存。
3. 唯一例外：你判断这次的结论明确就是取代某一份旧文档（同一主题的修订），那就在第一次写它时带上 overwrite: true，并在 README 里说明取代了哪份。
`
    : '';

  return `【架构设计任务】
${goal}

【已确认的方向】
方案 ${option.id}：${option.name}
${option.summary}
具体改动：
${option.changes.map((c) => `- ${c}`).join('\n')}
已知代价：
${option.cons.map((c) => `- ${c}`).join('\n')}

【诊断结论（已经和用户确认过，作为设计前提）】
现状：${diagnosis.asIs.style} —— ${diagnosis.asIs.structure}
核心问题：
${diagnosis.issues.map((i) => `- [${i.severity}] ${i.title}：${i.evidence}`).join('\n')}

【项目结构数据】
${profileText}

【工作区】${workspace}
（路径都相对这个目录，文档写到 docs/architecture/ 下）
${existingBlock}

现在开始。第一步先读几个关键模块的代码确认职责，然后写文档。顺序建议：README → architecture → ADR → contracts → roadmap。`;
}

/**
 * 判断这次写文档会不会覆盖掉别的运行的产出。
 * 抽成纯函数是为了能被测：只在工具循环里内联，就只能靠人工点界面验证。
 * 返回 null 表示放行，返回字符串表示拒绝原因。
 */
export function overwriteVerdict({ workspace, rel, docs, overwrite }) {
  const owned = (docs || []).some((d) => d.path === rel);
  if (owned) return null; // 本次运行写过的文件，随便改，那是修订
  if (overwrite === true) return null; // 明确声明要取代
  if (!fs.existsSync(path.join(workspace, rel))) return null; // 压根不存在，正常新建
  return (
    `${rel} 已经存在，而且不是本次运行写的（多半是上一轮架构设计的产出）。两个办法：` +
    `① 换个不冲突的名字——ADR 编号接着已有最大号往后排，文件名带上本次主题；` +
    `② 如果你确认这次就是要整体取代它，把 overwrite 设为 true 再写。不要不加判断地覆盖。`
  );
}

function compact(messages, budget = 200000) {
  let total = messages.reduce((n, m) => n + String(m.content || '').length + JSON.stringify(m.tool_calls || '').length, 0);
  if (total <= budget) return messages;
  for (let i = 1; i < messages.length - 8 && total > budget; i++) {
    const m = messages[i];
    if (m.role === 'tool' && String(m.content || '').length > 400) {
      const before = m.content.length;
      m.content = `（早期工具结果已省略 ${before} 字符，需要时请重新读取）`;
      total -= before - m.content.length;
    }
  }
  return messages;
}

async function execTool(name, args, ctx) {
  const { workspace, docs, emit, backupDir, profiled, stats } = ctx;

  switch (name) {
    case 'list_files': {
      const dir = String(args.dir || '.');
      const depth = Math.max(0, Math.min(5, Number(args.depth ?? 2)));
      let tree;
      if (dir === '.' || dir === './' || dir === '') {
        tree = treeText(workspace, { depth, maxEntries: 400 });
      } else {
        const full = resolveSafe(workspace, dir);
        if (!fs.existsSync(full)) throw new Error(`目录不存在：${dir}`);
        tree = treeText(full, { depth, maxEntries: 300 });
      }
      // 运行时数据和依赖目录对理解架构没有任何价值，却会占掉大量 prompt
      const NOISE = /^\s*(data|node_modules|\.git|\.workbuddy|\.scratch|dist|build|coverage)(\/|\s|$)/;
      const kept = tree.split('\n').filter((l) => !NOISE.test(l));
      return kept.length ? kept.join('\n') : '（这个目录下没有对架构分析有价值的内容）';
    }

    case 'read_file': {
      const p = String(args.path || '');
      const repeated = stats?.readPaths?.has(p);

      // 重读只回显开头。实测模型会把一个 1000 行的文件读三遍，
      // 每次 1.5 万 token，单步就卡到 60~120 秒，结果一份文档都没写。
      if (repeated) {
        const head = readFile(workspace, p, { maxBytes: 4000 });
        return `${head}\n\n[系统提示] 这个文件前面已经读过了，这里只回显开头。其余内容在之前的对话里，直接基于它写文档，不要再重读。`;
      }

      if (stats) {
        stats.readCount++;
        stats.readPaths.add(p);
        // 硬边界：架构设计不需要读十几个文件，读太多说明在拖延动笔。
        if (stats.readCount > 12) {
          throw new Error(
            `你已经读了 ${stats.readCount - 1} 个文件，停止阅读。现在必须用 write_doc 写文档，缺什么细节再针对性读单个文件。`,
          );
        }
      }

      const text = readFile(workspace, p, { maxBytes: 16000 });
      if (text.length >= 8000) {
        return `${text}\n\n[系统提示] 文件较长，这里只读到前约 16KB。需要某段具体实现时用 search 按关键词定位行号，不要整份重读。`;
      }
      if (stats?.readCount === 8) {
        return `${text}\n\n[系统提示] 已读 8 个文件。别再扩大阅读范围了，现在开始写文档，写完再按需补充。`;
      }
      return text;
    }

    case 'search': {
      const hits = searchContent(workspace, String(args.pattern || ''), { glob: args.glob ? String(args.glob) : '' });
      if (!hits.length) return '没有匹配结果。换个更短的关键词，或先 list_files 看结构。';
      return hits.join('\n');
    }

    case 'deps_of': {
      const rel = String(args.path || '');
      // 用本次 design 开头算好的画像，避免每次调用都全量重扫
      return JSON.stringify(depsOf(workspace, rel, { profiled }), null, 2);
    }

    case 'write_doc': {
      const rel = docPathCheck(args.path);
      const content = String(args.content ?? '');
      if (!content.trim()) throw new Error('内容为空，拒绝写入空文档');
      if (content.length > 120000) throw new Error('单个文档超过 12 万字符，请拆分成多份');

      // 覆盖别人的历史文档是这功能最贵的错误：一次覆盖会把上一轮的主题、索引、
      // ADR 编号全冲掉，而且从磁盘上看不出发生过什么。
      const deny = overwriteVerdict({ workspace, rel, docs, overwrite: args.overwrite });
      if (deny) throw new Error(deny);

      const r = writeFile(workspace, rel, content, { backupDir });
      const entry = { path: rel, action: r.action, bytes: r.bytes, lines: content.split('\n').length, at: Date.now() };
      const prev = docs.find((d) => d.path === rel);
      if (prev) Object.assign(prev, entry);
      else docs.push(entry);

      emit?.({ type: 'arch:doc', path: rel, action: r.action, bytes: r.bytes, lines: entry.lines });
      return `已${r.action === 'create' ? '创建' : '更新'} ${rel}（${content.split('\n').length} 行 / ${r.bytes} 字节）${r.backup ? '，原文档已备份' : ''}`;
    }

    case 'finish':
      return '__FINISH__';

    default:
      throw new Error(`未知工具：${name}`);
  }
}

export async function design({ workspace, goal, diagnosis, optionId, emit, signal, backupDir, model }) {
  const option = diagnosis.options.find((o) => o.id === optionId) || diagnosis.options[0];
  const existingDocs = listExistingDocs(workspace);

  const messages = [
    { role: 'system', content: systemPrompt() },
    {
      role: 'user',
      content: designUserPrompt({
        workspace,
        goal,
        diagnosis,
        option,
        profileText: diagnosis.profileText,
        existingDocs,
      }),
    },
  ];

  const docs = [];
  let finishPayload = null;
  let step = 0;
  let totalTokens = 0;
  const trace = [];
  const useModel = model || config.archModel;
  // 算一次画像供 deps_of 复用；设计过程中代码一般不会变，重算纯属浪费
  const profiled = profile(workspace);
  const stats = { readCount: 0, readPaths: new Set() };
  let nudged = false;
  // 独立计数，不能用 trace 长度推算：空响应不会进 trace，
  // 拿 trace 算会导致"连续空响应"永远达不到收尾阈值，一直空转到步数用尽。
  let idleCount = 0;
  let finishRejects = 0;

  while (step < config.archMaxSteps) {
    if (signal?.aborted) throw new Error('已取消');
    step++;
    emit?.({ type: 'arch:step', step, maxSteps: config.archMaxSteps });

    if (totalTokens > config.archMaxTokens) {
      emit?.({ type: 'arch:warning', message: `token 预算已用尽（${totalTokens}），强制收尾` });
      finishPayload = {
        summary: docs.length ? docs.map((d) => `${d.path}（${d.lines} 行）`).join('\n') : '未产出文档',
        decisions: '预算耗尽，决策未完整记录',
        risks: 'token 预算耗尽',
        remaining: '文档可能不完整，请人工检查',
      };
      break;
    }

    // 预算过半还没写出任何文档 → 强制干预。
    // 不干预的话模型会一路读下去，读到预算耗尽，交回来一份空结果。
    if (!nudged && docs.length === 0 && totalTokens > config.archMaxTokens * 0.45) {
      nudged = true;
      emit?.({ type: 'arch:warning', message: '已用掉近半预算仍未动笔，要求先写文档再补读' });
      messages.push({
        role: 'user',
        content:
          '停止继续读代码。你已经消耗了近半预算。现在立刻用 write_doc 写 docs/architecture/README.md（这次解决什么问题、文档怎么读、目标架构一句话概括），紧接着写 architecture.md。之后缺什么细节再针对性读那一个文件。',
      });
    }

    let res;
    try {
      res = await complete({
        model: useModel,
        messages: compact(messages),
        tools: DOC_TOOLS,
        toolChoice: 'auto',
        maxTokens: 10000,
        temperature: 0.4,
        timeout: Math.max(config.requestTimeout, 600000),
        signal,
      });
    } catch (err) {
      emit?.({ type: 'arch:warning', message: `第 ${step} 步请求失败：${err.message}` });
      if (step >= 3) throw err;
      continue;
    }

    totalTokens += res.usage?.total_tokens || 0;
    const calls = res.toolCalls || [];
    const text = String(res.content || '').trim();
    if (text || calls.length) {
      trace.push({ step, text, calls: calls.map((c) => ({ name: c.name, args: c.args })) });
      if (text) emit?.({ type: 'arch:assistant', step, text });
    }

    // 空响应（既没正文也没工具调用）不能塞进历史：
    // OpenAI 兼容协议要求 assistant 消息至少有 content 或 tool_calls，
    // 塞一个 content:null 进去，下一次请求直接被 400 拒绝，整轮跑挂。
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

    if (!calls.length) {
      idleCount++;
      if (idleCount >= 3) {
        finishPayload = {
          summary: docs.length ? docs.map((d) => `${d.path}（${d.lines} 行）`).join('\n') : '模型未产出文档',
          decisions: text || '无',
          risks: '模型停止调用工具，设计可能不完整',
          remaining: '请人工检查文档完整性',
        };
        break;
      }
      messages.push({
        role: 'user',
        content: '你没有调用工具。空谈不会产生文档——现在用 read_file 确认模块职责，用 write_doc 把设计写下来。全部写完就调用 finish。',
      });
      continue;
    }
    idleCount = 0;

    for (const call of calls) {
      if (call.name === 'finish') {
        // 关键：没写文档就 finish 必须被拒绝。
        // 实测模型很容易"读完代码直接在正文里给结论"，正文不会落盘，等于什么都没交付。
        // 把这个约束放在工具层，而不是靠提示词自觉。
        if (docs.length === 0) {
          finishRejects++;
          if (finishRejects >= 3) {
            throw new Error(
              '模型连续 3 次想收工但都没有写文档，本次设计中止。建议把设计目标写得更具体（指明要设计哪个模块/哪一层），它会更容易落笔。',
            );
          }
          emit?.({ type: 'arch:warning', message: '模型想收工但一份文档都没写，已退回' });
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content:
              '[拒绝] 你还没有写出任何文档，finish 无效。你的交付物是 docs/architecture/ 下的 Markdown 文件，不是聊天正文。现在立刻调用 write_doc 写第一篇。',
          });
          continue;
        }
        finishPayload = { ...call.args };
        messages.push({ role: 'tool', tool_call_id: call.id, content: '已记录交付声明。' });
        continue;
      }

      emit?.({ type: 'arch:tool', step, name: call.name, args: call.args });

      let out;
      let ok = true;
      const t0 = Date.now();
      try {
        const r = await execTool(call.name, call.args || {}, { workspace, docs, emit, backupDir, profiled, stats });
        if (r === '__FINISH__') finishPayload = { summary: '完成', decisions: '未说明' };
        out = typeof r === 'string' ? r : JSON.stringify(r);
      } catch (err) {
        ok = false;
        out = `[工具执行失败] ${err.message}\n请调整后重试。写文档只能写 docs/ 下的 .md，路径写错先用 list_files 确认目录。`;
      }

      emit?.({
        type: 'arch:tool:result',
        step,
        name: call.name,
        ok,
        durationMs: Date.now() - t0,
        preview: String(out).slice(0, 400),
      });

      messages.push({ role: 'tool', tool_call_id: call.id, content: String(out).slice(0, 30000) });
    }

    if (finishPayload) break;
  }

  if (!finishPayload) {
    finishPayload = {
      summary: docs.length ? docs.map((d) => `${d.path}（${d.lines} 行）`).join('\n') : '未产出文档',
      decisions: '达到最大步数，未确认完成',
      risks: '步数用尽',
      remaining: '请人工检查',
    };
  }

  // 一份文档都没写却报成功，比直接失败更糟——用户会以为设计做完了。
  if (!docs.length) {
    throw new Error(
      `这次没有写出任何文档（用了 ${step} 步 / ${totalTokens} token，大部分花在读代码上）。` +
        '请把设计目标收窄一些再试，例如把"整个架构怎么改"换成"HTTP 层该怎么拆"这种单点问题。',
    );
  }

  return {
    summary: String(finishPayload.summary || '').trim(),
    decisions: String(finishPayload.decisions || '').trim(),
    risks: String(finishPayload.risks || '').trim(),
    remaining: String(finishPayload.remaining || '').trim(),
    docs,
    steps: step,
    trace,
    usage: { totalTokens },
    model: useModel,
    option: { id: option.id, name: option.name },
  };
}

export { DOC_TOOLS, docPathCheck };
