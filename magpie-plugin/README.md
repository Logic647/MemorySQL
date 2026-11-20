# MemorySQL for magpie

把本机 [MemorySQL](https://github.com/Logic647/MemorySQL) 知识库接进 [magpie](https://github.com/yetone/magpie)：

- **10 个工具**：`memorysql_get_context`、`search`、`list_sessions`、`get_session`、`list_projects`、`get_project_brief`、`get_project_digest`、`write`、`log_progress`、`stats`
- **网关自动续接**：会话第一次经过 magpie 时，把 MemorySQL 的续接包注入第一条用户消息；同一会话后续请求复用同一份，provider 的 prompt cache 不受影响
- **可选会话回写**：`onResponse` 把完整对话写回 MemorySQL（默认关）
- **magpie 窗口里的页面**：状态、项目、续接包、项目总结、会话、跨 agent 搜索
- **agent 行菜单**：「在 MemorySQL 里看会话」

> 定位：magpie 自带的 Memory 记「事实与偏好」；MemorySQL 记「谁在哪个项目做到哪一步」——跨 agent 会话档案、项目滚动总结、交接简报、收工汇报。两者并存，不互相替代。

---

## 安装

需要：

- magpie **0.1.1531+**（网关钩子与页面服务）
- MemorySQL **0.7.9+**（本仓库当前工作树；0.7.8 只有 8 个原始工具，`list_projects` / `stats` / `import_session` / `cwd` 需要新版）
- MemorySQL 正在运行（托盘/开机自启即可），MCP 服务开着（默认 `127.0.0.1:8642`）

```sh
# npm（发布后）
magpie plugin add @logic647/tools-memorysql

# 本地开发：文件夹就地加载
magpie plugin add .   # 在 magpie-plugin/ 目录里;从仓库根是 magpie plugin add ./magpie-plugin
```

然后：

```sh
magpie plugin          # 应看到 MemorySQL 的工具与页面
magpie plugin dump     # 看钩子/选项
```

在 magpie 窗口的 **插件 → 已安装** 里可以改选项；页面在侧栏的插件分组里。

> **工具名前缀**：从 npm 安装时短名是 `memorysql`（`memorysql_search`）。从本地文件夹安装时 magpie 用**文件夹名**做短名，例如文件夹叫 `magpie-plugin` 就是 `magpie-plugin_search`。只影响名字，不影响功能。

---

## 工具

工具只在「插件工具」这个内置插件开着时提供（有工具插件时它自动开）。它们也会自动成为 Library 里的一个 MCP 服务器，可按 agent 开关，或走 MCP 路由（名字变成 `memorysql__search` 这种）。

| 工具 | 用途 |
|---|---|
| `get_context` | 续接包：全局/项目记忆 + 项目总结 + 最近会话 |
| `get_project_brief` | 项目交接简报 + 上一棒 tail + 待确认进度 |
| `get_project_digest` | 项目滚动总结（总览/最近进展/待办） |
| `list_projects` | 项目清单（会话数/最近活跃/总结时间） |
| `list_sessions` | 按项目/agent/时间列会话 |
| `get_session` | 按 id 深读会话（tail/full） |
| `search` | 跨 agent 全文检索（会话/消息/记忆） |
| `write` | 写长期记忆（`readOnly: true` 时隐藏） |
| `log_progress` | 收工汇报（`readOnly: true` 时隐藏） |
| `stats` | 知识库规模 |

`get_context` / `get_project_brief` / `list_sessions` / `search` / `write` / `log_progress` 都支持 `cwd`（绝对路径）：MemorySQL 按最长路径前缀匹配项目，agent 在子目录里启动也能回到项目根。

---

## 自动续接（网关钩子）

`hooks.mjs` 导出的 `onRequest`：

1. 只对本机请求（`origin` 为 `local` / `magpie-key`）生效；远程默认关。
2. 按 `ctx.session`（没有就用 `cwd + 第一条用户消息` 的哈希）缓存续接包。
3. 调 `memory_get_context({ cwd, agent })`，把结果裁剪到 `maxBytes`，包在
   `<memorysql-context>…</memorysql-context>` 里，追加到**第一条用户消息**。
4. 同一 session 后续请求复用缓存块；首条用户消息在客户端历史里始终存在，所以前缀稳定。
5. 任何失败/超时/空结果都 **fail open**：请求原样放行。

跳过：`skipAgents` 里的 agent、子代理请求（`skipSubagents`，默认 true）、magpie 内部请求（`memory` / `title` / `classifier` 等）。

**隐私**：注入 = 本地记忆会随请求发给模型厂商。magpie 的 masking 在请求出口处执行，注入内容也会被一起脱敏；`recallRemote` 默认关。不想让某个 agent 看到记忆，把它加进 `skipAgents`。

---

## 会话回写（默认关）

打开 `capture: true` 后，`onResponse` 把「请求里的 user/assistant 文本历史 + 本轮回复」
通过 MemorySQL 的 `memory_import_session` 回写（工具调用不写入，保持档案精简）：

- 按 `(agent, externalId)` 去重；`externalId` 优先用 agent 的原生 session id。
- 消息级 diff：后续轮次只追加新尾部。
- 不会截短文件捕获：如果 MemorySQL 里已有更完整的同源会话，回写会跳过。
- 捕获的是客户端自己的历史，**不含**注入的续接包。
- 默认只回写本机请求；`captureRemote` 控制远程。

适合：magpie 路由但 MemorySQL 没有捕获适配器的 agent（聊天页、远程客户端等）。有原生捕获的 agent 通常不需要打开，避免双写。

---

## 页面

`page/index.html` 是「带路页」：magpie 的插件页面在 sandbox 里（`connect-src 'none'`），
所以它只负责接住 agent 行菜单的 action，然后把框架导航到插件自己的本地服务
（`127.0.0.1:<pagePort>`，默认 3488）。真正的 UI 由 `service.mjs` 提供：

- 状态：版本、端口、会话/记忆/项目数
- 项目列表 → 续接包 / 项目总结 / 会话
- 会话详情（tail 200）
- 跨 agent 搜索
- `?agent=` 过滤（从 agent 行菜单进来时）

页面只读。服务只绑 `127.0.0.1`，校验 Host / Origin，拒绝非本服务的来源。

`magpie web` 下优先使用桥接给的 `magpie.service` 地址；没有时回落到 `127.0.0.1:<pagePort>`。

---

## 选项

| 选项 | 默认 | 说明 |
|---|---|---|
| `port` | `8642` | MemorySQL MCP 端口；被占用时 MemorySQL 会 +1，插件会扫描 8642–8652 |
| `endpoint` | `""` | 显式端点（只取端口），优先于 `port` |
| `readOnly` | `false` | 隐藏 `write` / `log_progress`（不影响回写） |
| `recall` | `true` | 网关自动续接 |
| `capture` | `false` | 会话回写 |
| `maxBytes` | `6000` | 注入块上限（字符） |
| `gatewayTimeoutMs` | `1500` | magpie 给钩子的预算；内部 fetch 留 250ms 余量 |
| `skipAgents` | `[]` | 不注入/不回写的 agent（magpie 显示名，大小写/空格/标点不敏感） |
| `skipSubagents` | `true` | 跳过子代理请求 |
| `recallRemote` | `false` | 远程/网关密钥请求也注入 |
| `captureRemote` | `false` | 远程/网关密钥请求也回写 |
| `pagePort` | `3488` | 页面服务端口 |

---

## 开发

```sh
node --test                 # 21 项单测：协议注入、端点发现、钩子召回/捕获、页面服务
magpie plugin add ./        # 加载到本机 magpie
magpie plugin               # 看工具/钩子/页面是否都在
```

自测时最好给 magpie 一个独立的配置目录（magpie 在 Windows 上使用 `~/.config/magpie`）。MemorySQL 不存在时，钩子会 fail open，工具会返回「MemorySQL 未运行」。

### 发布

1. `npm publish`（包名 `@logic647/tools-memorysql` 或改成 `@magpie-community/tools-memorysql`）
2. GitHub 仓库加 topic `magpie-plugin` → Discover → 非官方插件
3. 想进官方评审列表：给 [magpie-community/plugins](https://github.com/magpie-community/plugins) 提 PR，在 `registry.json` 加一条（`kind: "tools"` 或 `page`，带 en/zh summary）

---

## 限制

- MemorySQL 必须运行（MCP 跑在 Electron 主进程里）；MCP 关掉或 app 退出时工具会报错、钩子静默跳过。
- 网关钩子默认只有 1.5 秒预算；MemorySQL 本机查询通常几十毫秒，冷启动/主进程忙碌时可能超时，失败开放。
- 不是 magpie 内置 Memory 的替代品；两套记忆会同时注入时，建议二选一或把 MemorySQL 定位成项目/会话层。
- 插件以你的权限运行（和 magpie 的其他插件一样）；只安装你信任的代码。
