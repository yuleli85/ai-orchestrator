# 演进路径

## 批 1（本次）：ESM 迁移 + 共享层 + 路由集中

一次原子迁移，纯前端文件重组，后端零改动、零 API 变更，可独立上线、可回滚。

### 落地顺序（建议）

1. 建 `src/shared/*`，从 app.js / dev.js 逐函数搬入，每个函数搬完立即在源文件里改成 import 调用（或最后统一改，取决于团队习惯）。
2. 建 `src/router.js`，实现 registerRoute / navigate / clearHash / bootstrap。
3. 迁 `views/main`：state → api → render → stream → events → actions → bind，最后在 index.js 导出 `initMain`。
4. 迁 `views/dev`、`views/arch`，同样顺序。
5. 改 `index.html`：三个 script 合并为一个 `<script type="module" src="/src/main.js">`。
6. 全量回归（验收清单见下），通过后删旧 `public/app.js` / `dev.js` / `arch.js`。

### 验收清单（逐条过，全过才算完成）

- 无 hash：默认总控台空态，健康检查、角色加载、历史列表正常。
- `#job/<id>` 刷新直达：加载任务，running 时自动 `attachStream` + `subscribeExisting` 补齐快照。
- `#dev/<id>` 刷新直达：自动切 dev 视图并加载；`#arch/<id>` 同理。
- `doPlan` 成功后 hash 变为 `#job/<id>`；`btnNew` 清 hash 且复位 stage/state。
- Ctrl/Cmd+Enter 触发拆解。
- 总控台 SSE 全事件类型逐条验证（task:delta / task:done / task:error / summary:delta / summary:done / job:done 等，对照 contracts.md 第 5 节）。
- 三视图 tab 切换、dev/arch 目录选择器（`pickDirectory`）、取消、回滚均可操作。
- `file://` 双击打开：报"需通过 HTTP 服务"——这是预期行为变化，不是回归。

### 回滚方式

`index.html` 指回旧三个 script；旧 `public/app.js` / `dev.js` / `arch.js` 在批 1 合并前保留（先删后合或 git revert 均可）。`src/` 目录不回滚也不影响运行（无入口引用）。

### 为什么批 1 不拆得更细

拆成"先迁 main 再迁 dev/arch"需要一个全局兼容桥（见 ADR-002 方案 B），桥是批末就删的一次性代码。单开发者工具里，一次原子迁移 + 完整回归比留桥更省、更少引入新 bug。

## 批 2（后续可选，不随本次）

每项都是独立增强，与批 1 的迁移目标无关，混进来只会放大回归面：

1. **监听 `hashchange`**：让前进/后退按钮重新加载对应视图。现状只在 boot 解析一次 hash，这是刻意的行为边界（ADR-003），批 2 才考虑是否放开。
2. **state 与 DOM 缓存分离**：把 `state.nodes`（taskId → card element）从 store 移出，render 返回独立缓存对象。现状 renderStage 重建 innerHTML 后手动清空重建 nodes，分离后才能谈增量渲染。
3. **renderStage 增量更新**：用事件驱动的小步 DOM 更新替代全量 `innerHTML` 重建。依赖第 2 项，否则缓存生命周期不清楚。
