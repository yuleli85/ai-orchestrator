import fs from 'node:fs';
import path from 'node:path';

/**
 * 项目画像扫描器。纯本地计算，不调用模型。
 *
 * 存在的理由：架构设计最普遍的失败模式是"不看代码就谈架构"——
 * 模型凭项目名和几个文件名，套一个教科书分层，说得头头是道但和真实代码无关。
 * 所以这里先把能算的东西算出来：模块边界、依赖方向、循环依赖、分层违规、
 * 上帝模块、耦合热点。模型拿到的是事实，而不是自己脑补的想象。
 *
 * 所有统计都做了上限保护，超大仓库不会把内存撑爆。
 */

const SKIP_DIRS = new Set([
  '.git', '.svn', '.hg',
  'node_modules', 'bower_components', 'jspm_packages',
  'dist', 'build', 'out', 'target', 'bin', 'obj', 'release',
  '.next', '.nuxt', '.svelte-kit', '.output', '.turbo', '.parcel-cache',
  'coverage', '.nyc_output', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  '__pycache__', '.venv', 'venv', 'env', '.tox', 'site-packages',
  '.idea', '.vscode', '.gradle', '.mvn', 'vendor', 'third_party',
  '.cache', 'tmp', 'temp', 'logs', 'log', '.DS_Store',
]);

const CODE_EXT = new Map([
  ['.js', 'JavaScript'], ['.mjs', 'JavaScript'], ['.cjs', 'JavaScript'], ['.jsx', 'JavaScript'],
  ['.ts', 'TypeScript'], ['.tsx', 'TypeScript'], ['.mts', 'TypeScript'], ['.cts', 'TypeScript'],
  ['.java', 'Java'], ['.kt', 'Kotlin'], ['.kts', 'Kotlin'],
  ['.py', 'Python'], ['.go', 'Go'], ['.rs', 'Rust'], ['.cs', 'C#'],
  ['.php', 'PHP'], ['.rb', 'Ruby'], ['.scala', 'Scala'], ['.swift', 'Swift'],
  ['.vue', 'Vue'], ['.svelte', 'Svelte'],
  ['.sql', 'SQL'], ['.sh', 'Shell'], ['.ps1', 'PowerShell'],
]);

const CONFIG_EXT = new Set(['.yml', '.yaml', '.toml', '.ini', '.properties', '.conf', '.env', '.xml']);

/**
 * 测试代码识别。必须排除，否则诊断结论会系统性偏差：
 * 测试文件天然依赖被测模块，混进依赖图会凭空造出"上帝模块"和虚假耦合，
 * 模型看到的就是"几乎什么都依赖几乎什么"的假象。
 */
const TEST_PATH_RE = /(^|\/)(src\/test|src\/it|test|tests|__tests__|__mocks__|spec|specs|e2e|integration-test|integration-tests|testdata|fixtures)(\/|$)/i;
const TEST_FILE_RE = /(Test|Tests|TestCase|IT|Spec|_test|\.test|\.spec)\.(java|kt|kts|js|mjs|ts|tsx|jsx|py|go|cs|php|rb)$/i;

/**
 * 路径级跳过。存在的理由：本工程自己会生成 data/dev-runs/<id>/backup/ 这类回滚备份，
 * 里面是被改过的源码副本，一旦被当成项目源码扫进去，模块统计和循环依赖全是假的。
 */
const SKIP_PATH_RE = /(^|\/)(dev-runs|arch-runs|backup|\.workbuddy|\.scratch|cache)(\/|$)/i;

/** 常见"代码容器"目录名。它们作为模块出现时不该被当成上帝模块——它们本来就是放模块的地方。 */
const CONTAINER_NAMES = new Set(['lib', 'libs', 'src', 'source', 'app', 'apps', 'core', 'internal', 'pkg', 'main', 'server', 'client', 'modules', 'packages', 'components']);

