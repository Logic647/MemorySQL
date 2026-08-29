# MemorySQL

面向个人开发者的"可延续开发"知识库。本地优先的桌面应用:存储**个人记忆(人物画像)、AI agent 会话记录、开发过程**,agent 通过 MCP"连接即续接"——切换 agent / 项目 / 会话不再丢失上下文。

## 核心特性(当前进度)

- ✅ **会话自动捕获**:Codex CLI / ZCode / Hermes Agent CN Desktop 三适配器,自动解析本地会话文件并入库(规则摘要 + 去重 + 增量监听)
- ✅ **知识库浏览**:会话列表、消息时间线、按 agent 过滤、中文全文检索(SQLite FTS5 + trigram)
- ✅ **记忆导入**:自动收录 Hermes `MEMORY.md` / `USER.md` 等记忆文件
- ✅ **MCP server**:任意 agent 连接即续接 —— `memory_get_context`(画像+项目+近况一次拉齐)/ `memory_search` / `memory_write`,仅监听 127.0.0.1,stdio agent 用 `scripts/mcp-bridge.mjs`
- ✅ **出口脱敏**:导出会话 MD 时自动遮蔽密钥/口令/JWT 等(本地数据永远明文自可见)
- ✅ **归档迁移**:`.msqlv` 一键导出/导入(VACUUM INTO 一致性快照 + 启动期原子换库)
- ✅ **插件化架构**:核心功能即内置插件,统一生命周期与能力注册接口
- 🔲 M3:画像管理、LLM 摘要(可选)、记忆分发(反向生成各家记忆文件)、增量同步
- 🔲 M4:Markdown 笔记编辑与图谱

完整规划见 [AGENTS.md](AGENTS.md) 与 [docs/architecture.md](docs/architecture.md)。

## 隐私模型

**数据 100% 本地**(`data/` 目录已被 gitignore,永不入库):会话原文、记忆、笔记全部明文存本机,自己可见;任何"导出/分享"路径统一经过脱敏模块后才对外。

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
