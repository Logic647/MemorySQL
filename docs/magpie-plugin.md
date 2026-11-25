# magpie 社区插件集成(MemorySQL for magpie)

> 状态:2026-11-20 · 插件在 `magpie-plugin/`(建议发布为 `@logic647/tools-memorysql`,
> 或改成 `@magpie-community/tools-memorysql`)。
>
> **默认内置 SQLite 存储:用户只装 magpie 插件就能用,不需要下载 MemorySQL 应用。**
> 已经装了 MemorySQL 的用户可以把 `backend` 切成 `app`,复用它的完整文件捕获与
> LLM 项目总结。本文记录 magpie 插件规范要点、两种后端的架构、决策与验证。

## 1. 目标与定位

- magpie 是「一个本地网关,服务所有 agent」;MemorySQL 是「跨 agent 的会话档案 +
  项目交接知识库」。
- **不要**把 MemorySQL 当成 magpie 内置 Memory 的替代品。magpie 已内建
  `internal/memory`(`~/.config/magpie/memory/*.md`、`/mcp/magpie/memory`、
  语义检索、对话蒸馏、夜间整理、注入 instructions、同步),且**不可插件化替换**。
- 定位:MemorySQL 记「谁在哪个项目做到哪一步」——会话档案、项目交接、项目总结与收工汇报。
  —— 会话档案、项目交接、收工汇报。
- 两种后端:
  - `embedded`(默认):插件自带 SQLite 知识库,零外部依赖;
  - `app`(可选):代理本机正在运行的 MemorySQL 应用,能力更全。

## 2. magpie 插件规范要点(读源码/文档后的结论)

来源:

- <https://github.com/yetone/magpie/blob/main/docs/subsystems/plugin-runtime.md>
- <https://github.com/yetone/magpie/blob/main/docs/subsystems/plugin-tools.md>
- <https://github.com/yetone/magpie/blob/main/docs/subsystems/provider-plugins.md>
- <https://github.com/yetone/magpie/blob/main/site/public/docs/zh/plugins.html>

### 形态与加载

- 插件 = npm 包 / git 仓库 / 本地文件夹;入口是 OpenCode v1 插件函数
  `async (input, options) => hooks`。
- 所有插件跑在同一个 **Bun 宿主进程**(`internal/plugin/host.js`),与 magpie 用
  stdin/stdout 逐行 JSON 通信。
- 一个包可以同时是供应商、工具、中间件、页面、Agent。`package.json` 的
  `magpie` 字段声明 magpie 专属能力,OpenCode 会忽略。
- 入口解析:`exports["./server"]` → `main` → `exports["."]` → `index.ts/js/mjs...`。
  **不要从入口导出辅助函数**——每个导出函数都会被当成插件调用。

### 扩展点

| 扩展点 | 能力 | 本插件 |
|---|---|---|
| `config/auth/provider/fetch` | 把服务变成模型供应商 | 不用 |
| 网关中间件 | 同步改请求/回复 | 不用 |
| **网关钩子 `magpie.hooks`** | `onRequest` 异步等外部 I/O 后改请求;`onResponse` 完成通知 | **自动续接 + 回写** |
| **`tool` 钩子** | 聚合成 `/mcp/magpie/tools`,并自动成为 Library 的 MCP 服务器 | **10 个工具** |
| **`page`** | 侧栏独立页面(sandbox iframe) | **MemorySQL 页** |
| `panels` / `actions` | 自带页面里的卡片 / 行菜单 | **agent 行菜单** |
| `search` / 路由策略 / 用量观察 / Agent | 其他用途 | 不用 |

### 关键约束

- 工具名 = `<插件短名>_<工具名>`。短名会剥掉 scope 和 `tools-`/`page-`/`agent-`
  前缀;**从文件夹安装时短名是文件夹名**。包名用 `tools-memorysql` 才会得到
  `memorysql_*`。
- 工具 `args` 可以是纯 JSON Schema(不需要 zod);每工具最多 55 秒。
- 网关钩子默认 1 秒,选项 `gatewayTimeoutMs` 可调到 30 秒;整条链 2–10 秒;
  失败/超时/畸形返回一律保留原请求(fail open)。