/** 分层识别规则。顺序有意义：先匹配到的赢。 */
const LAYER_RULES = [
  {
    layer: 'presentation',
    label: '表现层',
    re: /(^|\/)(controller|controllers|api|apis|handler|handlers|resource|resources|endpoint|endpoints|view|views|page|pages|component|components|ui|http|rest|web|servlet|filter|filters|interceptor|interceptors|middleware|routes?|router)(\/|$)/i,
  },
  {
    layer: 'application',
    label: '应用层',
    re: /(^|\/)(service|services|usecase|usecases|application|app|command|commands|query|queries|workflow|workflows|orchestration|orchestrator|job|jobs|task|tasks)(\/|$)/i,
  },
  {
    layer: 'domain',
    label: '领域层',
    re: /(^|\/)(domain|model|models|entity|entities|aggregate|aggregates|valueobject|valueobjects|vo|dto|dtos|pojo|pojos|core|business|bean|beans|enum|enums)(\/|$)/i,
  },
  {
    layer: 'infrastructure',
    label: '基础设施层',
    re: /(^|\/)(infra|infrastructure|repository|repositories|dao|daos|mapper|mappers|persistence|db|database|storage|client|clients|adapter|adapters|gateway|gateways|provider|providers|driver|drivers|mq|kafka|redis|cache)(\/|$)/i,
  },
  {
    layer: 'shared',
    label: '公共层',
    exempt: true,
    re: /(^|\/)(util|utils|common|commons|shared|helper|helpers|support|lib|libs|base|constant|constants|exception|exceptions|error|errors|type|types|interface|interfaces|config|configs|configuration)(\/|$)/i,
  },
];

/** 层间依赖方向：key 可以依赖 value 里的层。不在表里的一律算违规。 */
const LAYER_DEPS = {
  presentation: new Set(['application', 'domain', 'shared']),
  application: new Set(['domain', 'infrastructure', 'shared']),
  domain: new Set(['shared']),
  infrastructure: new Set(['domain', 'shared']),
  shared: new Set(['shared']),
};

const LAYER_ORDER = ['presentation', 'application', 'domain', 'infrastructure', 'shared'];

const MAX_FILE_BYTES = 512 * 1024;
const MAX_LINES_SCAN = 8000;

function humanSize(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/* ---------------- 1. 遍历与基础统计 ---------------- */

function walk(root, { maxFiles, onFile }) {
  const out = [];
  let truncated = false;

  (function rec(dir, relDir) {
    if (out.length >= maxFiles) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= maxFiles) {
        truncated = true;
        return;
      }
      if (e.name.startsWith('.') && e.name !== '.env.example' && e.name !== '.gitignore') continue;
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (SKIP_PATH_RE.test(`${rel}/`)) continue;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name.toLowerCase())) continue;
        rec(path.join(dir, e.name), rel);
      } else if (e.isFile()) {
        let size = 0;
        try {
          size = fs.statSync(path.join(dir, e.name)).size;
        } catch {
          /* ignore */
        }
        const ext = path.extname(e.name).toLowerCase();
        const item = {
          rel,
          name: e.name,
          ext,
          size,
          lang: CODE_EXT.get(ext) || null,
          isConfig: CONFIG_EXT.has(ext),
          isTest: TEST_PATH_RE.test(rel) || TEST_FILE_RE.test(e.name),
        };
        out.push(item);
        onFile?.(item);
      }
    }
  })(path.resolve(root), '');

  return { files: out, truncated };
}

function countLines(full, size) {
  if (size > MAX_FILE_BYTES) return -1;
  try {
    const text = fs.readFileSync(full, 'utf8');
    if (text.includes('\u0000')) return -1;
    let n = 0;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
    return n + (text.length && text[text.length - 1] !== '\n' ? 1 : 0);
  } catch {
    return -1;
  }
}

/* ---------------- 2. import 解析 ---------------- */

const JS_IMPORT_RES = [
  /(?:^|[\s;])import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g,
  /(?:^|[\s;])export\s+(?:[\s\S]*?\s+from\s+)['"]([^'"]+)['"]/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function parseJsImports(text) {
  const out = new Set();
  for (const re of JS_IMPORT_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) out.add(m[1]);
  }
  return [...out];
}

function parseJavaImports(text) {
  const out = new Set();
  const re = /^\s*import\s+(?:static\s+)?([\w.]+)\s*;/gm;
  let m;
  while ((m = re.exec(text))) out.add(m[1]);
  return [...out];
}

