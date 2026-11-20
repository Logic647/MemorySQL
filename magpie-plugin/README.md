# MemorySQL for magpie

把「跨 agent 会话档案 + 项目交接」装进 [magpie](https://github.com/yetone/magpie)。

**不需要另装 MemorySQL 桌面应用**：插件自带一个本地 SQLite 知识库，装上就能用。
如果你已经在用 MemorySQL，也可以把后端切到 `app`，复用它的完整会话捕获与 LLM 项目总结。

- **10 个工具**：`memorysql_get_context`、`search`、`list_sessions`、`get_session`、`list_projects`、`get_project_brief`、`get_project_digest`、`write`、`log_progress`、`stats`
- **网关自动续接**：会话第一次经过 magpie 时，把「续接包」注入第一条用户消息；同一会话后续请求复用同一份，prompt cache 不受影响
- **会话回写**：内置存储默认把每轮 user/assistant 文本写进本地会话档案（app 后端默认关，避免和 MemorySQL 自己的文件捕获双写）
- **magpie 窗口里的页面**：状态、项目、续接包、项目总结、会话、跨 agent 搜索
- **agent 行菜单**：「在 MemorySQL 里看会话」

> 定位：magpie 自带的 Memory 记「事实与偏好」；MemorySQL 记「谁在哪个项目做到哪一步」——会话档案、项目交接、收工汇报。两者并存，不互相替代。

---

## 安装

需要：

- magpie **0.1.1531+**（网关钩子与页面服务）
- Bun（magpie 第一次装插件时会自动下载）

```sh
# npm（发布后）
magpie plugin add @logic647/tools-memorysql

# 本地开发：文件夹就地加载（在本目录）
magpie plugin add .
```

然后：

```sh
magpie plugin          # 应看到 MemorySQL 的工具与页面
magpie plugin dump     # 看钩子/选项
```

在 magpie 窗口的 **插件 → 已安装** 里可以改选项；页面在侧栏的插件分组里。

> **工具名前缀**：从 npm 安装时短名是 `memorysql`（`memorysql_search`）。从本地文件夹安装时 magpie 用**文件夹名**做短名，例如文件夹叫 `magpie-plugin` 就是 `magpie-plugin_search`。只影响名字，不影响功能。

---

## 数据存在哪

默认：

| 平台 | 路径 |
|---|---|
| Windows / macOS / Linux | `~/.config/magpie/memorysql/memory.db`（尊重 `XDG_CONFIG_HOME`） |

- 插件第一次用到时自动建库（SQLite + FTS5 trigram）。
- 目录里只有 `memory.db`（及 WAL 文件）；备份整个 `memorysql/` 目录即可。
- 选项 `dataDir` 可以改到别处；`dataDir: ":memory:"` 只用于测试。
- 会话内容与记忆都是本机数据，插件不上传任何东西。

---

## 工作方式

### 1. 自动续接

`hooks.mjs` 的 `onRequest`：

1. 只对本机请求（`origin` 为 `local` / `magpie-key`）生效；远程默认关。
2. 按 `ctx.session`（没有就用 `cwd + 第一条用户消息` 的哈希）缓存续接包。
3. 调 `memory_get_context({ cwd, agent })`，裁剪到 `maxBytes`，包在
   `<memorysql-context>…</memorysql-context>` 里，追加到**第一条用户消息**。
4. 同一 session 后续请求复用缓存块；首条用户消息在客户端历史里始终存在，前缀稳定。
5. 任何失败/超时/空结果都 **fail open**：请求原样放行；全新库没有内容时直接跳过。

跳过：`skipAgents` 里的 agent、子代理请求（`skipSubagents`，默认 true）、magpie 内部请求（`memory` / `title` / `classifier` 等）。

### 2. 会话回写

`onResponse` 把「请求里的 user/assistant 文本 + 本轮回复」写进会话档案：

- 按 `(agent, externalId)` 去重；`externalId` 优先用 agent 的原生 session id。
- 消息级 diff：后续轮次只追加新尾部。
- 客户端只发当前轮/被上下文窗口裁过时，默认不截短已存历史（`replace: true` 才覆盖）。
- 捕获的是客户端自己的历史，**不含**注入的续接包。
- 工具调用不写入，保持档案精简。

**默认值**：`backend: "embedded"` 时 **开**（这是会话档案的唯一来源）；`backend: "app"` 时 **关**（MemorySQL 自己会捕获文件）。

### 3. 工具

工具只在「插件工具」这个内置插件开着时提供（有工具插件时它自动开）。它们也会自动成为 Library 里的一个 MCP 服务器，可按 agent 开关，或走 MCP 路由（名字变成 `memorysql__search` 这种）。

| 工具 | 用途 |
|---|---|
| `get_context` | 续接包：全局/项目记忆 + 最近会话 |
| `get_project_brief` | 项目交接简报 + 上一棒 tail + 待确认进度 |
| `get_project_digest` | 项目总结（内置存储是规则汇编；app 后端是 LLM 滚动总结） |
| `list_projects` | 项目清单（会话数/最近活跃） |
| `list_sessions` | 按项目/agent/时间列会话 |
| `get_session` | 按 id 深读会话（tail/full） |
| `search` | 跨 agent 全文检索（会话/消息/记忆） |
| `write` | 写长期记忆（`readOnly: true` 时隐藏） |
| `log_progress` | 收工汇报（`readOnly: true` 时隐藏） |
| `stats` | 知识库规模 |

`get_context` / `get_project_brief` / `list_sessions` / `search` / `write` / `log_progress` 都支持 `cwd`（绝对路径）：按最长路径前缀匹配项目，agent 在子目录里启动也能回到项目根。

### 4. 页面

`page/index.html` 是「带路页」：magpie 的插件页面在 sandbox 里（`connect-src 'none'`），
所以它只负责接住 agent 行菜单的 action，然后把框架导航到插件自己的本地服务
（`127.0.0.1:<pagePort>`，默认 3488）。真正的 UI 由 `service.mjs` 提供：

- 状态：内置存储 / MemorySQL 应用、会话/记忆/项目数
- 项目列表 → 续接包 / 项目总结 / 会话
- 会话详情（tail 200）
- 跨 agent 搜索
- `?agent=` 过滤（从 agent 行菜单进来时）

页面只读。服务只绑 `127.0.0.1`，校验 Host / Origin，拒绝非本服务的来源。
magpie 的插件页面是 sandbox iframe，`Origin` 是 `null`：API 响应显式回
`Access-Control-Allow-Origin: null`（并处理 `OPTIONS` 预检），否则浏览器会把
同 URL 的 `fetch` 当跨源拦掉。每次宿主启动生成一个随机 token，注入页面 HTML 的
`<meta name="memorysql-token">`；API 必须带 `x-memorysql-token`。静态 HTML 刻意不带
CORS，别的站点就算嵌一个 sandbox 也读不到 token，不能直连 loopback 读记忆。
`magpie web` 下优先使用桥接给的 `magpie.service` 地址；没有时回落到 `127.0.0.1:<pagePort>`。

---

## 选项

| 选项 | 默认 | 说明 |
|---|---|---|
| `backend` | `embedded` | `embedded` = 插件内置 SQLite（不需要装 MemorySQL）；`app` = 代理本机正在运行的 MemorySQL 应用 |
| `dataDir` | `""` | 内置库目录；空 = `~/.config/magpie/memorysql` |
| `readOnly` | `false` | 隐藏 `write` / `log_progress`（不影响回写） |
| `recall` | `true` | 网关自动续接 |
| `capture` | 随后端 | embedded 默认开，app 默认关；显式 `true/false` 覆盖 |
| `maxBytes` | `6000` | 注入块上限（字符） |
| `gatewayTimeoutMs` | `1500` | magpie 给钩子的预算；内部查询留 250ms 余量 |
| `skipAgents` | `[]` | 不注入/不回写的 agent（magpie 显示名，大小写/空格/标点不敏感） |
| `skipSubagents` | `true` | 跳过子代理请求 |
| `recallRemote` | `false` | 远程/网关密钥请求也注入 |
| `captureRemote` | `false` | 远程/网关密钥请求也回写 |
| `pagePort` | `3488` | 页面服务端口 |
| `port` / `endpoint` | `8642` / `""` | 仅 `backend: "app"`：MemorySQL MCP 端口/显式端点 |

### 什么时候用 `backend: "app"`

如果你已经装了 MemorySQL 桌面应用，并且想要：

- 它已有的 **24+ agent 文件捕获**（Claude Code / Codex / ZCode / … 的完整历史，含工具调用）
- **LLM 项目滚动总结**（`memory_get_project_digest`）
- 记忆分层/curator/语义检索/同步

把 `backend` 改成 `app`，并让 MemorySQL 在托盘运行即可。注意两套数据是分开的：
内置库 `~/.config/magpie/memorysql/memory.db` 与 MemorySQL 的 `memory.db` 不会自动合并；
切换后页面/工具看到的是 app 的数据。

---

## 隐私

- 内置库只在本机；插件不向任何外部服务上传记忆/会话。
- **自动续接会把本地记忆/会话摘要随请求发给模型厂商**（和 magpie 自己的 Memory 注入 instructions 一样）。magpie 的 masking 在请求出口处执行，注入内容也会被一起脱敏。
- 不想让某个 agent 看到记忆：把它加进 `skipAgents`；不想让远程请求看到：保持 `recallRemote` / `captureRemote` 为 false。
- 页面只读；服务只绑 loopback，API 还要每次启动的随机 token（HTML 里注入，别的站点读不到）。

---

## 开发

```sh
node --test        # 27 项单测：内嵌存储、协议注入、钩子召回/捕获、页面服务
magpie plugin add .   # 加载到本机 magpie
magpie plugin         # 看工具/钩子/页面是否都在
```

内嵌存储用 `node:sqlite`（Node 24+）跑单测，magpie 宿主里用 `bun:sqlite`，两边 schema/查询一致。

### 发布

1. `npm publish`（包名 `@logic647/tools-memorysql` 或改成 `@magpie-community/tools-memorysql`）
2. GitHub 仓库加 topic `magpie-plugin` → Discover → 非官方插件
3. 想进官方评审列表：给 [magpie-community/plugins](https://github.com/magpie-community/plugins) 提 PR，在 `registry.json` 加一条（`kind: "tools"` 或 `page`，带 en/zh summary）

---

## 限制

- 内置存储不做 LLM 项目总结、不做 24+ agent 的文件捕获；需要这些时用 `backend: "app"`。
- 网关钩子默认只有 1s 预算（`gatewayTimeoutMs` 可调）；内置查询通常毫秒级，app 后端冷启动可能超时，失败开放。
- 插件以你的权限运行（和 magpie 的其他插件一样）；只安装你信任的代码。
