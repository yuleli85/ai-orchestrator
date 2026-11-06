# ADR-002: 用 createSseHandler 工厂统一三个 SSE 端点

## 状态
已接受

## 背景
server.js 里有 `sseHandler`（jobs）、`sseDevHandler`（dev）、`sseArchHandler`（arch）三个函数，主体结构完全相同：响应头、心跳、closed 标志、cleanup、快照补发、subscribe、终态关闭。但三处存在真实差异，且这些差异现在靠注释钉死：

1. **快照后是否立即关闭**：jobs 用 `!isRunning(jobId)` 直接关；dev/arch 必须用 `!isRunning && status ∈ 终态` 才关——因为前端先连 SSE 再 POST 启动，连接建立时任务还没跑。
2. **终态事件判定**：jobs 认 `job:done` 一个事件；dev/arch 认 `dev:error` / `arch:error` 或 `dev:status` / `arch:status` 且 status 属于终态集合。
3. **终态关闭延迟**：jobs 250ms，dev/arch 400ms。

这三处差异是「复制粘贴最容易漏」的地方。加第四个智能体域时，新 handler 大概率会从三个里随手复制一个，然后三处差异至少错一处。

## 备选方案

### 方案 B：只抽公共小函数，三个 handler 保留
- 做法：抽 `sseHeaders` / `sseHeartbeat` / `makeCleanup` 几个小函数，三个 handler 继续各自写快照、订阅、终态判断。
- 代价：只消掉一半复制，最危险的差异（快照后关闭条件、终态事件判定）仍分散在三处，新增端点还是要手工对齐这三处，错误模式没有根除。

### 方案 C：SSE 逻辑下沉到各 run 模块
- 做法：devrun/archrun/executor 各自提供「把事件流接上 res」的能力。
- 代价：业务模块要 import `node:http` 的 `res`，破坏「业务模块不碰 HTTP」的边界；三个模块仍各写一份，重复问题没解决，只是换了个目录。

### 方案 A（选定）：一个工厂 + 参数化差异点
- 做法：`createSseHandler(options)` 接收 `getRun` / `isRunning` / `subscribe` / `buildSnapshot` / `shouldCloseAfterSnapshot` / `isTerminalEvent` / `closeDelayMs` / `notFound` 八个参数，返回 `(req, res, id) => void`。
- 代价：工厂签名比「复制三份」抽象一层，读的人要先看参数表才能理解每个端点的行为；将来若某域需要完全不同的 SSE 语义，工厂参数可能不够用。

## 决策
选方案 A。理由：

1. 差异被显式化。三个端点的所有差异收进一张参数表（见 contracts.md），加第四个端点时不再靠「从三份里挑一份复制」，而是填一张表。
2. 工厂不 import 任何业务模块，`subscribe` / `isRunning` / `getRun` 通过参数注入，保持 HTTP 层对业务层单向依赖。
3. 工厂本身是纯 HTTP 逻辑，最容易用 `node:test` 做回归保护，补测试的性价比最高。

## 后果

- 好处：
  - 三个 SSE 端点从约 180 行三份重复，收敛为工厂一份 + 三份约 20 行的参数表。
  - 「快照后关闭条件」和「终态事件判定」这两个历史踩坑点从注释变成强制参数，漏填或填错会在工厂里直接暴露。
- 代价：
  - 抽象多了一层，新人读代码要先啃参数表，不能像现在一样「看一个 handler 就懂全部」。
  - 工厂参数是三个域的最大公约数，如果未来某域需要完全不同的 SSE 行为（比如多路复用、断线重放游标），这个工厂会成为约束。
- 后续约束：
  - `createSseHandler` 内部不得 import 任何业务模块，否则工厂退化成一个伪装的分发器。
  - 新增 SSE 端点必须先填 contracts.md 的参数表，表里没列出的差异就是实现 bug 的信号。