function parsePythonImports(text) {
  const out = new Set();
  const reFrom = /^\s*from\s+(\.*[\w.]*)\s+import\s+([^\n#]+)/gm;
  let m;
  while ((m = reFrom.exec(text))) {
    const mod = m[1];
    if (!mod || mod.startsWith('.')) continue;
    out.add(mod);
    // from a.b import c, d 也可能是 from a.b import c 的子模块
    const names = m[2].split(',').map((s) => s.trim().split(/\s+/)[0]).filter(Boolean);
    for (const n of names) if (n !== '*') out.add(`${mod}.${n}`);
  }
  const reImp = /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm;
  while ((m = reImp.exec(text))) {
    for (const part of m[1].split(',')) {
      const p = part.trim().split(/\s+/)[0];
      if (p) out.add(p);
    }
  }
  return [...out];
}

function parseGoImports(text) {
  const out = new Set();
  const block = /import\s*\(([\s\S]*?)\)/g;
  let m;
  while ((m = block.exec(text))) {
    const re = /"([^"]+)"/g;
    let mm;
    while ((mm = re.exec(m[1]))) out.add(mm[1]);
  }
  const single = /^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/gm;
  while ((m = single.exec(text))) out.add(m[1]);
  return [...out];
}

function extractImports(text, lang) {
  switch (lang) {
    case 'JavaScript':
    case 'TypeScript':
    case 'Vue':
    case 'Svelte':
      return parseJsImports(text);
    case 'Java':
    case 'Kotlin':
    case 'Scala':
      return parseJavaImports(text);
    case 'Python':
      return parsePythonImports(text);
    case 'Go':
      return parseGoImports(text);
    default:
      return [];
  }
}

/* ---------------- 3. 依赖落点解析 ---------------- */

const JS_RESOLVE_EXTS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts', '.vue', '.svelte', '.json'];
const JS_INDEX = ['index.js', 'index.ts', 'index.tsx', 'index.mjs', 'index.cjs', 'index.vue'];

function makeResolver(fileSet) {
  const has = (rel) => fileSet.has(rel);

  return function resolve(spec, fromRel, lang) {
    // --- JS/TS 相对路径 ---
    if (lang === 'JavaScript' || lang === 'TypeScript' || lang === 'Vue' || lang === 'Svelte') {
      if (spec.startsWith('.')) {
        const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
        if (has(base)) return base;
        for (const ext of JS_RESOLVE_EXTS) if (has(base + ext)) return base + ext;
        for (const idx of JS_INDEX) if (has(`${base}/${idx}`)) return `${base}/${idx}`;
        // 去掉 .js 换 .ts（TS 项目常见写法 import './x.js' 实际文件是 x.ts）
        if (/\.js$/.test(base)) {
          const ts = base.replace(/\.js$/, '.ts');
          if (has(ts)) return ts;
        }
        return null;
      }
      // 别名 @/ → src/
      if (spec.startsWith('@/')) {
        const base = `src/${spec.slice(2)}`;
        if (has(base)) return base;
        for (const ext of JS_RESOLVE_EXTS) if (has(base + ext)) return base + ext;
        for (const idx of JS_INDEX) if (has(`${base}/${idx}`)) return `${base}/${idx}`;
        return null;
      }
      return null; // 外部包
    }

    // --- Java/Kotlin ---
    if (lang === 'Java' || lang === 'Kotlin' || lang === 'Scala') {
      const p = spec.replace(/\./g, '/');
      const suffixes = lang === 'Java' ? ['.java'] : lang === 'Kotlin' ? ['.kt'] : ['.scala'];
      for (const suf of suffixes) {
        // 直接在源根下找
        for (const candidate of fileSet) {
          if (candidate.endsWith(`${p}${suf}`)) return candidate;
        }
      }
      return null;
    }

    // --- Python ---
    if (lang === 'Python') {
      const p = spec.replace(/\./g, '/');
      const cands = [`${p}.py`, `${p}/__init__.py`];
      for (const c of cands) {
        if (has(c)) return c;
        // 相对源根
        for (const f of fileSet) {
          if (f.endsWith(`/${c}`)) return f;
        }
      }
      return null;
    }

    // --- Go ---
    if (lang === 'Go') {
      for (const f of fileSet) {
        if (f.startsWith(`${spec}/`) || path.posix.dirname(f) === spec) return f;
      }
      return null;
    }

    return null;
  };
}

