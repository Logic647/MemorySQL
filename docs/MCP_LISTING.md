# MCP 目录登记素材

> 用于 PulseMCP、modelcontextprotocol/servers、mcp.so 等目录的登记提交。数据以 v0.4.0 为准,发新版本后核对工具数与 schema。

## 基本信息

- **名称**:MemorySQL
- **一句话**:面向个人开发者的本地优先知识库——agent 会话捕获 + 记忆画像 + 「连接即续接」,除 LLM API 外零服务器依赖
- **官网/仓库**:https://github.com/Logic647/MemorySQL
- **License**:MIT
- **Transport**:Streamable HTTP(stateless),默认 `http://127.0.0.1:8642/mcp`,仅监听 127.0.0.1;stdio agent 用 `scripts/mcp-bridge.mjs` 桥接
- **平台**:Windows(安装包 / 免安装版);macOS/Linux 源码运行

## 工具清单(7 个)

| 工具 | 说明 |
|---|---|
| `memory_get_context(project?, agent?, include_last_session?)` | 续接包:开发者画像 + 长期记忆(可按 agent 过滤)+ 项目 + 最近会话(带 id)+ 上一棒交接摘要 |
| `memory_get_project_brief(project?, agent?)` | 项目交接简报:最近会话、上一棒 tail、活跃记忆、待确认进度 |
| `memory_list_sessions(project?, agent?, since?, limit?, offset?)` | 会话枚举(带 id) |
| `memory_get_session(id, tail?, full?)` | 完整消息时间线回读 |
| `memory_search(query, kind?, agent?, project?, since?, limit?)` | 全文检索会话/消息/记忆/笔记(trigram 中文友好)+ 本地语义召回补足 |
| `memory_write(kind, content, agent?, project?, tags?)` | 写入长期记忆(归因/标签/去重) |
| `memory_log_progress(project, done, next?, issues?)` | 结构化收工汇报 → 候选记忆 → 交接简报可见 |

## 一键连接(向导内置)

Codex CLI / ZCode / Claude Code / Gemini CLI / Cursor / OpenCode / Hermes Agent CN Desktop 配置文件自动写入(写入前备份);HTTP 直连片段:

```json
{ "mcpServers": { "memorysql": { "url": "http://127.0.0.1:8642/mcp" } } }
```

## 隐私要点(目录页建议高亮)

数据 100% 本地(会话原文/记忆/笔记明文存本机);任何导出/分享路径强制过脱敏模块;语义检索用本地 ONNX 模型,检索全程不联网。
