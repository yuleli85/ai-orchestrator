# 架构文档索引

这个目录下的文档由架构智能体产出（总控台「架构」标签）。不同主题分目录存放，避免 ADR 编号互相撞车、README 互相覆盖。

| 主题 | 目录 | 解决什么问题 | 产出 |
|---|---|---|---|
| 后端 HTTP 层拆分 | [backend-http-split/](./backend-http-split/README.md) | 后端逻辑平铺在 `lib/` 下，`server.js` 承担了路由、SSE、导出、静态资源全部职责 | 目标架构 + 3 份 ADR + 接口契约 + 演进路径 |
| 前端 ESM 拆分 | [frontend-esm-split/](./frontend-esm-split/README.md) | `public/app.js` 超一千行，三个视图逻辑混在一个文件，hash 路由散落各处 | 目标架构 + 3 份 ADR + 接口契约 + 演进路径 |

两个主题互不依赖，可以分别落地。

## 怎么读

每份子目录里的 `README.md` 是导航，先看它。`architecture.md` 是目标状态（含 Mermaid 图），`ADR-*.md` 记录单个决策的取舍，`contracts.md` 是模块间接口，`roadmap.md` 是分批落地顺序。

`ADR` 里最该看的是 `## 后果` 一节——它写清了这么做的代价和后续约束，比"好处"重要得多。

## 说明

- 这些文档是**设计产物，不是既成事实**。代码是否已经按这里写的改了，以 `git log` 为准。
- 第一轮（后端拆分）的 `README.md` / `architecture.md` / `contracts.md` / `roadmap.md` 曾被第二轮覆盖过，已从运行备份 `data/arch-runs/arch_mw3orm8z04bh/backup/` 还原。
- 前端那轮把同一批决策写了两遍（`ADR-001~003` 和 `ADR-004~006`），已保留润色后的版本并回填编号，被取代的三份留在 `data/arch-runs/arch_mw3orm8z04bh/superseded/`。