- **钩子拿到的是请求副本**:原地修改后必须 `return body`,否则改动会被丢弃。
- 页面跑在 `sandbox="allow-scripts"` 的 iframe,`connect-src 'none'`,不能
  fetch/存储;需要联网的页面必须用「带路页」导航到插件自己的本地服务
  (`magpie.page.service`)。`magpie web` 下要用桥接的 `magpie.service`。
- 页面/面板可读的只读数据只有 `usage:summary`、`usage:day`、`providers:list`;
  读知识库必须走插件自己的服务。

## 3. 架构

```
agent (Claude Code / Codex / ...)
        │  请求
        ▼
magpie gateway ── onRequest ──► backend.call('memory_get_context')
        │        (首轮注入续接包)        │
        │                                ├─ embedded: bun:sqlite (~/.config/magpie/memorysql/memory.db)
        ├── 路由到模型                     └─ app: MemorySQL MCP (127.0.0.1:8642)
        │
        ▼
magpie tool server /mcp/magpie/tools ──► backend.call('memory_*')
        ▲
        │ tools/call
agent 的 MCP 客户端

magpie 窗口 ── page iframe ──► 插件服务 127.0.0.1:3488 ──► backend
```

### 3.1 后端抽象

`lib/backend/index.mjs` 的 `getBackend(options)` 在同一个 Bun 宿主里缓存一份后端：

| backend | 实现 | 数据 |
|---|---|---|
| `embedded`(默认) | `lib/backend/embedded.mjs` + `bun:sqlite`(单测用 `node:sqlite`) | `~/.config/magpie/memorysql/memory.db`(可用 `dataDir` 改) |
| `app`(可选) | `lib/backend/app.mjs` → `callTool` 代理 MemorySQL MCP | MemorySQL 应用自己的 `memory.db` |

工具、钩子、页面服务都走同一个 `backend.call(name, args)` 接口；切换后端只改
一个选项，上层逻辑不变。

### 3.2 内置存储(embedded)

`lib/backend/schema.mjs` 建 MemorySQL 核心表的一个子集：

- `projects` / `sessions` / `session_messages` / `memories`(字段与 MemorySQL 对齐；
  sessions 时间是**秒**，memories/projects.updated_at 是**毫秒**)；
  v2 加 `source_session_id` / `why` / `distilled_at` / `distilled_count` 与 `project_digests`；
  v3 加 `memory_stats`(每日计数，只存 metric/origin/count，不存正文)与
  `meta.stats_since`(开始逐日统计的日期)
- FTS5 trigram 外部内容表：`sessions_fts` / `messages_fts` / `memories_fts`，
  配 `AFTER INSERT/UPDATE/DELETE` 触发器同步
- 索引：agent/project/scope/status/content
- `PRAGMA journal_mode=WAL`、`busy_timeout=5000`(app/CLI 宿主可能同时开着库)

工具语义与 MemorySQL MCP 对齐：

| 工具 | embedded 行为 |
|---|---|
| `memory_get_context` | 全局/项目记忆 + 最近会话；**全新库返回空串**(钩子据此不注入)；多行记忆保留换行，并声明项目自带 `AGENTS.md` 等指令文件优先 |
| `memory_get_project_brief` | 记忆 + 会话 + 上一棒 tail + 收工汇报候选 |
| `memory_get_project_digest` | **LLM 滚动总结优先**；没有则规则汇编(项目信息 + 最近会话 + 收工汇报待办) |
| `memory_list_projects` | 项目 + 会话数 + 最近活跃；`format=json` |
| `memory_list_sessions` | 项目/agent/时间过滤；`format=json` |
| `memory_get_session` | tail/full + 4 万字符预算(从最新往回填) |
| `memory_search` | FTS5 trigram + `LIKE` 兜底(中文 1–2 字词)；会话/消息/记忆三路；`format=json` 给页面(会话 id + 命中片段) |
| `memory_write` | 去重、scope/项目解析、标签 |
| `memory_log_progress` | 候选进度记忆(不关联最近活跃项目，只认显式 project/cwd) |
| `memory_stats` | 会话/项目/消息/记忆数、最近会话、db 大小 |
| `memory_import_session` | `(agent, externalId)` upsert、消息级 diff、防截短；已删除会话默认 `skipped-deleted`，`revive=true` 才恢复 |

