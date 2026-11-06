# 前端拆分架构设计 · 总览

## 这次要解决的问题

`public/` 下三个前端脚本（app.js 32KB、dev.js 24KB、arch.js 24KB）通过全局变量隐式耦合，加载顺序即依赖顺序：

- app.js 定义了 `$`、`escapeHtml`、`inline`、`mdToHtml`、`toast`、`api`、`shorten` 等全局函数；
- dev.js 直接使用上述函数，并定义了 `switchView`、`pickDirectory` 供 arch.js 使用；
- arch.js 同时依赖 app.js 和 dev.js 的全局函数。

加载顺序是 app.js → dev.js → arch.js（index.html 里的 script 顺序），任何顺序调整都会抛 `ReferenceError`，但这份依赖关系只存在于"谁先加载谁定义"的隐式约定里，没有一处显式声明。

同时 app.js 单文件混合六类职责：DOM 工具、API 客户端、全局状态、视图渲染、SSE 事件处理、hash 路由。本次设计把前端重组织为 ESM 模块：共享层归共享层、路由归 router、每个视图归自己的目录。

## 关键结论（先看这里）

1. **不该"按视图拆 app.js"。** 视图拆分已经做过——dev.js 和 arch.js 早就是独立文件。真正的问题是 app.js 内部职责混杂，以及三个文件靠全局函数耦合。
2. **怎么拆不影响 hash 路由：** 路由格式（`#job/<id>`、`#dev/<id>`、`#arch/<id>`）和 `history.replaceState` 写法原样保留，只把"解析 hash + 写 hash"从三个 boot 函数里收拢到 `router.js` 的一张注册表。刷新直达、发链接、Ctrl+Enter 等现有行为不变。
3. **拆分的真实代价不是"file:// 打不开"。** 现在双击 index.html 也调不通后端——`api()` 用相对路径 `fetch('/api/...')`，file:// 下没有 `/api` 资源，任何操作都会失败。"双击可打开"这条底线在项目长成客户端-服务端架构时就已经失效，ESM 只是把问题从"第一次 API 调用时静默失败"提前到"HTML 加载时就报错"。

## 文档怎么读

按这个顺序：

1. [architecture.md](./architecture.md) —— 现状与目标架构、模块边界、关键数据流、与现状的差异。**先读。**
2. [ADR-001-esm-split.md](./ADR-001-esm-split.md) —— 为什么选原生 ESM 而不是构建工具或继续单文件。
3. [ADR-002-migrate-three-views.md](./ADR-002-migrate-three-views.md) —— 为什么三个视图文件必须一起迁，而不是只拆 app.js。
4. [ADR-003-hash-router.md](./ADR-003-hash-router.md) —— 路由为什么做成注册表而不是 if/else 分发。
5. [contracts.md](./contracts.md) —— 共享层 / router / 视图的接口契约，落地照着写。
6. [roadmap.md](./roadmap.md) —— 分几批落地、每批的验收标准和回滚方式。
