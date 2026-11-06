# ADR-003: hash 路由集中为注册表式 router

## 状态

已接受

## 背景

现状 hash 路由散在三个 boot 函数里：app.js 的 `boot` 解析 `#job/(.+)`，dev.js 的 `bootDev` 解析 `#dev/(.+)`，arch.js 的 boot 解析 `#arch/(.+)`；写 hash 的 `history.replaceState` 出现在 6 处（doPlan、loadJob、btnNew、loadDevRun、archScan、loadArchRun）。路由逻辑没有独立边界，也无法在"新加一个视图"时有一处可改的注册点。

需要决定：路由收拢后的形态，以及保留哪些现有行为。

## 备选方案

### 方案 A：注册表式 router

`router.js` 持有一张路由表，每个视图启动时 `registerRoute({ pattern, view, load })` 注册自己的 pattern 和 loader。router 提供 `bootstrap()`（解析一次 location.hash 并分发）、`navigate(hash)`、`clearHash()`。写 hash 统一走 `history.replaceState`。

- 代价：需要在每个视图模块里新增 registerRoute 调用，迁移时要保证三个 pattern 的正则和现状完全一致。

### 方案 B：只搬位置，保留三处 boot 各自解析

把三个 boot 的 hash 解析原样搬进各自的 ESM 模块，不引入 router。

- 代价：路由逻辑仍然三处，本次拆分的"路由边界"目标落空；以后加视图还是要改三处认知。

### 方案 C：改用 history API 路径路由（`/job/<id>`）

把 hash 改成 path，用 pushState/popstate。

- 代价：所有现有链接（`#job/<id>`）失效，书签和分享链接作废；后端要加 SPA fallback（否则刷新 404）；改动面远超"拆分前端"的任务范围。

## 决策

选方案 A：注册表式 router，保持 hash 格式与 replaceState 写法不变。

理由：

1. 路由表把"有哪些路由、各自负责什么"从三个 boot 的散落代码变成一张可读的表，这是路由边界的落地形态。
2. 保持 `#job/<id>` 格式和 `history.replaceState`（而非 pushState）意味着所有现有链接、刷新直达、Ctrl+Enter 行为零变化——这是任务书里"不影响现在 hash 路由"的硬约束。
3. 方案 C 会破坏现有链接，超出本次范围，直接排除。

## 后果

- 好处：hash 解析、分发、写 hash 三件事只有一个入口；新视图只需 registerRoute 一处；`clearHash()` 把 btnNew 里 `history.replaceState(null, '', location.pathname)` 的语义显式化。
- 代价：三个视图迁移时都要动 boot 逻辑（把 hash 解析换成 registerRoute）；router 与视图通过注册回调解耦，但 boot 时的加载顺序依赖依然存在——router 必须先于视图 bootstrap 之前完成注册，main.js 要保证这个时序。
- 后续约束：**v1 不监听 `hashchange`**，与现状一致（现状只在 boot 解析一次，前进/后退按钮不会重新加载视图）。若要支持前进/后退，作为 roadmap 批 2 的独立增强，不在本次迁移里顺手做，避免引入 back 按钮导航的回归。写 hash 只允许 `history.replaceState`，禁止 pushState 污染历史栈。
