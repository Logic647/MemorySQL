# magpie 社区插件集成(MemorySQL for magpie)

> 状态:2026-11-20 已落地 MVP(工具 + 自动续接 + 页面 + 可选回写),插件在独立仓库
> 本仓库 `magpie-plugin/`(建议发布为 `@logic647/tools-memorysql`,或改成
> `@magpie-community/tools-memorysql`)。本文记录目标、magpie 插件规范要点、
> 架构决策、MemorySQL 侧的改动与验证证据。

## 1. 目标与定位

把 MemorySQL 作为 **magpie 社区插件**接入:

- magpie 是「一个本地网关,服务所有 agent」;MemorySQL 是「跨 agent 的会话档案 +
  项目交接知识库」。
- **不要**把 MemorySQL 当成 magpie 内置 Memory 的替代品。magpie 已内建
  `internal/memory`(`~/.config/magpie/memory/*.md`、`/mcp/magpie/memory`、
  语义检索、对话蒸馏、夜间整理、注入 instructions、同步),且**不可插件化替换**。
- 分工建议:magpie Memory 记「事实/偏好」;MemorySQL 记「谁在哪个项目做到哪一步」
  —— 会话档案、项目滚动总结、交接简报、收工汇报。

零代码基线:如果只想要「magpie 的 agent 能用 MemorySQL」,今天就能做 ——
Library → MCP → 添加 `http://127.0.0.1:8642/mcp` 并分给 agent。插件带来的增量是:
一键安装/发现、工具聚合到 magpie 统一的 tool server、**网关自动续接**、页面。

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
  读 MemorySQL 数据必须走插件自己的服务。

## 3. 架构

```
agent (Claude Code / Codex / ...)
        │  请求
        ▼
magpie gateway ── onRequest ──► MemorySQL MCP (127.0.0.1:8642)
        │        (首轮注入续接包)        ▲
        │                                │ tools/call
        ├── 路由到模型                     │
        │                                │
        ▼                                │
magpie tool server /mcp/magpie/tools ────┘
        ▲
        │ tools/call (memorysql_*)
        │
agent 的 MCP 客户端

magpie 窗口 ── page iframe ──► 插件服务 127.0.0.1:3488 ──► MemorySQL MCP
```

### 3.1 工具代理

`index.mjs` 返回 `toolsFor(options)`,10 个工具:

`get_context` / `get_project_brief` / `get_project_digest` / `list_projects` /
`list_sessions` / `get_session` / `search` / `write` / `log_progress` / `stats`。

- `execute` → `POST http://127.0.0.1:<port>/mcp` 的 `tools/call`(MemorySQL 是
  无状态 JSON-RPC,不需要 initialize 握手)。
- 端点发现:`/health` 返回 `server/port/version/tools/stats`;配置端口失败时
  扫描 8642–8652(MemorySQL 端口冲突会自动 +1)。发现结果缓存 30 秒。
- `readOnly: true` 隐藏 `write` / `log_progress`。
- 工具调用失败会抛出带原因的异常,agent 能看到「MemorySQL 未运行」等。

### 3.2 网关自动续接

`hooks.mjs` 的 `onRequest`:

1. 先按**客户端原始历史**绑定 capture(注入前),再注入。
2. 只对本机(`local` / `magpie-key`)生效;`skipAgents`、子代理、magpie 内部请求
   (`memory` / `title` / `classifier`)跳过。
3. 缓存键:`ctx.session`,没有则 `cwd + 第一条用户消息` 的哈希。
4. 调 `memory_get_context({ cwd, agent })`;`cwd` 由 MemorySQL 按最长路径前缀匹配
   项目(agent 在子目录里启动也能回到项目根)。
5. 裁剪到 `maxBytes`,包 `<memorysql-context>` 后追加到**第一条用户消息**;
   同一 session 后续请求复用缓存块,前缀稳定,prompt cache 不碎。
6. 失败/超时/空结果 → `ctx.report('unavailable'/'empty')` + 返回 `undefined`,
   请求原样放行。

### 3.3 会话回写(默认关)

`onResponse`:

1. 从 `ctx.state.memorysql` 取注入前保存的历史(不含续接包)。
2. 追加本轮 assistant 文本,调 `memory_import_session`。
3. MemorySQL 按 `(agent_type, external_id)` upsert,消息级 diff 只重写变化的尾部。
4. 若已有更完整的同源会话(文件捕获),跳过;网关自己的较短副本默认也不截短
   (`replace: true` 才允许)。

回写适合 magpie 路由但 MemorySQL 没有原生捕获适配器的 agent;有原生捕获的 agent
通常不用打开,避免双写。

### 3.4 页面与 agent 行菜单