项目解析与 MemorySQL 同口径：`cwd` 按最长路径前缀；否则名字 `LIKE` 优先、
路径 `LIKE` 兜底；写记忆/收工汇报给了 project/cwd 但没命中时**不**回落到最近活跃项目。

### 3.3 网关自动续接

`hooks.mjs` 的 `onRequest`:

1. `getBackend(options)` 决定后端；`capture` 默认值随后端(embedded 开 / app 关)。
2. **记忆注入默认关**：embedded 读页面状态(`distill.json` 的
   `inject`/`injectAll`/`injectAgents`)；`inject=false` 时不注入；`injectAll=true`
   注入全部 agent，否则只注入 `injectAgents` 里的 `agent_type`(空 = 一个都不注入)。
   页面可选的 agent 直接复用 magpie 识别结果：读 `~/.cache/magpie/agents-state.json`
   的 `state.agents`(按显示名 `agentTypeOf` 归一，没会话的也列出)；`bun`/`node`/`magpie`
   等宿主运行时不在列表里，也不会被注入；读不到缓存才回落到 `sessions.agent_type`。
   app 后端没有页面状态，回落到插件选项 `recall`(默认 false)。
3. 先按**客户端原始历史**绑定 capture(注入前)，再注入。
4. 只对本机(`local` / `magpie-key`)生效；`skipAgents`、子代理、magpie 内部请求
   (`memory` / `title` / `classifier`)跳过。
5. 缓存键:`ctx.session`,没有则 `cwd + 第一条用户消息` 的哈希。
6. 调 `memory_get_context({ cwd, agent })`；裁剪到 `maxBytes`，包
   `<memorysql-context>` 后追加到**第一条用户消息**；同一 session 后续请求复用
   缓存块，前缀稳定，prompt cache 不碎。
7. 失败/超时/空结果 → `ctx.report('unavailable'/'empty')` + 返回 `undefined`，
   请求原样放行。内置后端是本地同步查询，通常毫秒级。
8. 首次为某个 session 取到并注入成功后，embedded 记一次 `injected` 活动计数；
   复用缓存块的后续请求不重复计(页面「注入会话」就是它)。

### 3.4 会话回写

`onResponse`:

1. 从 `ctx.state.memorysql` 取注入前保存的历史(不含续接包)。
2. 追加本轮 assistant 文本，调 `memory_import_session`。
3. 内置后端按 `(agent_type, external_id)` upsert，消息级 diff；app 后端由
   MemorySQL 的 `memory_import_session` 做同样的事。
4. 若已有更完整的同源会话(文件捕获)，跳过；网关自己的较短副本默认也不截短
   (`replace: true` 才允许)。

默认:embedded **开**(这是内置库会话档案的唯一来源)；app **关**(MemorySQL
自己会文件捕获，避免双写)。

页面删除会话 = tombstone(`deleted=1`)：列表/搜索/续接包/蒸馏候选都按 `deleted=0`
过滤；同一 `(agent, externalId)` 的后续回写返回 `skipped-deleted`，不会复活已删会话
(显式 `revive: true` 才恢复，消息变少还要 `replace: true`)。

### 3.5 页面与 agent 行菜单

- `page/index.html` + `page/boot.js`:带路页，接 `magpie.onAction({agent})` 后
  导航到 `magpie.service`(magpie web)或 `127.0.0.1:<pagePort>`(桌面)。
- `service.mjs`:Bun 里的本地 HTTP 服务，只绑 127.0.0.1，校验 Host/Origin；
  提供 `/api/status`、`/api/projects`、`/api/sessions`、`/api/sessions/remove`、
  `/api/search`、`/api/context`、`/api/digest`、`/api/session`，以及记忆页的
  `/api/memories`(GET/POST)、`/api/memories/status|remove|pin`、
  `/api/distill`(GET/POST)、`/api/distill/run`、`/api/dream/run`、
  `/api/digest/run`、`/api/digest/generate`，全部转给当前后端。`/api/search` 在内置后端用
  `format:'json'` 拿结构化命中（会话 id + 命中片段 + 时间），app 后端仍返回文本。
  **sandbox iframe 的 Origin 是 `null`**：API 响应显式回
  `Access-Control-Allow-Origin: null` 并处理 `OPTIONS` 预检；每次宿主启动生成
  随机 token 注入页面 HTML 的 `<meta name="memorysql-token">`，API 必须带
  `x-memorysql-token`；静态 HTML 不带 CORS（别的 sandbox 页面读不到 token）。
