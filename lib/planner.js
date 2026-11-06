import { config } from './config.js';
import { complete, extractJson } from './llm.js';
import { rolesForPrompt, findRole } from './roles.js';

/**
 * 规划引擎：一句话 → 一组带角色归属、依赖关系、验收标准的子任务。
 *
 * 这里的产品判断：
 * - 拆解质量 > 拆解数量。硬拆出 8 个任务不如老实给 2 个；
 * - 每个子任务必须「可独立交付」，否则执行时会互相等、互相重复；
 * - 依赖只表达真实的数据依赖，不表达"顺序感"，否则并行度全丢。
 */

function planSystemPrompt(roles, hasWorkspace) {
  const dev = roles.find((r) => r.id === 'dev');
  const devRule = !dev
    ? ''
    : hasWorkspace
      ? `8. 团队里有一位「开发工程师」（roleId=dev）连着一个真实代码库，它不只写方案：它会真的建文件、改代码、跑构建和测试。
   **只要任务里包含"写代码 / 改代码 / 加功能 / 修 bug / 补测试 / 重构"这类需要落地的部分，就必须派给 dev**，
   并在 input 里写清：改哪个模块、涉及哪些现有文件（你从用户描述里看到的）、技术栈约束。
   dev 一次只适合做一个内聚的编码任务；如果要改的东西横跨多个模块，拆成多个 dev 任务并用 dependsOn 排好先后。
   纯分析/方案/文档部分仍然交给其他角色，不要全压给 dev。`
      : `8. 团队里有一位「开发工程师」（roleId=dev），但**当前任务没有绑定代码库目录**，它只能产出代码方案而不能落地。
   所以涉及编码的部分，让它写"可执行的实现方案 + 完整代码片段"，不要写"直接修改某个文件"。`;

  return `你是「总控台」的任务分配引擎。你的唯一职责：把用户一个模糊的大任务，拆成一组边界清晰、可独立执行的子任务，并为每个子任务指定最合适的角色。

【拆解原则】
1. 每个子任务必须可独立交付：执行者拿到你的描述就能直接做完，不需要再回头问别人（需要上游产物时用 dependsOn 声明）。
2. 数量控制在 ${config.minTasks}~${config.maxTasks} 个。少于 3 个通常说明没拆开；多于 ${config.maxTasks} 个通常说明该合并。
3. 只写真实的数据依赖。判断标准很硬：**B 没有 A 的产出就真的做不下去**，才算依赖。"B 可以参考 A""先做 A 心里更有底"都不算。
   同一件事的不同侧面（例如"接口设计"和"测试要点"）只要各自能独立成稿，就必须并行。
   **如果你输出的是一条从头串到尾的链，几乎一定拆错了**——回去检查哪几块其实可以同时开工。
4. 每个子任务必须写 deliverable（产出物形态）和 acceptance（2~4 条可检验的验收点）。验收点要能被第三方判断真假，不写"质量高""体验好"。
5. 严禁拆出没有产出的任务：沟通协调、开会讨论、等待确认、持续跟进——这类一律不写。
6. **不要拆出"汇总/整合/合并成一份最终文档"的任务。** 所有子任务完成后系统会自动做一次总汇总，你再派一个写手去做同样的事就是重复劳动。
7. 如果任务本身一个人就能干完（比如"写一段产品介绍"），就只输出 1 个任务，不要为了显得忙而硬拆。
${devRule}

【可选角色】roleId 必须从下面精确取值，不得自创：
${rolesForPrompt(roles)}

【输出格式】
只输出一个 JSON 对象。不要解释，不要 markdown 代码块，不要前后缀文字。
{
  "title": "任务标题，10 字以内，名词短语",
  "understanding": "你对这个任务的理解，1~2 句，说人话",
  "complexity": "simple | moderate | complex",
  "assumptions": ["你替用户做的假设，最多 3 条，没有就空数组"],
  "tasks": [
    {
      "id": "T1",
      "title": "子任务标题，动词开头，12 字以内",
      "roleId": "上面列表里的角色 id",
      "objective": "这个子任务要达成什么，1 句",
      "input": "执行者需要知道的具体信息和上下文，可以引用上游任务",
      "deliverable": "产出物形态，例如：Markdown 文档，含 X/Y/Z 三节",
      "acceptance": ["验收点 1", "验收点 2"],
      "dependsOn": []
    }
  ]
}

【自检】输出前逐条核对：
- 每个 roleId 都在角色列表里吗？
- 每个 dependsOn 里的 id 都真实存在、且不是自己吗？
- 有没有两个任务在说同一件事？
- 有没有"汇总成一份文档"这类任务混进来？有就删掉，系统会自动汇总。
- 有没有至少两个任务可以同时开工？如果所有任务串成一条链，重新判断一次依赖是不是真的。
- 所有任务做完，用户的问题真的被解决了吗？`;
}

function planUserPrompt(goal, extra) {
  let s = `【用户的任务】\n${goal}`;
  if (extra && String(extra).trim()) {
    s += `\n\n【用户的补充/修正意见（必须遵守）】\n${String(extra).trim()}`;
  }
  return s;
}

/**
 * 归一化模型输出：修 id、纠正角色、断环、截断数量。
 * 模型输出不可信，这一步是防线。
 */