/** 提取外部依赖包名 */
function externalPackage(spec, lang) {
  if (lang === 'JavaScript' || lang === 'TypeScript' || lang === 'Vue' || lang === 'Svelte') {
    if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('@/')) return null;
    if (spec.startsWith('node:')) return spec;
    const parts = spec.split('/');
    if (spec.startsWith('@')) return parts.slice(0, 2).join('/');
    return parts[0];
  }
  if (lang === 'Java' || lang === 'Kotlin' || lang === 'Scala') {
    return spec.split('.').slice(0, 2).join('.');
  }
  if (lang === 'Python') return spec.split('.')[0];
  if (lang === 'Go') return spec.split('/').slice(0, 3).join('/');
  return spec;
}

/* ---------------- 4. 模块边界推断 ---------------- */

/**
 * 推断源码根。策略：统计每个目录前缀覆盖的代码文件数，
 * 取覆盖率 >= 60% 且路径最深的那一层。这样 Java 项目能落到 `.../pay`，
 * 前端项目能落到 `src`，而不会因为有个别的脚本目录就误判到仓库根。
 */
function inferSourceRoot(codeFiles) {
  if (!codeFiles.length) return '';
  const counts = new Map();
  for (const f of codeFiles) {
    let dir = path.posix.dirname(f.rel);
    while (dir && dir !== '.' && dir !== '/') {
      counts.set(dir, (counts.get(dir) || 0) + 1);
      const next = path.posix.dirname(dir);
      if (next === dir) break;
      dir = next;
    }
  }

  const total = codeFiles.length;
  let best = '';
  let bestDepth = -1;
  for (const [dir, n] of counts) {
    if (n / total < 0.6) continue;
    const depth = dir.split('/').length;
    if (depth > bestDepth) {
      best = dir;
      bestDepth = depth;
    }
  }

  // 容器性校验：如果 best 下的代码全是平铺的（没有子目录），说明它是"放文件的目录"
  // 而不是"放模块的目录"，拿它当源根会让所有文件都落进 (root)，模块划分信息全丢。
  // 这种情况往上退一层，让上一级目录直接子目录成为模块。
  while (best) {
    const hasNested = codeFiles.some((f) => {
      if (!f.rel.startsWith(`${best}/`)) return false;
      return f.rel.slice(best.length + 1).includes('/');
    });
    if (hasNested) break;
    const up = path.posix.dirname(best);
    best = up === '.' || up === '/' ? '' : up;
  }

  return best;
}

/** 模块名 = 源码根下的第一级目录；直接躺在源根下的文件归 "(root)" */
function moduleOf(rel, sourceRoot) {
  let relToRoot = rel;
  if (sourceRoot) {
    if (!rel.startsWith(`${sourceRoot}/`)) return '(outside)';
    relToRoot = rel.slice(sourceRoot.length + 1);
  }
  const parts = relToRoot.split('/');
  if (parts.length === 1) return '(root)';
  return parts[0];
}

function layerOf(rel) {
  for (const rule of LAYER_RULES) {
    if (rule.re.test(rel)) return rule;
  }
  return null;
}

/* ---------------- 5. 环检测 ---------------- */

function findCycles(graph, limit = 8) {
  const cycles = [];
  const seen = new Set();
  const nodes = [...graph.keys()];

  for (const start of nodes) {
    if (cycles.length >= limit) break;
    const stack = [];
    const onStack = new Set();
    const visited = new Set();

    (function dfs(node) {
      if (cycles.length >= limit) return;
      stack.push(node);
      onStack.add(node);
      visited.add(node);

      for (const next of graph.get(node) || []) {
        if (cycles.length >= limit) break;
        if (onStack.has(next)) {
          const i = stack.indexOf(next);
          const cyc = stack.slice(i);
          // 归一化，避免 a->b->a 和 b->a->b 算两条
          const key = [...cyc].sort().join('|') + `:${cyc.length}`;
          if (!seen.has(key) && cyc.length > 1) {
            seen.add(key);
            cycles.push([...cyc, next]);
          }
        } else if (!visited.has(next)) {
          dfs(next);
        }
      }

      stack.pop();
      onStack.delete(node);
    })(start);
  }
  return cycles;
}

/* ---------------- 主入口 ---------------- */

