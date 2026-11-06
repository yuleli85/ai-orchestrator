# ADR-001: 按域拆分 HTTP 路由，server.js 只做挂载与健康检查

## 状态
已接受

## 背景
server.js 771 行，所有 `/api/*` 路由在一个 `createServer` 回调里用线性 if/else 处理。三个业务域（jobs / dev / arch）的路由、roles、health、静态服务、三个 SSE handler、toMarkdown 全部堆在同一个文件。改任何一条路由都要和无关代码挤进同一个 diff，且没有测试脚本兜底，改动只能靠手工回归。这个文件再堆下去会破千行，冲突面和回归成本都在涨。

## 备选方案

### 方案 B：引入路由框架（express 或自研路由表）
- 做法：上 express，或手写一个「路径模式 → handler」的注册表，把端点注册进去。
- 代价：引入第三方依赖（当前项目零运行时依赖，`npm install express` 会让部署多一步、多一个供应链面）；若自研路由表，等于为一个 20 来个端点的系统造一个通用框架，框架本身的边界、错误处理、测试都要维护，投入远超本次收益。

### 方案 C：不拆，继续在 server.js 里堆
- 做法：维持单文件，新增端点继续往里加 if/else。
- 代价：文件继续膨胀，第四个智能体域（如果做）要再加一个 SSE handler 和一组路由，冲突面线性增长；「改一处漏三处」的风险从隐患变成常态。

### 方案 A（选定）：按域拆 router，前缀分发
- 做法：`lib/http/{jobsRouter,devRouter,archRouter,staticRouter}.js`，每个导出 `handle(req, res, url)` 返回是否处理；server.js 按 `url.pathname` 前缀把请求分给对应 router，只保留 health、roles 三分支、兜底 404/405、进程启动。
- 代价：新增 `lib/http/` 子目录，与现有 lib 平铺风格不一致；约 20 个端点的迁移工作量；从 `lib/http/` 出发的相对 import 路径要统一成 `../store.js` 这类写法，容易写错。

## 决策
选方案 A。理由：

1. 这是**纯重构**，对外 API 逐字节不变，前端无感知，可以用「旧前端打在新 server.js 上不报错」作为验收线。
2. 拆分边界跟着业务域走（jobs / dev / arch 本来就是三个独立的 run 生命周期），不是为拆而拆。
3. 不引入任何新依赖，回滚就是 git 回退。

## 后果

- 好处：
  - server.js 从 771 行降到约 120 行，只做挂载、health、roles 和启动日志。
  - 每个域的端点改动只碰自己那个 router 文件，diff 范围可控。
  - 将来加第四个智能体域，只需新增一个 router 和一个 SSE 适配，不再动 server.js 主干。
- 代价：
  - `lib/http/` 打破了 lib 平铺约定，目录层级多了一层；这是本次拆分引入的长期风格负债。
  - 迁移期间 server.js 和 routers 并存，容易出现「改了一半、某条路由还留在 server.js」的中间态，需要靠 roadmap 的分批策略控制。
- 后续约束：
  - 业务模块（store/devrun/archrun/executor 等）永远不能 import `lib/http/*`，否则循环依赖会把 HTTP 层焊死在业务层上。
  - `lib/http/` 内只允许出现「HTTP 适配」逻辑，不允许出现领域判断（比如「这个 job 能不能 replan」必须留在业务层）。