- `ui/`:状态(内置存储 / MemorySQL 应用)、记忆页、项目列表、
  续接包/总结/会话(显示 `#id`、两步确认删除)、跨 agent 搜索(命中片段高亮、可展开会话、
  同一会话最多先展示 3 条)、项目总结(安静期 + 立即生成)、整理记忆(间隔 + 立即整理)、
  记忆注入开关与目标 agent、所有控件的悬停说明。
  相对路径 + `magpie.service` 兼容 `magpie web`。
- 图标沿用 MemorySQL 应用图标：页面/UI 用 `page/icon.png`；`magpie.icon` 是
  同一图标的 128px data URI(1 万字节左右)，离线和 npm/GitHub 卡片都能显示。
- 页面 token 每次宿主启动轮换：旧页面 API 返回 401 时前端自动 `location.replace`
  带 `?fresh=<时间戳>` 重载一次（<5 秒内不重复，防循环），不必手动刷新。
  从搜索页触发时会把 `view=search&q=…&scope=…` 一起带上，重载后自动恢复并重搜。
- `magpie.actions` 的 `agent-sessions` 出现在 agent 行菜单，打开页面并带 `?agent=`。

### 3.6 记忆页、项目总结与整理

**记忆页**(`ui/` 的「记忆」标签)：

- 状态分段(使用中 / 待确认 / 已归档；已归档含 superseded)、搜索、作用域筛选
- 每行显示首行、作用域/标签/来源、kind 标签、锁定标记、被召回次数/最近召回；
  多行记忆折叠时首行 + `…`，展开后 `pre-wrap` 按原样换行
- 展开可编辑文本/kind/scope/项目/标签/why，确认/归档/恢复/删除/置顶
- 手动添加/编辑的记忆 `source='user'`、`locked=1`，整理永不改动

**记忆活动**(`activity()` + `/api/activity`)：

- `memory_stats(day, metric, origin, n)` 按**本地日期** UPSERT 累加；只存计数，
  不存记忆正文。metric：`created` / `updated` / `cleaned` / `searches` / `found` /
  `recalled` / `injected`
- `created` 按来源分 `user` / `agent` / `inferred`：页面新增、`memory_write`、
  `memory_log_progress`、旧蒸馏候选都算；整理合并出来的算 `updated`，不算新增
- `updated`：页面编辑(内容/kind/scope/项目/标签/why/锁定有变化)、置顶变化、整理合并
- `cleaned` 按执行者分 `you` / `tidy`：记忆从 active/candidate 离开(归档/删除/合并/
  搁置)；删已归档的不重复计
- `searches` / `found` / `recalled`：agent 的 `memory_search`(有结果次数 / 返回条数)；
  `kind=session|message` 与页面自己的搜索(`internal:true`)不计入
- `injected`：网关**首次**为某个会话注入续接包；复用缓存块不重复计
- `meta.stats_since` 是开始逐日统计的日期；之前的日子只有 `created` 按
  `memories.created_at` 回填(排除 `llm-tidy`)，其余指标没有历史
- 页面五个卡片：新增(条/天)、召回率(found/searches)、更新率(updated/active)、
  清理率(cleaned/active)、注入会话数；每个带 7/30 天 sparkline，点开看每日柱子，
  hover/focus 显示当天明细

**模型**：插件在 magpie 的 Bun 宿主里，直接请求本机网关
`POST <gateway>/v1/chat/completions`(loopback 免 key)。项目总结和整理记忆共用：
页面选择(`distill.json.model`) > 插件选项 `model` > magpie 记忆蒸馏的
`lastModel`(`~/.config/magpie/distill.json`) > 网关 `/v1/models` 第一个。
没有可用模型时状态行提示，不影响续接/工具。