export function profile(workspace, { maxFiles = 20000 } = {}) {
  const root = path.resolve(workspace);
  const { files, truncated } = walk(root, { maxFiles });

  const allCodeFiles = files.filter((f) => f.lang);
  // 测试代码只统计规模，不进模块/依赖/分层分析（理由见 TEST_PATH_RE 注释）
  const codeFiles = allCodeFiles.filter((f) => !f.isTest);
  const testFiles = allCodeFiles.filter((f) => f.isTest);

  // 行数
  let totalLines = 0;
  let sourceLines = 0;
  let testLines = 0;
  for (const f of allCodeFiles) {
    const n = countLines(path.join(root, f.rel), f.size);
    f.lines = n;
    if (n <= 0) continue;
    totalLines += n;
    if (f.isTest) testLines += n;
    else sourceLines += n;
  }

  // 语言分布
  const byLang = new Map();
  for (const f of codeFiles) {
    const cur = byLang.get(f.lang) || { lang: f.lang, files: 0, lines: 0 };
    cur.files++;
    if (f.lines > 0) cur.lines += f.lines;
    byLang.set(f.lang, cur);
  }
  const langs = [...byLang.values()].sort((a, b) => b.lines - a.lines);

  const sourceRoot = inferSourceRoot(codeFiles);
  const fileSet = new Set(files.map((f) => f.rel));
  const resolver = makeResolver(fileSet);

  // ---- 依赖分析 ----
  const fileDeps = new Map(); // rel -> Set(rel)
  const fileRevDeps = new Map(); // rel -> Set(rel)，被谁引用
  const externalCount = new Map();
  let parsedDepsCount = 0;
  let unresolvedInternal = 0;

  for (const f of codeFiles) {
    if (!['JavaScript', 'TypeScript', 'Java', 'Kotlin', 'Scala', 'Python', 'Go', 'Vue', 'Svelte'].includes(f.lang)) continue;
    if (f.size > MAX_FILE_BYTES) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(root, f.rel), 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\u0000')) continue;
    let specs = extractImports(text, f.lang);
    if (specs.length > MAX_LINES_SCAN) specs = specs.slice(0, MAX_LINES_SCAN);

    const deps = new Set();
    for (const spec of specs) {
      const target = resolver(spec, f.rel, f.lang);
      if (target) {
        if (target !== f.rel) deps.add(target);
      } else {
        const ext = externalPackage(spec, f.lang);
        if (ext) externalCount.set(ext, (externalCount.get(ext) || 0) + 1);
        else if (spec.startsWith('.')) unresolvedInternal++;
      }
    }
    if (deps.size) {
      fileDeps.set(f.rel, deps);
      for (const d of deps) {
        if (!fileRevDeps.has(d)) fileRevDeps.set(d, new Set());
        fileRevDeps.get(d).add(f.rel);
      }
      parsedDepsCount += deps.size;
    }
  }

  // ---- 模块聚合 ----
  const moduleMap = new Map();
  for (const f of codeFiles) {
    const m = moduleOf(f.rel, sourceRoot);
    const cur = moduleMap.get(m) || { name: m, files: 0, lines: 0, langs: new Set(), sample: [] };
    cur.files++;
    if (f.lines > 0) cur.lines += f.lines;
    cur.langs.add(f.lang);
    if (cur.sample.length < 5) cur.sample.push(f.rel);
    moduleMap.set(m, cur);
  }

  const moduleGraph = new Map();
  const moduleEdgeCount = new Map(); // "a->b" -> n
  for (const [from, deps] of fileDeps) {
    const fm = moduleOf(from, sourceRoot);
    for (const to of deps) {
      const tm = moduleOf(to, sourceRoot);
      if (fm === tm) continue;
      moduleEdgeCount.set(`${fm}\u0000${tm}`, (moduleEdgeCount.get(`${fm}\u0000${tm}`) || 0) + 1);
      if (!moduleGraph.has(fm)) moduleGraph.set(fm, new Set());
      moduleGraph.get(fm).add(tm);
    }
  }
  for (const name of moduleMap.keys()) if (!moduleGraph.has(name)) moduleGraph.set(name, new Set());

  // ---- 循环依赖 ----
  const cycles = findCycles(moduleGraph, 10);

  // ---- 分层违规 ----
  const violations = [];
  const violationKey = new Set();
  for (const [from, deps] of fileDeps) {
    const fl = layerOf(from);
    if (!fl || fl.exempt) continue;
    for (const to of deps) {
      const tl = layerOf(to);
      if (!tl || tl.exempt) continue;
      if (fl.layer === tl.layer) continue;
      const allowed = LAYER_DEPS[fl.layer];
      if (allowed && allowed.has(tl.layer)) continue;
      const key = `${fl.layer}->${tl.layer}`;
      if (violationKey.has(key)) {
        const v = violations.find((x) => `${x.fromLayer}->${x.toLayer}` === key);
        if (v && v.samples.length < 3) v.samples.push(`${from} → ${to}`);
        if (v) v.count++;
      } else {
        violationKey.add(key);
        violations.push({
          fromLayer: fl.layer,
          fromLabel: fl.label,
          toLayer: tl.layer,
          toLabel: tl.label,
          rule: `${fl.label}不应直接依赖${tl.label}`,
          count: 1,
          samples: [`${from} → ${to}`],
        });
      }
    }
  }

  // ---- 热点：被引用最多的文件 ----
  const hotspots = [...fileRevDeps.entries()]
    .map(([rel, set]) => ({ path: rel, inbound: set.size, module: moduleOf(rel, sourceRoot) }))
    .filter((h) => h.inbound >= 2)
    .sort((a, b) => b.inbound - a.inbound)
    .slice(0, 15);

  // ---- 上帝模块 ----
  const totalCodeFiles = codeFiles.length || 1;
  const godModules = [...moduleMap.values()]
    .map((m) => ({ name: m.name, files: m.files, lines: m.lines, share: m.files / totalCodeFiles }))
    .filter((m) => m.share >= 0.3 && m.files >= 8 && !CONTAINER_NAMES.has(m.name.toLowerCase()))
    .sort((a, b) => b.files - a.files);

  // ---- 入口点 ----
  const ENTRY_RE = /(^|\/)(main|index|app|server|bootstrap|application|Application|Main|Program|Startup|manage|wsgi|asgi)\.(js|mjs|ts|java|kt|py|go|cs|php|rb)$/;
  const entryPoints = codeFiles.filter((f) => ENTRY_RE.test(f.rel)).map((f) => f.rel).slice(0, 12);

  // ---- 配置文件 ----
  const configs = files.filter((f) => f.isConfig || /^(package\.json|pom\.xml|build\.gradle|go\.mod|Cargo\.toml|requirements\.txt|pyproject\.toml|composer\.json|Gemfile|Dockerfile|docker-compose\.ya?ml)$/.test(f.name)).map((f) => f.rel).slice(0, 25);

  // ---- 分层统计 ----
  const layerStats = {};
  for (const f of codeFiles) {
    const l = layerOf(f.rel);
    const key = l ? l.layer : 'unclassified';
    layerStats[key] = (layerStats[key] || 0) + 1;
  }

  // ---- 输出 ----
  const modules = [...moduleMap.values()]
    .map((m) => {
      const outbound = [...(moduleGraph.get(m.name) || [])];
      const inbound = [...moduleGraph.entries()].filter(([, s]) => s.has(m.name)).map(([k]) => k);
      return {
        name: m.name,
        files: m.files,
        lines: m.lines,
        langs: [...m.langs],
        outbound,
        inbound,
        sample: m.sample,
      };
    })
    .sort((a, b) => b.files - a.files);

  const externals = [...externalCount.entries()]
    .map(([name, refs]) => ({ name, refs }))
    .sort((a, b) => b.refs - a.refs)
    .slice(0, 30);

  const result = {
    workspace: root,
    scannedAt: Date.now(),
    truncated,
    sourceRoot,
    stats: {
      files: files.length,
      codeFiles: codeFiles.length,
      testFiles: testFiles.length,
      totalLines,
      sourceLines,
      testLines,
      depEdges: parsedDepsCount,
      unresolvedInternal,
    },
    langs,
    modules,
    externals,
    cycles,
    violations,
    hotspots,
    godModules,
    entryPoints,
    configs,
    layerStats,
  };

  result.text = profileText(result);
  return result;
}

