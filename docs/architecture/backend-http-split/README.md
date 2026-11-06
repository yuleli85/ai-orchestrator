# 总控台 HTTP 层拆分（方案 A：路由抽取 + SSE 复用）

## 这次设计解决什么问题

server.js 目前 771 行，把三件事搅在一个文件里：

1. 所有 `/api/*` 路由（jobs / dev / arch / roles / health）用线性 if/else 堆在同一个 `createServer` 回调里；
2. 三个 SSE 端点（`sseHandler` / `sseDevHandler` / `sseArchHandler`）各自复制了心跳、closed 标志、cleanup、快照发送、订阅、终态关闭这一整套逻辑；
3. `toMarkdown` 这种 jobs 域的展示逻辑混在 HTTP 入口里。

结果是任何一次路由改动都要和静态服务、健康检查、三个 SSE handler 挤进同一个 diff，冲突面大；而 SSE 里那些靠注释钉住的差异（jobs 用 `!isRunning` 立即关，dev/arch 用 `!isRunning && 终态` 才关）一旦加第四个端点，几乎必然复制错。

## 结论：该拆，按方案 A 拆

这是一次**纯重构**：对外 HTTP API 逐字节不变，改的是内部文件边界。不引第三方依赖，不碰核心算法（planner / executor / devagent / archagent 一行不改）。

拆完 server.js 只剩：进程入口、路由挂载、健康检查、roles 三个分支（暂留，规模太小）、启动日志。

## 文档导航

| 文档 | 讲什么 |
|---|---|
| [architecture.md](./architecture.md) | 目标结构、各新模块职责边界、关键数据流、与现状差异 |
| [ADR-001](./ADR-001-http-routers-by-domain.md) | 为什么按域拆 router，而不是上路由框架或继续堆 |
| [ADR-002](./ADR-002-sse-handler-factory.md) | 为什么用工厂统一三个 SSE 端点，以及 8 个差异点怎么参数化 |
| [ADR-003](./ADR-003-tomarkdown-location.md) | toMarkdown 为什么归 `lib/jobs/export.js` 而不是 staticRouter |
| [contracts.md](./contracts.md) | `createSseHandler` 签名、三个适配实例的参数表、事件类型契约 |
| [roadmap.md](./roadmap.md) | 分三批落地，每批可独立上线、可回滚 |

## 这次明确不做的事

- **不解决 lib 目录平铺问题**。现有 12 个 lib 文件位置不动，新增的 `lib/http/` 和 `lib/jobs/` 是这次拆分的例外，不算域重构。
- **不补核心算法的测试**。只建议为拆出来的纯函数（SSE 工厂、toMarkdown）补回归测试，因为它俩最好测，也是这次改动风险最高的点。
- **不改任何对外 API 的字段、状态码、错误文案**。拆分验证标准就是「旧前端不感知这次改动」。