export function normalizePlan(raw, roles, goal) {
  const roleIds = new Set(roles.map((r) => r.id));
  const fallbackRole = roleIds.has('product') ? 'product' : roles[0]?.id;

  let tasks = Array.isArray(raw?.tasks) ? raw.tasks : [];
  tasks = tasks.filter((t) => t && typeof t === 'object');
  if (!tasks.length) throw new Error('模型没有拆出任何子任务');

  // 截断到上限
  if (tasks.length > config.maxTasks) tasks = tasks.slice(0, config.maxTasks);

  // 重排 id 为 T1..Tn，建立旧→新映射
  const idMap = new Map();
  tasks.forEach((t, i) => {
    const oldId = String(t.id ?? `T${i + 1}`);
    const newId = `T${i + 1}`;
    if (!idMap.has(oldId)) idMap.set(oldId, newId);
    idMap.set(newId, newId);
  });

  const normalized = tasks.map((t, i) => {
    const newId = `T${i + 1}`;
    let roleId = String(t.roleId || '').trim();
    if (!roleIds.has(roleId)) roleId = fallbackRole;

    const deps = Array.isArray(t.dependsOn) ? t.dependsOn : [];
    const mapped = deps
      .map((d) => idMap.get(String(d)))
      .filter((d) => d && d !== newId);

    const acceptance = Array.isArray(t.acceptance)
      ? t.acceptance.map((a) => String(a).trim()).filter(Boolean).slice(0, 5)
      : [];

    return {
      id: newId,
      title: String(t.title || `子任务 ${i + 1}`).trim().slice(0, 40),
      roleId,
      objective: String(t.objective || '').trim().slice(0, 300),
      input: String(t.input || '').trim().slice(0, 2000),
      deliverable: String(t.deliverable || 'Markdown 文档').trim().slice(0, 300),
      acceptance: acceptance.length ? acceptance : ['产出可直接使用，无占位内容'],
      dependsOn: [...new Set(mapped)],
    };
  });

  // 断环：DFS 检测，发现回边就删掉该依赖
  breakCycles(normalized);

  const assumptions = Array.isArray(raw?.assumptions)
    ? raw.assumptions.map((a) => String(a).trim()).filter(Boolean).slice(0, 3)
    : [];

  return {
    title: String(raw?.title || goal.slice(0, 18)).trim().slice(0, 40),
    understanding: String(raw?.understanding || '').trim().slice(0, 500),
    complexity: ['simple', 'moderate', 'complex'].includes(raw?.complexity) ? raw.complexity : 'moderate',
    assumptions,
    tasks: normalized,
  };
}

function breakCycles(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const color = new Map(); // 0 未访问 1 在栈 2 完成

  function visit(id) {
    const st = color.get(id) || 0;
    if (st === 2) return;
    if (st === 1) return; // 已在栈上，由调用方断边
    color.set(id, 1);
    const t = byId.get(id);
    if (t) {
      for (const dep of [...t.dependsOn]) {
        const stDep = color.get(dep) || 0;
        if (stDep === 1) {
          // dep 指向栈上的节点 → 环。删掉当前这条边
          t.dependsOn = t.dependsOn.filter((d) => d !== dep);
        } else if (stDep === 0 && byId.has(dep)) {
          visit(dep);
        }
      }
    }
    color.set(id, 2);
  }

  for (const t of tasks) visit(t.id);

  // 二次保险：自依赖
  for (const t of tasks) t.dependsOn = t.dependsOn.filter((d) => d !== t.id);
}

/**
 * 计算执行分层：同一层可完全并行。
 * 返回 [{ level: 0, tasks: [...] }, ...]
 */
export function computeLayers(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const levelOf = new Map();

  function level(id, guard = new Set()) {
    if (levelOf.has(id)) return levelOf.get(id);
    if (guard.has(id)) return 0;
    guard.add(id);
    const t = byId.get(id);
    const deps = (t?.dependsOn || []).filter((d) => byId.has(d));
    const lv = deps.length ? Math.max(...deps.map((d) => level(d, guard))) + 1 : 0;
    guard.delete(id);
    levelOf.set(id, lv);
    return lv;
  }

  for (const t of tasks) level(t.id);

  const buckets = new Map();
  for (const t of tasks) {
    const lv = levelOf.get(t.id) || 0;
    if (!buckets.has(lv)) buckets.set(lv, []);
    buckets.get(lv).push(t);
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([lv, list]) => ({ level: lv, tasks: list }));
}

/**
 * 规划。失败时带错误信息重试一次——模型第一次输出非法 JSON 很常见。
 */
export async function plan({ goal, roles, extra, model, workspace }) {
  const system = planSystemPrompt(roles, Boolean(workspace));
  const user = planUserPrompt(goal, extra);
  const useModel = model || config.planModel;

  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const userForAttempt = attempt === 1
      ? user
      : `${user}\n\n【上一次输出的问题】\n${lastErr?.message || '格式不合法'}\n请严格按要求只输出一个合法 JSON 对象。`;

    // 第一次用快模型（省时），失败后升级到强模型重试（保底）
    const attemptModel = attempt === 1 ? useModel : config.modelStrong;
    const res = await complete({
      model: attemptModel,
      system,
      user: userForAttempt,
      maxTokens: config.maxTokensPlan,
      temperature: attempt === 1 ? 0.4 : 0.1,
      effort: attempt === 1 ? config.planEffort : 'high',
    });

    if (res.finishReason === 'length') {
      lastErr = new Error('输出被 max_tokens 截断，JSON 不完整。请减少任务数量或缩短字段内容。');
      continue;
    }

    try {
      const raw = extractJson(res.content);
      const normalized = normalizePlan(raw, roles, goal);
      return { plan: normalized, model: res.model, usage: res.usage, reasoning: res.reasoning };
    } catch (err) {
      lastErr = err;
    }
  }

  throw new Error(`规划失败：${lastErr?.message || '未知错误'}`);
}

export { findRole };