**项目总结**(`runDigestJob` + `generateDigestById`)：

- 页面「项目总结」行：安静期(默认 30 分钟，`digestQuietMinutes`)、自动开关
  `digestOn`、模型选择、「立即生成」
- 候选项目：有会话、最近会话已安静 ≥ 安静期、且最新 `project_digests.created_at`
  早于最新会话时间(秒/毫秒换算)；按最近活跃排序，**一次最多 3 个项目**
- 每个项目：最近 10 场会话 + 已有总结 → 模型返回 `{summary,recent,todos}`，
  写 `project_digests`(历史保留，取最新)；`memory_get_project_digest` 优先返回它
- 状态：`digestLast/digestAdded/digestModel/digestError`，页面轮询 `running/job`
- 项目页「用模型生成总结」仍可对单个项目手动生成

**整理记忆**(`runDreamJob`)：

- 间隔：`dreamEveryHours`(默认 24 小时)，从上一次 `dreamt` 算起；刚从关闭切到打开时
  以 `dreamSince` 为起点；「立即整理」随时可跑
- 每个作用域最多 120 条 active/candidate、`locked=0` 的记忆；列表带
  `used N×`(被召回次数)，供模型判断哪些还在用
- 状态行始终显示上一次整理时间(关闭时也显示)，没有变更时显示「没有需要变更的记忆」
- prompt 要求模型只做「合并说同一件事」和「归档不再成立」，返回
  `{merge:[{ids,text,kind}],archive:[{id,why}]}`；id 是列表序号，后端校验存在且未锁定
- 合并：插一条 `source='llm-tidy'` 的 active 记忆，成员置 `superseded`；
  归档：置 `archived`；手写/置顶(`locked=1`)永不参与
- 变更记在 `distill.json.changes`(每条带 `at` 时间戳和原状态 `from`)，页面显示
  「合并 N / 归档 M」
- **撤销**(`undoDream` / `POST /api/dream/undo`)：只撤销最近一次整理，按原状态
  恢复被合并/归档的条目、删掉合并出来的新记忆。严格校验「整理后没人动过」
  (status/updated_at/locked/deleted/source 都对得上)才恢复；用户改过、置顶、删掉
  或又归档过的整项保留，返回 `{restored, removed, kept}`，页面状态行说明保留了几项

**旧「从对话学习」**：`runDistillJob`(会话蒸馏出候选记忆)仍保留在后端与
`/api/distill/run`，`distill.json` 的 `on` 字段也还在，但页面不再暴露、定时器也不再
自动跑；历史候选仍可在「待确认」查看/确认/归档。

**迁移自愈**：schema 的补列/建表**每次启动都检查**，不只信
`meta.schema_version`。真机踩过：中间版本把版本写成 2 却没有执行 ALTER，
之后按版本号跳过迁移，真库缺 `why/source_session_id/distilled_at`，
记忆页报 `no such column: why`。现在 `hasColumn` 每次补齐；v3 的
`memory_stats` 与 `stats_since` 也每次检查(已有库升级时 `stats_since=当天`，
之前的新增从记忆自身日期回填)。测试 `test/schema.test.mjs` 锁住
「版本=2 但缺列也能自愈」与幂等。

## 4. MemorySQL 应用侧改动(给 `backend: "app"` 用)

全部向后兼容，不改变现有 agent 的调用方式。

| 改动 | 文件 | 说明 |
|---|---|---|
| `/health` 增加 `stats` | `src/plugins/mcp-server/index.ts` | 会话/项目/消息/记忆数、最近会话、db 大小 |
| 共享统计 | `src/main/core/db-stats.ts` | `/health` 与 `memory_stats` 同一口径 |
| `memory_list_projects` | `mcp-tools.ts` | 项目清单；`format=json` 给页面用 |
| `memory_stats` | `mcp-tools.ts` | 规模统计 |
| `memory_import_session` | `mcp-tools.ts` | 网关回写：upsert、消息 diff、防截短 |
| `memory_get_context` 等支持 `cwd` | `mcp-tools.ts` | 最长路径前缀匹配项目 |
| `memory_list_sessions` `format=json` | `mcp-tools.ts` | 页面结构化会话列表 |
| `MemoriesService.ingestSessions` | `core-schema/index.ts` | 复用 ingest 管道 |

