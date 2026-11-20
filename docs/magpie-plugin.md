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
- 分工:magpie Memory 记「事实/偏好」;MemorySQL 记「谁在哪个项目做到哪一步」
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
  sessions 时间是**秒**，memories/projects.updated_at 是**毫秒**)
- FTS5 trigram 外部内容表：`sessions_fts` / `messages_fts` / `memories_fts`，
  配 `AFTER INSERT/UPDATE/DELETE` 触发器同步
- 索引：agent/project/scope/status/content
- `PRAGMA journal_mode=WAL`、`busy_timeout=5000`(app/CLI 宿主可能同时开着库)

工具语义与 MemorySQL MCP 对齐：

| 工具 | embedded 行为 |
|---|---|
| `memory_get_context` | 全局/项目记忆 + 最近会话；**全新库返回空串**(钩子据此不注入) |
| `memory_get_project_brief` | 记忆 + 会话 + 上一棒 tail + 收工汇报候选 |
| `memory_get_project_digest` | **规则汇编**(项目信息 + 最近会话 + 从收工汇报提取的待办)，不调 LLM |
| `memory_list_projects` | 项目 + 会话数 + 最近活跃；`format=json` |
| `memory_list_sessions` | 项目/agent/时间过滤；`format=json` |
| `memory_get_session` | tail/full + 4 万字符预算(从最新往回填) |
| `memory_search` | FTS5 trigram + `LIKE` 兜底(中文 1–2 字词)；会话/消息/记忆三路 |
| `memory_write` | 去重、scope/项目解析、标签 |
| `memory_log_progress` | 候选进度记忆(不关联最近活跃项目，只认显式 project/cwd) |
| `memory_stats` | 会话/项目/消息/记忆数、最近会话、db 大小 |
| `memory_import_session` | `(agent, externalId)` upsert、消息级 diff、防截短 |

项目解析与 MemorySQL 同口径：`cwd` 按最长路径前缀；否则名字 `LIKE` 优先、
路径 `LIKE` 兜底；写记忆/收工汇报给了 project/cwd 但没命中时**不**回落到最近活跃项目。

### 3.3 网关自动续接

`hooks.mjs` 的 `onRequest`:

1. `getBackend(options)` 决定后端；`capture` 默认值随后端(embedded 开 / app 关)。
2. 先按**客户端原始历史**绑定 capture(注入前)，再注入。
3. 只对本机(`local` / `magpie-key`)生效；`skipAgents`、子代理、magpie 内部请求
   (`memory` / `title` / `classifier`)跳过。
4. 缓存键:`ctx.session`,没有则 `cwd + 第一条用户消息` 的哈希。
5. 调 `memory_get_context({ cwd, agent })`；裁剪到 `maxBytes`，包
   `<memorysql-context>` 后追加到**第一条用户消息**；同一 session 后续请求复用
   缓存块，前缀稳定，prompt cache 不碎。
6. 失败/超时/空结果 → `ctx.report('unavailable'/'empty')` + 返回 `undefined`，
   请求原样放行。内置后端是本地同步查询，通常毫秒级。

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

### 3.5 页面与 agent 行菜单

- `page/index.html` + `page/boot.js`:带路页，接 `magpie.onAction({agent})` 后
  导航到 `magpie.service`(magpie web)或 `127.0.0.1:<pagePort>`(桌面)。
- `service.mjs`:Bun 里的本地 HTTP 服务，只绑 127.0.0.1，校验 Host/Origin；
  提供 `/api/status`、`/api/projects`、`/api/sessions`、`/api/search`、
  `/api/context`、`/api/digest`、`/api/session`，全部转给当前后端。
- `ui/`:状态(内置存储 / MemorySQL 应用)、项目列表、续接包/总结/会话、跨 agent
  搜索；只读。相对路径 + `magpie.service` 兼容 `magpie web`。
- `magpie.actions` 的 `agent-sessions` 出现在 agent 行菜单，打开页面并带 `?agent=`。

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
| app 后端保留为可选 | 已经有 MemorySQL 的用户能复用 24+ agent 文件捕获、LLM 总结、curator |
| 两种后端数据不自动合并 | 静默合并两套 schema/语义风险高;先让用户显式选择 |
| 内置不做 LLM 总结 | 插件里没有模型网关凭据;规则汇编足够支撑「续接」,LLM 交给 app |
| 捕获默认随后端 | embedded 没有文件捕获，回写是唯一来源；app 有文件捕获，回写会双写 |
| 注入第一条用户消息 | 客户端历史里始终存在 → 后续请求前缀稳定;系统提示改动面更小 |
| 页面用带路页 + 本地服务 | magpie 页面 sandbox 的 `connect-src 'none'` 决定了不能直连 |
| 不改 magpie 内置 Memory | 不可插件化;硬替换会和用户已有数据/蒸馏流程打架 |

## 6. 验证

2026-11-20:

- 插件:`node --test` **27 passed**(内嵌存储、协议注入、钩子召回/捕获、页面服务);
  `bun:sqlite`(magpie 自带 Bun 1.4.4)冒烟通过(建库/导入/context/search/stats)。
- MemorySQL:`npm run typecheck` 0;`npm test` **678 passed / 2 skipped**;
  `npm run build` 通过。
- 真实 magpie 0.1.4594 加载:钩子 `onRequest`、10 个工具、`page MemorySQL` 都识别。
- app 后端真实库副本(294MB / 444 会话 / 614 记忆)E2E:`/health` stats、
  `tools/list` 11、`memory_get_context({cwd})` 命中项目、`memory_import_session`
  2→3、短列表跳过、`memory_list_sessions(format=json)`。
- 未做:真实模型请求经 magpie 网关心跳的 E2E;`magpie web` 页面反代人工验收。

## 7. 待办

- 用真实 agent 跑一次「首轮注入 + 第二轮缓存命中」的网关 E2E(embedded + app 各一次)。
- 内置存储的检索排序(现在是 bm25/LIKE + 最近时间，没有 MemorySQL 的语义检索)。
- 视反馈决定是否把 embedded 的 `capture` 做成可配置的「只捕获某些 agent」。
- 发布 npm(`@logic647/tools-memorysql` 或 `@magpie-community/tools-memorysql`)；
  打 `magpie-plugin` topic / 提 community registry PR。