- `page/index.html` + `page/boot.js`:带路页,接 `magpie.onAction({agent})` 后
  导航到 `magpie.service`(magpie web)或 `127.0.0.1:<pagePort>`(桌面)。
- `service.mjs`:Bun 里的本地 HTTP 服务,只绑 127.0.0.1,校验 Host/Origin;
  提供 `/api/status`、`/api/projects`、`/api/sessions`、`/api/search`、
  `/api/context`、`/api/digest`、`/api/session`。
- `ui/`:状态、项目列表、续接包/总结/会话、跨 agent 搜索;只读。
- `magpie.actions` 的 `agent-sessions` 出现在 agent 行菜单,打开页面并带 `?agent=`。

## 4. MemorySQL 侧改动

全部向后兼容,不改变现有 agent 的调用方式。

| 改动 | 文件 | 说明 |
|---|---|---|
| `/health` 增加 `stats` | `src/plugins/mcp-server/index.ts` | 会话/项目/消息/记忆数、最近会话、db 大小;插件状态页/探活一次拿全 |
| 共享统计 | `src/main/core/db-stats.ts` | `/health` 与 `memory_stats` 同一口径 |
| `memory_list_projects` | `mcp-tools.ts` | 项目清单;`format=json` 给页面用 |
| `memory_stats` | `mcp-tools.ts` | 规模统计(默认给 agent 也不亏) |
| `memory_import_session` | `mcp-tools.ts` | 网关回写:按 `(agent, externalId)` upsert、消息 diff、防截短 |
| `memory_get_context` 等支持 `cwd` | `mcp-tools.ts` | 最长路径前缀匹配项目,子目录 cwd 也能回到项目根 |
| `memory_list_sessions` `format=json` | `mcp-tools.ts` | 页面结构化会话列表 |
| `MemoriesService.ingestSessions` | `core-schema/index.ts` | 复用 ingest 管道 |

**不建议**插件直接读 `memory.db`:查询/排序/项目解析逻辑会被复制一份,schema 一改
就漂移。MCP 是稳定契约;只有「app 没起也要能搜」成为硬需求时才考虑只读 SQLite 兜底。

## 5. 决策与取舍

| 决策 | 理由 |
|---|---|
| 工具代理而不是直读 SQLite | 契约稳定、复用 MemorySQL 的排序/项目解析/格式化;代价是 app 必须运行 |
| 自动续接放网关心跳 | 覆盖所有经 magpie 的 agent,不需要每个 agent 配 MCP;工具仅覆盖接了 tool server 的 agent |
| 注入第一条用户消息 | 客户端历史里始终存在 → 后续请求前缀稳定;系统提示改动面更小 |
| 默认 recall 开、capture 关 | 续接是核心价值且失败开放;回写有双写/隐私风险,先让用户显式打开 |
| 页面用带路页 + 本地服务 | magpie 页面 sandbox 的 `connect-src 'none'` 决定了不能直连 MemorySQL |
| 不改 magpie 内置 Memory | 不可插件化;硬替换会和用户已有数据/蒸馏流程打架 |

## 6. 验证

2026-11-20:

- MemorySQL:`npm run typecheck` 0;`npm test` **678 passed / 2 skipped**;
  `npm run build` 通过。
- 插件:`node --test` **21 passed**(协议注入/端点发现/钩子召回/捕获/页面服务)。
- 真实 magpie 0.1.4594 加载:插件显示
  `async gateway hook onRequest`、10 个工具、`page MemorySQL`;页面服务正常起。
- 真实库副本(294MB,444 会话 / 614 记忆)+ 构建后的 MemorySQL:
  - `/health` 返回 stats;
  - `tools/list` 含 11 个工具(含 `memory_list_projects` / `memory_stats` /
    `memory_import_session` / `memory_get_project_digest`);
  - `memory_get_context({ cwd: "H:/桌面/MemorySQL/src" })` 命中 MemorySQL 项目;
  - `memory_import_session` 导入 2 条 → 追加到 3 条 → 只发 1 条时按「不截短」跳过;
  - `memory_list_sessions({ format: "json" })` 能看到导入的会话。
- 未做:真实模型请求经过 magpie 网关心跳的端到端(需要可用的 provider 与一次
  真实对话);`magpie web` 下的页面反代人工验收。

## 7. 待办

- 用真实 agent 跑一次「新会话首轮自动注入 + 第二轮缓存命中」的网关 E2E。
- 截一张 MemorySQL 页面截图,补 README。
- 发布 npm(`@logic647/tools-memorysql` 或 `@magpie-community/tools-memorysql`)。
- 给插件仓库打 `magpie-plugin` topic;视情况给 `magpie-community/plugins`
  提 registry PR。
- 视反馈决定是否把 `capture` 默认打开,以及是否增加每轮 `memory_search` 召回。