**不建议**插件直接读 MemorySQL 的 `memory.db`:查询/排序/项目解析逻辑会被复制一份，
schema 一改就漂移。app 模式走 MCP 契约；embedded 模式用自己的库。

## 5. 决策与取舍

| 决策 | 理由 |
|---|---|
| 默认内置 SQLite,而不是要求装 MemorySQL | 用户要的是「装 magpie 插件即用」;零外部依赖是社区插件的基本盘 |
| app 后端保留为可选 | 已经有 MemorySQL 的用户能复用 24+ agent 文件捕获、curator、语义检索 |
| 两种后端数据不自动合并 | 静默合并两套 schema/语义风险高;先让用户显式选择 |
| 内置的 LLM 走 magpie 网关 | 插件没有自己的 key;复用 magpie 已配置模型(默认用 magpie 记忆蒸馏的 lastModel),用户不用再配一遍 |
| 蒸馏候选先待确认 | 模型会编;引用必须是用户原话，候选要用户确认后才进续接包 |
| 迁移自愈 | 中间版本把版本号写成 2 却没 ALTER，真库缺列；每次启动按 `hasColumn` 补齐，不信版本号 |
| 捕获默认随后端 | embedded 没有文件捕获，回写是唯一来源；app 有文件捕获，回写会双写 |
| 注入第一条用户消息 | 客户端历史里始终存在 → 后续请求前缀稳定;系统提示改动面更小 |
| 记忆注入默认关、可按 agent 选 | 注入会把本地记忆随请求发给模型厂商；默认不改行为，用户显式打开并选 agent 后才生效 |
| 页面用带路页 + 本地服务 | magpie 页面 sandbox 的 `connect-src 'none'` 决定了不能直连 |
| 不改 magpie 内置 Memory | 不可插件化;硬替换会和用户已有数据/蒸馏流程打架 |

## 6. 验证

2026-11-20:

- 插件:`node --test` **39 passed**：内嵌存储、搜索结构化命中、会话删除/回写不复活、
  记忆注入默认关/按 agent 过滤、项目总结(安静期/LLM)、LLM 蒸馏/整理、
  记忆页 API、协议注入、钩子召回/捕获、页面服务 token/CORS、迁移自愈；
  `bun:sqlite`(magpie 自带 Bun 1.4.4)冒烟通过。
- 真实模型 E2E(临时库副本，不碰真库)：`workbuddy/glm-5.3-flash` 蒸馏出 **4 条候选**
  (kind/scope/project/why 正确、quote 校验有效)，并生成项目总结；`memory_get_project_digest`
  返回模型总结。
- 真机踩坑+修复：live 库被「版本=2 但缺 v2 列」的中间代码打开过，记忆页报
  `no such column: why`；改成每次启动自愈后，真库补列成功，`/api/memories` 正常。
- 页面：真实 magpie 宿主内打开，浏览器目视确认记忆页(状态分段/模型选择/作用域/
  项目总结/整理/记忆注入/搜索/添加)布局与交互符合预期。
- 页面搜索/删除验收(临时库副本,不碰真库)：`搜索"插件"` 返回 20 条命中、片段围绕关键词
  高亮、同一会话最多先展示 3 条(可「显示全部」)、会话 id 可见；两步确认删除后列表与
  状态计数同步(4→3)、搜索不再出现该会话；模拟旧 token 请求 401 时页面自动带
  `?fresh=` 重载并恢复。
- 真机页面验收(2026-11-20)：左上角显示 MemorySQL 应用图标；记忆页新增「记忆注入」
  默认关，打开后显示全部 agent 与逐个勾选，选 2 个后状态行同步；关掉后回到
  「关闭（默认）」且选择保留；跑一次整理后状态行显示「关闭 · 上次整理 刚刚 ·
  没有需要变更的记忆」。
