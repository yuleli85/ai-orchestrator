import process from 'node:process';

const env = process.env;

function pick(...names) {
  for (const n of names) {
    const v = env[n];
    if (v && String(v).trim()) return String(v).trim();
  }
  return '';
}

const hasDeepSeek = Boolean(pick('DEEPSEEK_API_KEY', 'ORCH_API_KEY'));

/**
 * 单进程配置。所有可调项都能用环境变量覆盖，便于换供应商。
 *
 * 默认走 DeepSeek（OpenAI 兼容协议），因为本机已有 DEEPSEEK_API_KEY。
 * 换千问/智谱/Kimi 只需改 ORCH_BASE_URL + ORCH_MODEL_*，代码不动。
 */
export const config = {
  port: Number(env.PORT || 5180),
  host: env.HOST || '127.0.0.1',

  // 密钥优先级：专用变量 > 各家原生变量
  apiKey: pick('ORCH_API_KEY', 'DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY', 'ZHIPU_API_KEY', 'MOONSHOT_API_KEY', 'OPENAI_API_KEY'),

  baseUrl: (env.ORCH_BASE_URL || (hasDeepSeek
    ? 'https://api.deepseek.com'
    : 'https://dashscope.aliyuncs.com/compatible-mode/v1')).replace(/\/+$/, ''),

  // 双档模型：快的干执行，强的干兜底与汇总
  modelFast: env.ORCH_MODEL_FAST || 'deepseek-flash',
  modelStrong: env.ORCH_MODEL_STRONG || 'deepseek-v4-pro',

  // 规划用快模型：实测结构化输出质量与强模型相当，耗时少一半（27s vs 55s）。
  // 第一次规划失败会自动升级到 modelStrong 重试，所以快模型不是单点风险。
  planModel: env.ORCH_MODEL_PLANNER || env.ORCH_MODEL_FAST || 'deepseek-flash',

  // 汇总要综合多份产出、消解冲突。实测强模型合并 4300 字要 184s，
  // 而"去重 + 重排 + 补衔接"这类任务快模型完全胜任，所以默认用快的；
  // 需要更强综合能力时用 ORCH_MODEL_SUMMARY 覆盖。
  summaryModel: env.ORCH_MODEL_SUMMARY || env.ORCH_MODEL_FAST || 'deepseek-flash',

  // 推理开销档位：low | high | max。
  // 规划是结构化输出，low 能省一半时间且质量几乎不掉；汇总要综合判断，保持默认档。
  planEffort: env.ORCH_PLAN_EFFORT || 'low',
  summaryEffort: env.ORCH_SUMMARY_EFFORT || '',

  // 同一层最多几个智能体在跑
  concurrency: Math.max(1, Math.min(8, Number(env.ORCH_CONCURRENCY || 3))),

  // 规划约束
  maxTasks: 8,
  minTasks: 1,

  // 单次调用预算。推理模型会把预算先花在思考上，给小了会出现
  // content 为空且 finish_reason=length —— 实测 6000 不够长文档类任务。
  maxTokensPlan: 8000,
  maxTokensTask: 16000,
  maxTokensSummary: 12000,

  // 上游产出喂给下游时的截断长度（字符）
  upstreamClip: 6000,

  // 单个子任务最多尝试次数（含首次）
  taskRetries: 2,

  // 请求超时（毫秒）
  requestTimeout: Number(env.ORCH_TIMEOUT || 300000),

  dataDir: env.ORCH_DATA_DIR || 'data',

  /* ---------------- 开发智能体 ---------------- */

  // 写代码比写文档更难，默认用强模型；嫌慢可换 deepseek-flash
  devModel: env.ORCH_MODEL_DEV || env.ORCH_MODEL_STRONG || 'deepseek-v4-pro',
  devDesignModel: env.ORCH_MODEL_DEV_PLAN || env.ORCH_MODEL_FAST || 'deepseek-flash',

  // 工具循环上限。40 步足够改完一个中等模块；再往上多半是模型在原地打转
  devMaxSteps: Math.max(4, Math.min(80, Number(env.ORCH_DEV_MAX_STEPS || 40))),

  // 单条命令超时（毫秒）。构建/测试可能很久，给到 5 分钟
  devCmdTimeout: Math.max(10000, Number(env.ORCH_DEV_CMD_TIMEOUT || 300000)),

  // 单次工具循环的 token 总预算，超了强制收尾，防跑飞烧钱
  devMaxTokens: Math.max(50000, Number(env.ORCH_DEV_MAX_TOKENS || 600000)),

  // 工作区可挂载的根目录。默认是用户主目录，避免误挂到系统盘根
  devRoot: env.ORCH_DEV_ROOT || process.env.USERPROFILE || process.env.HOME || process.cwd(),

  /* ---------------- 架构智能体 ---------------- */

  // 架构判断比写代码更依赖经验，默认强模型。
  // 但架构产出是文档不是代码，错了改文字即可，风险远低于改代码。
  archModel: env.ORCH_MODEL_ARCH || env.ORCH_MODEL_STRONG || 'deepseek-v4-pro',

  // 诊断阶段额外读的文件数（入口、配置、各模块代表文件、耦合热点）
  archSampleFiles: Math.max(4, Math.min(30, Number(env.ORCH_ARCH_SAMPLE || 14))),

  // 写文档阶段的工具循环上限。文档比代码步骤少，20 步够写 5 份文档
  archMaxSteps: Math.max(6, Math.min(60, Number(env.ORCH_ARCH_MAX_STEPS || 24))),

  // token 预算：诊断一次约 3~5 万，写文档约 20~40 万（要带多份长文档的上下文）
  archMaxTokens: Math.max(50000, Number(env.ORCH_ARCH_MAX_TOKENS || 600000)),

  // 单份文档最大字符数，超了要求拆分成多份
  archMaxDocChars: 120000,
};
