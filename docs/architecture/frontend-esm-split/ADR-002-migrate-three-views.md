# ADR-002: 三个视图文件一起迁移，共享层抽为 src/shared

## 状态

已接受

## 背景

任务书只提了"拆分 app.js"，但读代码发现 dev.js 和 arch.js 依赖 app.js 的全局函数（`$`、`escapeHtml`、`mdToHtml`、`api`、`toast`、`shorten`），arch.js 还依赖 dev.js 的 `switchView`、`pickDirectory`。如果只把 app.js 迁成 ESM，它的函数不再挂全局，dev.js / arch.js 会在加载时抛 `ReferenceError`。

因此必须决定：迁移范围是 app.js 一个文件，还是三个文件一起，共享层如何处理。

## 备选方案

### 方案 A：三视图一起迁 ESM，共享层抽为 src/shared/*

app.js / dev.js / arch.js 同时迁成 `src/views/*`，共用的 `$`/`escapeHtml`/`mdToHtml`/`api`/`toast`/`shorten`/`pickDirectory`/`switchView` 抽到 `src/shared/*`，谁用谁 import。

- 代价：迁移范围扩大到三个文件，回归面更大；需要把 `pickDirectory`（现属 dev.js）和 `switchView`（现属 dev.js）挪到 shared，改动不止 app.js。

### 方案 B：只拆 app.js，保留全局兼容桥

app.js 迁 ESM 后，main.js 把 shared 的函数挂到 `window.__shared`，dev.js / arch.js 保持普通 script，继续读全局。

- 代价：全局耦合只是换了个名字继续存在；需要写一套桥接层，批 2 删桥时还要再动 dev/arch 一次；三份文件里 shared 的调用方式不统一（app 走 import，dev/arch 走全局）。

### 方案 C：只拆 app.js，dev/arch 各自复制一份工具函数

- 代价：`escapeHtml`/`mdToHtml`/`pickDirectory` 等出现三份拷贝，行为漂移；dev/arch 注释里"共享全局工具函数"的问题从"隐式共享"变成"显式复制"，没有更好。

## 决策

选方案 A：三个视图一起迁，共享层抽为 `src/shared/*`。

理由：

1. 三个文件本来就同时加载、同时上线，不存在"只上线一半"的中间态，一起迁不增加部署复杂度。
2. 方案 B 的桥接层是纯负资产——它在本批结束时就注定要删，等于为一次原子迁移多写一层一次性的间接。
3. 共享层抽出来之后，dev/arch 对 app.js 的隐式依赖彻底消失，这正是本次拆分的核心目标；只拆 app.js 达不到这个目标。

## 后果

- 好处：全局函数依赖清零，加载顺序不再决定功能是否可用；`pickDirectory` 这个"dev 定义、arch 复用"的错位归属被纠正到 shared；每个视图文件只含自己的状态机、渲染和事件。
- 代价：迁移范围从 1 个文件扩到 3 个文件，回归测试要覆盖三个视图各自的状态机（总控、开发、架构）而不只是总控；`shared/view.js` 的 `switchView` 目前内部用 `typeof renderArchWs === 'function'` 做跨文件守卫，迁成 ESM 后这个守卫需要改成显式 import（消除守卫是改进，但属于改动点）。
- 后续约束：views/* 之间禁止互相 import；新增共享逻辑必须先判断该放 shared 还是具体视图，避免 shared 变成第二个 app.js 垃圾桶。**本批不改 state 与 DOM 缓存的耦合**（`state.nodes` 仍存在，renderStage 仍全量重建），那是 roadmap 批 2 的独立目标。
