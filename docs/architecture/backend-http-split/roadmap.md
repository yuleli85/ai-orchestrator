# 演进路径：三批落地，每批可独立上线、可回滚

拆分原则：**每批完成后，旧前端打在新 server.js 上必须无感知**。任何一批不能单独上线的，就不该进这批。纯重构，回滚统一靠 git 回退，不需要数据迁移。

## 批次 1：抽公共 HTTP 件 + SSE 工厂（无行为变化）

- 新建 `lib/http/util.js`，搬 `sendJson` / `ok` / `fail` / `readBody`。
- 新建 `lib/http/sse.js`，实现 `createSseHandler`。
- server.js 里三个 handler 改为调用工厂，参数按 contracts.md 的表填。
- **验收**：三个 SSE 端点行为与拆分前逐字节一致——`curl` 连上后看到同样的 `: connected`、快照、心跳、终态关闭。用 jobs/dev/arch 各跑一轮全流程人工核对。
- **可回滚**：此批只新增文件 + 改 server.js 三个函数，行为等价，git 回退即恢复。

## 批次 2：拆出四个 router（迁移，对外 API 不变）

- 新建 `lib/http/staticRouter.js`，搬 `serveStatic` + MIME。
- 新建 `lib/jobs/export.js`，搬 `toMarkdown`。
- 新建 `lib/http/jobsRouter.js` / `devRouter.js` / `archRouter.js`，按 contracts.md 的 `handle` 约定迁移各自端点。
- server.js 瘦身：保留 health、roles 三分支、前缀分发、兜底 404/405、启动日志。
- **验收**：跑通前端全部功能——建任务/规划/执行/取消/导出、dev 建 run/设计/执行/回滚、arch 诊断/选方案/写文档/预览/回滚、roles 增删、health、静态页加载。任何一条 API 的响应字段或状态码变了都算失败。
- **可回滚**：此批是纯迁移，对外契约不变；上线时 server.js 与 router 的中间态风险靠「一批拆完再切」控制，不要跨批次留半拆状态。

## 批次 3：为拆出的纯函数补回归测试

- 用 Node 内置 `node:test`（项目 `engines.node >= 18`，无需新依赖），`package.json` 增加 `"test": "node --test"`。
- 至少覆盖：
  - `createSseHandler`：快照补发、`shouldCloseAfterSnapshot` 为 true 时立即关、终态事件触发延迟关闭、`req` close 时 cleanup 幂等。
  - `toMarkdown`：有 summary / 无 summary / 含未完成子任务 / 含失败 run 四种输入的输出断言。
- **验收**：`npm test` 全绿，且这三个测试在后续任何一次改 SSE 或导出格式时能拦住回归。
- **可回滚**：测试独立，不影响运行代码。

## 明确不做（除非另开任务）

- lib 平铺目录按域重构（config/sandbox/llm/store 等重新归类）——这是诊断里的 low 项，方案 A 明确不解决。
- 补 planner/executor/devagent/archagent 的核心算法测试——成本高，不在本次拆分范围。
- 引入 express 或任何运行时依赖——维持零依赖部署。
