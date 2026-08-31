# MemorySQL

面向个人开发者的"可延续开发"知识库。本地优先的桌面应用:存储**个人记忆(人物画像)、AI agent 会话记录、开发过程**,agent 通过 MCP"连接即续接"——切换 agent / 项目 / 会话不再丢失上下文。

## 核心特性(当前进度)

- ✅ **会话自动捕获**:Codex CLI / ZCode / Hermes Agent CN Desktop 三适配器,自动解析本地会话文件并入库(规则摘要 + 去重 + 增量监听)
- ✅ **知识库浏览**:会话列表、消息时间线、按 agent 过滤、中文全文检索(SQLite FTS5 + trigram)
- ✅ **记忆导入**:自动收录 Hermes `MEMORY.md` / `USER.md` 等记忆文件
- ✅ **MCP server**:任意 agent 连接即续接 —— 7 个工具:`memory_get_context`(续接包,agent 过滤+上一棒交接摘要)/ `memory_get_project_brief`(交接简报)/ `memory_list_sessions` / `memory_get_session` / `memory_search`(全文检索会话、消息、**记忆与笔记**,可按 agent/项目/时间过滤)/ `memory_write`(agent 归因+标签)/ `memory_log_progress`(收工汇报→候选记忆),仅监听 127.0.0.1,stdio agent 用 `scripts/mcp-bridge.mjs`
- ✅ **出口脱敏**:导出会话 MD 时自动遮蔽密钥/口令/JWT 等(本地数据永远明文自可见)
- ✅ **归档迁移**:`.msqlv` 一键导出/导入(VACUUM INTO 一致性快照 + 启动期原子换库)
- ✅ **笔记与图谱**:vault/ 内 Markdown 笔记(CodeMirror 6 编辑、Ctrl+S 保存)、[[双向链接]] + 反向链接、标签、知识图谱;Obsidian 兼容(直接用 Obsidian 打开 vault/)
- ✅ **项目文件监听**:只读导入项目内 AGENTS.md / CLAUDE.md / MEMORY.md 为记忆
- ✅ **自动项目日志**:按项目在 `vault/devlog/` 生成开发日志(会话时间线 + 决策 + 待办),扫描/导入后自动更新,顶栏一键重新生成;写进 vault 即进入笔记检索
- ✅ **托盘常驻 + 全局秒搜**:关闭主窗口即隐藏到托盘(MCP 服务端保持常驻),任意界面 `Alt+Shift+M` 唤起 Spotlight 式秒搜(会话/消息/记忆/笔记一起搜,Enter 直达)
- ✅ **插件化架构**:核心功能即内置插件,统一生命周期与能力注册接口,API 文档见 docs/plugins.md
- 🔲 后续:**M7 剩余 = 本地语义检索(sqlite-vec)+ SQLCipher 静态加密**;M8 打包分发 —— 完整路线图见 [docs/architecture.md](docs/architecture.md) §8

完整规划见 [AGENTS.md](AGENTS.md) 与 [docs/architecture.md](docs/architecture.md)。

## 隐私模型

**数据 100% 本地**(`data/` 目录已被 gitignore,永不入库):会话原文、记忆、笔记全部明文存本机,自己可见;任何"导出/分享"路径统一经过脱敏模块后才对外。

## 快速连接 Agent

前提:**MemorySQL 应用处于运行状态**(它就是 MCP 服务端)。

1. 打开应用 → 设置 → **连接 Agent 向导**
2. 对你已安装的 agent 点「一键连接」——应用会自动把 MCP 配置写入该 agent 的配置文件(写入前自动备份为 `*.bak-memorysql`),状态列会显示"已检测到 / 未检测到"
3. 重启该 agent,即可使用 `memory_get_context`(续接包)、`memory_search`、`memory_write`、`memory_get_session` 四个工具

已支持自动写入:Codex CLI(`config.toml`)、ZCode(`config.json`,http 直连)、Claude Code(`~/.claude.json`)、Gemini CLI(`settings.json`)、Cursor(`mcp.json`)、OpenCode(`opencode.json`)、**Hermes Agent**(`config.yaml` 的 `mcp_servers:`,streamable http + stateless,写入后 `/reload-mcp` 或重启生效)。
想手工配置:每行有「复制配置」按钮给出精确片段。Hermes 等无 MCP 能力的 agent 走记忆文件桥:其记忆文件会被自动导入,`vault/dispatch/` 下的分发文件可反向喂给 agent。

## 插件技术规范(社区插件)

MemorySQL 一切功能皆插件,并支持**外部插件**。把插件放进 `<数据目录>/plugins/<id>/`(设置 → 插件管理 → 打开插件目录),重启即加载:

```
plugins/my-plugin/
├── manifest.json   # {"id":"my-plugin","name":"My Plugin","version":"0.1.0","main":"main.js"}
└── main.js         # CommonJS 单文件,export default {manifest, init(ctx), start?, stop?}
```

约定与技术约束:

- `main.js` 必须是 **CommonJS 单文件 bundle**,入口 `module.exports.default = {manifest:{id,name,version}, init(ctx){…}}`;id 与 manifest.json 一致,只含 `[a-z0-9_-]`
- **不得携带 npm 依赖与原生模块**——文件监听用 `ctx.watcher`,SQLite 用 `ctx.db.sqlite`,HTTP 用 Node 全局 fetch
- `ctx` 提供:db(迁移/句柄)、settings(命名空间键值)、ipc(注册渲染通道)、mcp(注册 MCP 工具)、watcher、events、services(插件间服务)、env(数据目录路径)——完整 API 见 [docs/plugins.md](docs/plugins.md)
- 单个插件加载失败只禁用自身并在设置页展示原因,不影响应用与其它插件;每个插件可在设置中启停(重启生效)
- API 版本随 manifest `version` 演进;破坏性变更会在 DEVLOG 标注

## 开发

```bash
npm install        # 安装依赖(Electron 下载慢时: ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/)
npm run dev        # 开发模式
npm run build      # 构建
npm test           # 单元测试
npm run typecheck  # 类型检查
npm run import:scan # 无头扫描导入本机 agent 会话(验收)
```

技术栈:Electron + TypeScript + React + better-sqlite3(FTS5)+ electron-vite。

## License

MIT