- 页面改版验收(2026-11-20)：「项目总结」安静期 30 分钟 + 立即生成、「整理记忆」每 24
  小时 + 立即整理；只勾一个 agent 再取消后显示「开启 · 未选 agent（不会注入）」而不是
  变回全部；Bun/Node 不在 agent 列表；「默认模型」文字移除；记忆搜索无结果时可一键跳到
  全局搜索；token 失效自动重载后仍停在搜索页并带 `q` 重搜（实测 12 条命中）。
- MemorySQL:`npm run typecheck` 0;`npm test` **678 passed / 2 skipped**;
  `npm run build` 通过。
- 真实 magpie 0.1.4594 加载:钩子 `onRequest`、10 个工具、`page MemorySQL` 都识别。
- app 后端真实库副本(294MB / 444 会话 / 614 记忆)E2E:`/health` stats、
  `tools/list` 11、`memory_get_context({cwd})` 命中项目、`memory_import_session`
  2→3、短列表跳过、`memory_list_sessions(format=json)`。
- 未做:真实 agent 经 magpie 网关心跳的 E2E;`magpie web` 页面反代人工验收。

2026-11-25（借鉴 magpie 当天的记忆更新）：

- magpie 当天给 Memory 加了「活动统计」（`internal/memory/stats.go`：每日
  新增/更新/清理/搜索/注入计数 + Memory 页四个卡片和 7/30 天趋势），并在此前加了
  整理 Undo、多行记忆保持换行、项目指令文件优先。插件按同一套语义做了对应能力：
  - `memory_stats` 表 + `activity()` + `/api/activity`；页面五张卡片（新增/召回率/
    更新率/清理率/注入会话），7/30 天 sparkline 与每日柱子。调用方：`write` /
    `log_progress` / 蒸馏候选 / 页面新增/编辑/置顶/归档/删除、MCP `memory_search`、
    网关首次注入。页面搜索 `internal:true` 与 `kind=session|message` 不计召回率。
  - 升级前只有 `created` 按 `memories.created_at` 回填（`llm-tidy` 排除），其余指标
    从 `stats_since` 起算；只存计数，不存正文。
  - 整理 Undo：`changes` 记 `at` 与 `from`，严格校验后恢复；用户之后改过/置顶/删除/
    再归档的条目保留（`{restored,removed,kept}`）。
  - 多行记忆：续接包按 `Indented` 思路保留行并缩进，整理 prompt 仍折成一行；
    页面折叠显示首行 + `…`，展开 `pre-wrap`。续接包声明项目 `AGENTS.md` 等文件优先，
    `memory_write` 描述也建议项目规则写进项目文件。
- `node --test` **43 passed**（新增活动统计/回填、整理撤销、多行注入、注入计数）。
- 浏览器验收（临时库 + 真实页面服务）：五张卡片与 sparkline、点开每日柱子、
  7/30 天切换、同一会话再请求不重复计注入、多行记忆展开高度 3 行
  (`white-space: pre-wrap`)、记忆行显示「召回 N 次 · 刚刚」。
- 没照搬：magpie 的本地语义检索（模型下载/ONNX 不适合社区插件，嵌入式继续
  FTS5+LIKE）、文件即记忆 + 多机同步（本插件是 SQLite，另属一套设计）、
  候选 30 天过期清理（会删数据，先不做）、`memory_save` 的项目文件提示条
  （只在工具描述和续接包里声明，不改写用户文件）。
- 未做：真实 agent 经网关的多天活动数据（本地只用模拟请求验证计数）；
  整理取消（在途一轮仍不可中断）。

## 7. 待办

- 用真实 agent 跑一次「首轮注入 + 第二轮缓存命中」的网关 E2E(embedded + app 各一次)。
- 内置存储的检索排序(现在是 bm25/LIKE + 最近时间，没有 MemorySQL 的语义检索)。
- 蒸馏/整理的取消(现在关掉开关不会中断在途的一轮；Undo 已支持最近一次整理)。
- 视反馈决定是否把 embedded 的 `capture` 做成可配置的「只捕获某些 agent」。
- 发布 npm(`@logic647/tools-memorysql` 或 `@magpie-community/tools-memorysql`)；
  打 `magpie-plugin` topic / 提 community registry PR。
