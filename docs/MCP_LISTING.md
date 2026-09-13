# MCP 目录登记素材

> 用于 PulseMCP、mcp.so 等目录的登记提交。**数据以 v0.5.0 为准**(2026-09-13 与 `src/plugins/core-schema/mcp-tools.ts` 逐一核对),发新版本后重新核对工具数与 schema。目录提交状态与各目录即贴表单见文末。

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
| `memory_log_progress(project, done, next?, issues?, agent?)` | 结构化收工汇报 → 候选记忆(人工确认后转正)→ 交接简报可见 |

## 一键连接(向导内置)

Codex CLI / ZCode / Claude Code / Gemini CLI / Cursor / OpenCode / Hermes Agent CN Desktop 配置文件自动写入(写入前备份);HTTP 直连片段:

```json
{ "mcpServers": { "memorysql": { "url": "http://127.0.0.1:8642/mcp" } } }
```

## 隐私要点(目录页建议高亮)

数据 100% 本地(会话原文/记忆/笔记明文存本机);任何导出/分享路径强制过脱敏模块;语义检索用本地 ONNX 模型,检索全程不联网。

---

## 目录提交状态与表单(2026-09-13 核对)

### ① mcp.so —— ✅ 可立即提交

提交方式:在 [chatmcp/mcpso](https://github.com/chatmcp/mcpso) 仓库的 [Issue #1「Submit Your MCP Servers here」](https://github.com/chatmcp/mcpso/issues/1) 下评论(或新建 issue)。即贴模板:

```markdown
**Name**: MemorySQL
**GitHub Repo**: https://github.com/Logic647/MemorySQL
**One-liner**: Local-first knowledge base for personal developers — captures AI coding
agent sessions (10 agents), builds memory & personas, and exposes 7 MCP tools so any
agent can "connect and continue" with full context. 100% local data.
**Description**: MemorySQL is a local-first Electron app for personal developers.
It auto-captures sessions from 10 AI coding agents (Codex, ZCode, Claude Code,
Gemini, Cursor, OpenCode, Hermes, Qwen Code, Kimi CLI, CodeBuddy Code), maintains
a developer persona + long-term memory, and runs a local MCP server
(http://127.0.0.1:8642/mcp, Streamable HTTP; stdio agents via bundled bridge).
Key tools: memory_get_context (persona + memories + project state + recent sessions
+ last-agent handoff summary in one call), memory_get_project_brief,
memory_list_sessions, memory_get_session, memory_search (FTS5 trigram + local
sqlite-vec semantic recall, offline ONNX embedding), memory_write (attribution +
dedup), memory_log_progress (structured wrap-up → candidate memory).
All data stays on-device (SQLite + Markdown, Obsidian-compatible); export paths go
through a mandatory redaction module. MIT.
**Transport**: Streamable HTTP (stateless), localhost-only
**License**: MIT
```

### ② PulseMCP —— ⏸ 暂缓,盯重开

官网公告:新收录与变更**暂停受理**(正在重构收录流程,见 pulsemcp.com 首页横幅)。重开后按其提交表单填写,字段直接取下方「通用字段」。

### ③ Smithery —— ⚠️ 形态不匹配,暂缓

Smithery 的发布模型面向**可通过 CLI 安装/托管的可分发 server**(npm 包 + `smithery.yaml`)。MemorySQL 是本地桌面应用,端点只监听 `127.0.0.1`,由应用进程随启随停——用 `scripts/mcp-bridge.mjs` stdio 桥硬套 Smithery 的安装流程体验会很差(装完 server 却没有主应用)。**结论:等有官方决定(如拆出可独立分发的 server 包)再评估,现阶段不提交。**

### 通用字段(任何目录都用到,直接复制)

- **名称**:MemorySQL
- **分类**:Developer Tools / Knowledge Base / Memory
- **标签**:mcp, local-first, knowledge-base, memory, agent, sqlite, windows
- **Transport**:Streamable HTTP(stateless),`http://127.0.0.1:8642/mcp`,仅监听 127.0.0.1;stdio agent 走 `scripts/mcp-bridge.mjs` 桥接
- **平台**:Windows(安装包/免安装);macOS/Linux 源码运行
- **License**:MIT
- **长描述**:见上方案单 Description 段
- **一键连接片段**:

```json
{ "mcpServers": { "memorysql": { "url": "http://127.0.0.1:8642/mcp" } } }
```
