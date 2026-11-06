# 接口契约：前端模块

本文件只写跨模块的对外契约（函数签名、错误约定、事件载荷），不写实现。落地时照着这些签名搬现有函数。

## 1. shared 层

### shared/dom.js

```
export function $(sel, root = document) → Element | null
```

### shared/html.js

```
export function escapeHtml(s) → string
export function inline(text) → string
export function mdToHtml(src) → string
```

`mdToHtml` 只支持现有实现覆盖的语法（代码块、表格、标题、引用、列表、分割线、行内强调/链接/行内代码），不扩语法面。

### shared/http.js

```
export async function api(path, opts = {}) → Promise<any>
```

- 请求头固定 `Content-Type: application/json`；`opts.body` 存在时 `JSON.stringify`，否则不设 body。
- 响应 JSON 解析失败 → `throw new Error('服务返回异常（HTTP ' + res.status + '）')`。
- `!res.ok || json.ok === false` → `throw new Error(json.error || 'HTTP ' + res.status)`。
- 成功 → 返回 `json.data`。
- **错误约定**：调用方只靠 `try/catch` 拿 `err.message` 展示，不检查错误码。迁移时保持这个约定，不引入错误码枚举。

### shared/ui.js

```
export function toast(msg, isErr = false) → void
```

### shared/format.js

```
export function shorten(s, n) → string
```

从现有 app.js 的 `shorten` 原样搬，dev/arch 列表共用。

### shared/picker.js

```
export function pickDirectory({ start = '', warn = '', title = '选择目录' }) → Promise<string | null>
```

取消返回 `null`；返回选中的绝对路径。从 dev.js 原样搬，arch 视图不再跨文件借用。

### shared/view.js

```
export function switchView(view) → void   // view ∈ 'main' | 'dev' | 'arch'
export function bindTabs() → void          // 绑定顶部 tab 点击 → switchView
```

- `switchView` 切换 `.tab` 的 active 状态和 `#viewMain` / `#viewDev` / `#viewArch` 的 hidden。
- 切到 dev 时调用 `renderWs()` + `refreshDevRuns()`；切到 arch 时调用 `renderArchWs()` + `refreshArchRuns()`。**这两个刷新函数迁 ESM 后是显式 import，不再用 `typeof renderArchWs === 'function'` 守卫**（守卫是普通 script 顺序加载的遗留物）。

## 2. router.js

```
export function registerRoute({ pattern, view, load }) → void
export function navigate(hash, { replace = true }) → void
export function clearHash() → void
export function bootstrap() → void
```

- `registerRoute`：`pattern` 是 `RegExp`，如 `/^#job\/(.+)$/`；`view` 是 `'main' | 'dev' | 'arch'`（仅用于诊断，不参与分发）；`load: (captured: string[]) => void | Promise<void>` 按捕获组传参。允许 `load` 返回 Promise，router 不 await、不吞异常（调用方自己 try/catch）。
- `navigate(hash, { replace = true })`：统一走 `history.replaceState(null, '', hash)`，**禁止 pushState**。hash 为空串时等价于 clearHash。
- `clearHash()`：`history.replaceState(null, '', location.pathname)`——btnNew 现有清 hash 行为的等价封装。
- `bootstrap()`：读一次 `location.hash`，按注册顺序找第一个 `pattern` 命中者，调用其 `load`；无 hash 或无命中时不调用任何 `load`，默认停在 main 视图。**不监听 hashchange**（与现状一致）。

### 路由表（目标态）

| pattern | view | load |
|---|---|---|
| `/^#job\/(.+)$/` | main | `([id]) => loadJob(decodeURIComponent(id))` |
| `/^#dev\/(.+)$/` | dev | `([id]) => { switchView('dev'); loadDevRun(decodeURIComponent(id)); }` |
| `/^#arch\/(.+)$/` | arch | `([id]) => { switchView('arch'); loadArchRun(decodeURIComponent(id)); }` |

## 3. 视图入口

每个视图目录导出一个 `init` 函数，由 main.js 调用，调用顺序与现状脚本加载顺序一致（main → dev → arch）：

```
// views/main/index.js（入口文件，内部文件划分见 architecture.md）
export function initMain()   // 内部：bindEvents() + registerRoute(#job)
export function initDev()    // 内部：bindDevEvents() + registerRoute(#dev)
export function initArch()   // 内部：bindArchEvents() + registerRoute(#arch)
```

main.js 组装顺序：

```
initMain() → initDev() → initArch() → router.bootstrap()
```

## 4. state 单例

每个视图一个模块单例，跨视图不共享：

```
// views/main/state.js
export const state = {
  roles: [], jobs: [], job: null,
  phase: 'idle',          // idle | planning | planned | running | done
  live: new Map(),        // taskId -> { text, reasoning }
  summaryText: '', es: null,
  nodes: new Map(),       // taskId -> card element（本批保留，批 2 分离）
  expanded: new Set(),
}
```

`dev` / `arch` 的 state 结构照搬现有 `devState` / `archState`，字段一个不增不减。

## 5. SSE 事件（总控台 views/main/events.js 消费）

这是前端与后端 server.js 的既有契约，迁移必须逐条保持处理行为不变。**dev / arch 各自的事件分支照搬现有 `handleDevEvent` / `handleArchEvent` 的 switch case，不在此表重复。**

| 事件类型 | 载荷字段 | 迁移后处理行为（与现状 handleEvent 一致） |
|---|---|---|
| `job:snapshot` | `runs[]`, `summary?` | 补齐 DONE/RUNNING/FAILED 卡片状态；`summary` 非空且本地为空时渲染；`updateProgress()` |
| `job:start` | - | `phase = 'running'`；`renderStage()` |
| `task:start` | `taskId` | 清空该任务 live.text/reasoning；`patchStatus(taskId, 'RUNNING')` |
| `task:delta` | `taskId`, `text` | `live.get(taskId).text += text`；`appendOutput(taskId, text)` |
| `task:reasoning` | `taskId`, `text` | `live.get(taskId).reasoning += text`（不直接渲染） |
| `task:done` | `taskId`, `output`, `durationMs` | `live.text = output`；`patchStatus(taskId, 'DONE', durationMs)`；`updateProgress()` |
| `task:error` | `taskId`, `error` | `patchStatus(taskId, 'FAILED', null, error)`；`updateProgress()` |
| `task:retry` | `taskId`, `attempt`, `error` | 在卡片 `.output` 末尾追加"— 第 N 次失败，正在重试 —" |
| `summary:start` | - | `summaryText = ''`；summarySlot 渲染 spinner |
| `summary:delta` | `text` | `summaryText += text`；`.prose` 重渲染为 mdToHtml(summaryText) + caret |
| `summary:done` | `content` | `summaryText = content`；渲染最终 `.prose` |
| `summary:error` | `error` | 渲染失败提示 |
| `job:done` | - | `phase = 'done'`；关闭 es 并置 null；刷新 jobs 列表 |

## 6. 幂等与并发要求

- `loadJob` / `loadDevRun` / `loadArchRun` 在开始前必须先 `close` 现有 EventSource（现状已如此），避免旧流继续写新卡片。
- `attachStream` 系列函数每次只允许一个活动 EventSource：新建前 `close` 旧的。这是现状行为，迁移后作为契约固定。
- `navigate` / `clearHash` 可重复调用（replaceState 天然幂等），不得产生历史栈堆积。
