# ADR-003: toMarkdown 归 lib/jobs/export.js，不放进 staticRouter

## 状态
已接受

## 背景
`toMarkdown(job, roles)` 现在在 server.js 里，服务于 `GET /api/jobs/:id/export`，负责把 job 渲染成 Markdown 交付稿（含标题、原始需求、假设、汇总、任务明细、附录）。它和路由、静态服务、SSE 混在同一个文件里。方案 A 给了两个去向：随静态服务进 staticRouter，或单独落到 `lib/jobs/export.js`。

## 备选方案

### 方案 B：放进 staticRouter
- 做法：toMarkdown 和 serveStatic 放一个文件，staticRouter 同时管静态文件和导出渲染。
- 代价：staticRouter 的职责变成「静态 IO + jobs 域展示」两件不相关的事；且它必须 import store 和 roles 才能跑 toMarkdown，静态服务从此不再是零业务依赖的纯 IO，目录穿越防护这类安全敏感代码被迫和领域逻辑共用一个文件。

### 方案 C：留在 server.js
- 做法：不迁，server.js 瘦身后仍带着这个函数。
- 代价：server.js 拆完还是带 jobs 域的展示逻辑，职责没清干净；后续改导出格式还得动进程入口文件。

### 方案 A（选定）：lib/jobs/export.js
- 做法：toMarkdown 单独成 `lib/jobs/export.js`，jobsRouter import 它做导出路由。
- 代价：为一个小函数单建一个文件和一个 `lib/jobs/` 目录，目录结构里多一个「只有一个文件」的域目录。

## 决策
选方案 A。理由：

1. 导出格式是 jobs 域的领域逻辑，不是 HTTP 传输、更不是静态文件服务。它和「把 job 渲染成交付稿」的归属一致，天然归 jobs 域。
2. 让 staticRouter 保持零业务依赖，目录穿越防护和 MIME 表这些安全/传输关注点不被打扰。
3. 将来导出格式扩展（PDF、HTML、docx）时，`lib/jobs/export.js` 可以自然长出多个导出器，而不用动 HTTP 层。

## 后果

- 好处：
  - server.js 和 staticRouter 都不再沾领域展示逻辑，职责边界干净。
  - toMarkdown 是纯函数，单独成文件后补测试零成本（构造 job + roles 即可断言输出）。
- 代价：
  - `lib/jobs/` 目录目前只有一个文件，和「按域分目录」的长期目标相比略显单薄，属于为未来留的坑位。
- 后续约束：
  - 导出器只负责「数据 → 文档字符串」，不写 HTTP 响应头；`Content-Disposition`、`Content-Type` 留在 jobsRouter。
