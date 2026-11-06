# 接口契约（本次拆分新增的内部契约）

对外 HTTP API 逐字节不变，这里只记录拆分后新增的内部接口。所有函数用 ESM 具名导出，风格与现有 lib 保持一致。

## 1. `lib/http/sse.js`：createSseHandler

```js
createSseHandler({
  getRun,                    // (id) => run | null；null 时回 404
  notFound,                  // string，404 消息文案
  isRunning,                 // (id) => boolean
  subscribe,                 // (id, fn) => unsubscribe；fn 收到的是事件对象
  buildSnapshot,             // (run) => object，必须含 type 字段
  shouldCloseAfterSnapshot,  // (run, running) => boolean，快照补发后是否立即关闭
  isTerminalEvent,           // (evt) => boolean，订阅后收到该事件是否触发关闭
  closeDelayMs,              // number，终态后延迟关闭的毫秒数
}) => (req, res, id) => void
```

工厂职责：写 SSE 响应头、发心跳（15s 一条 `: ping`）、发 `: connected`、补发快照、建立订阅、按 `isTerminalEvent` 关闭、响应 `req` 的 close/error。工厂不 import 任何业务模块。

### 三个实例的参数表（开发照着填，不要靠猜）

| 参数 | jobs（任务） | dev（开发智能体） | arch（架构智能体） |
|---|---|---|---|
| getRun | `getJob` | `getDevRun` | `getArchRun` |
| notFound | `'任务不存在'` | `'运行记录不存在'` | `'运行记录不存在'` |
| isRunning | `executor.isRunning` | `devrun.isRunning` | `archrun.isRunning` |
| subscribe | `executor.subscribe` | `devrun.subscribe` | `archrun.subscribe` |
| buildSnapshot.type | `'job:snapshot'` | `'dev:snapshot'` | `'arch:snapshot'` |
| shouldCloseAfterSnapshot | `!running` | `!running && status ∈ 终态` | `!running && status ∈ 终态` |
| isTerminalEvent | `evt.type === 'job:done'` | `evt.type === 'dev:error'` 或 `evt.type === 'dev:status' && status ∈ 终态` | `evt.type === 'arch:error'` 或 `evt.type === 'arch:status' && status ∈ 终态` |
| closeDelayMs | `250` | `400` | `400` |

终态集合（dev/arch 一致）：`DONE / FAILED / CANCELLED / ROLLED_BACK`。`DIAGNOSED`（arch 等用户选方案）和 `PLANNED`（dev 等用户点执行）**不是**终态。

### 快照字段（从现 server.js 原样搬，字段名不得改）

- `job:snapshot`：`{ type, status, runs: [{ taskId, status, output, durationMs, error }], summary }`
- `dev:snapshot`：`{ type, status, step, design, trace, changes, commands, summary, verification, remaining, error, running }`
- `arch:snapshot`：`{ type, status, step, diagnosis, selectedOptionId, docs, trace, summary, decisions, risks, remaining, error, running }`

## 2. router 模块约定

每个 router 导出：

```js
export function handle(req, res, url) => boolean  // 处理了返回 true，否则 false
```

- `url` 是 `new URL(req.url, ...)` 解析好的对象，pathname 用 `url.pathname`。
- server.js 按前缀分发：

| 前缀 | router |
|---|---|
| `/api/jobs` | jobsRouter |
| `/api/dev/runs` 或 `/api/fs/list` | devRouter |
| `/api/arch/runs` | archRouter |
| 其它 `/api/*` | server.js 自己处理（health、roles） |
| 非 `/api/*` | staticRouter |

注意：`/api/fs/list` 不在 `/api/dev/*` 前缀下，但它是 dev 域工作区选择器的一部分，**归 devRouter.handle 处理**，不要在 server.js 里单独挂它。

## 3. `lib/jobs/export.js`

```js
export function toMarkdown(job, roles) => string
```

- 输入：完整 job 对象 + `listRoles()` 返回的角色数组。
- 输出：Markdown 字符串，内容与现 server.js 的 toMarkdown 逐字一致（含「原始需求 / 生成时间 / 已做假设 / 汇总 / 未完成标注 / 附录分工明细」）。
- 不负责：HTTP 响应头。`Content-Type: text/markdown` 和 `Content-Disposition` 由 jobsRouter 设置。

## 4. SSE 事件类型（拆分后仍由业务模块发出，路由层只透传）

SSE 工厂需要感知的只有「终态判定」用到的几个：

- jobs：`job:done`
- dev：`dev:error`、`dev:status`
- arch：`arch:error`、`arch:status`

其余事件（`job:start` / `task:delta` / `summary:delta` / `dev:file` / `dev:cmd` / `arch:doc` 等）路由层不解析、不判断，原样 JSON 序列化后写进 `data:` 行。**任何 router 都不得去理解或改写业务事件的内容**，否则路由层就掺进了领域逻辑。