/* ---------------- 文本化：给模型看的紧凑画像 ---------------- */

function profileText(p) {
  const L = [];
  L.push(`【项目】${p.workspace}`);
  const testNote = p.stats.testFiles ? `；测试 ${p.stats.testFiles} 个文件 / ${p.stats.testLines} 行（不计入下面的依赖分析）` : '；无测试代码';
  L.push(`【规模】源码 ${p.stats.codeFiles} 个文件 / ${p.stats.sourceLines} 行${testNote}`);
  L.push(`【语言】${p.langs.slice(0, 6).map((l) => `${l.lang} ${l.files}文件/${l.lines}行`).join('，') || '未识别到代码'}`);

  if (p.sourceRoot) L.push(`【源码根】${p.sourceRoot}/`);

  if (p.modules.length) {
    L.push('');
    L.push('【模块（按文件数排序）】');
    for (const m of p.modules.slice(0, 25)) {
      const label = m.name === '(outside)' ? '(源根之外的代码，如脚本/SQL/其他源根)' : m.name === '(root)' ? '(源根直属文件)' : m.name;
      const deps = m.outbound.length ? ` → 依赖 ${m.outbound.slice(0, 6).join('、')}${m.outbound.length > 6 ? '…' : ''}` : ' → 无出向依赖';
      const inb = m.inbound.length ? `；被 ${m.inbound.slice(0, 5).join('、')}${m.inbound.length > 5 ? '…' : ''} 引用` : '';
      const samples = m.name === '(outside)' || m.name === '(root)' ? ` ［${m.sample.slice(0, 3).join('、')}］` : '';
      L.push(`- ${label}：${m.files} 个文件 / ${m.lines} 行${deps}${inb}${samples}`);
    }
  }

  if (p.cycles.length) {
    L.push('');
    L.push('【模块级循环依赖（必须处理）】');
    for (const c of p.cycles) L.push(`- ${c.join(' → ')}`);
  } else if (p.modules.length) {
    L.push('');
    L.push('【模块级循环依赖】未发现');
  }

  if (p.violations.length) {
    L.push('');
    L.push('【分层违规】');
    for (const v of p.violations) {
      L.push(`- ${v.rule}（${v.count} 处）例：${v.samples[0]}`);
    }
  }

  if (p.layerStats && Object.keys(p.layerStats).length) {
    const ls = p.layerStats;
    const parts = LAYER_ORDER.filter((k) => ls[k]).map((k) => {
      const rule = LAYER_RULES.find((r) => r.layer === k);
      return `${rule ? rule.label : k} ${ls[k]}`;
    });
    if (ls.unclassified) parts.push(`未匹配常见分层 ${ls.unclassified}（按业务垂直切分时属正常，不必强行改成分层目录）`);
    L.push('');
    L.push(`【分层分布】${parts.join('，')}`);
  }

  if (p.godModules.length) {
    L.push('');
    L.push('【上帝模块（占比过高，是重构首要目标）】');
    for (const g of p.godModules) L.push(`- ${g.name}：${g.files} 个文件，占全部代码 ${(g.share * 100).toFixed(0)}%`);
  }

  if (p.hotspots.length) {
    L.push('');
    L.push('【耦合热点（被引用最多，改动影响面最大）】');
    for (const h of p.hotspots.slice(0, 10)) L.push(`- ${h.path}（被 ${h.inbound} 处引用）`);
  }

  if (p.externals.length) {
    L.push('');
    L.push(`【外部依赖 Top】${p.externals.slice(0, 14).map((e) => `${e.name}(${e.refs})`).join('、')}`);
  }

  if (p.entryPoints.length) {
    L.push('');
    L.push(`【入口点】${p.entryPoints.join('、')}`);
  }

  if (p.configs.length) {
    L.push('');
    L.push(`【配置文件】${p.configs.join('、')}`);
  }

  return L.join('\n');
}

/**
 * 查某个文件的上下游，给模型的 deps_of 工具用。
 * profiled 可传入已算好的画像，避免每次调用都全量重扫（大仓库一次要几秒）。
 */
export function depsOf(workspace, rel, { profiled } = {}) {
  const root = path.resolve(workspace);
  const p = profiled || profile(root, { maxFiles: 20000 });
  const target = path.posix.normalize(String(rel).replace(/\\/g, '/'));
  const module = p.modules.find((m) => m.name === moduleOf(target, p.sourceRoot));
  if (!module) throw new Error(`找不到 ${target} 所属的模块，先用 list_files 确认路径`);
  return {
    module: module.name,
    outbound: module.outbound,
    inbound: module.inbound,
    cycles: p.cycles.filter((c) => c.includes(module.name)),
    siblings: module.sample,
  };
}

export { layerOf, moduleOf, inferSourceRoot, humanSize };
