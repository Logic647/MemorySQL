# MemorySQL 架构与决策记录

> 更新于 2026-08-29(项目启动时)。决策一经确认不再推翻,只增补;新增决策追加到文末。

## 1. 项目定位

痛点:开发者同时使用多个 AI agent(Codex / ZCode / Hermes CN Desktop / Claude Code …),切换 agent、项目、会话时,**记忆、人物画像、开发上下文全部丢失**,重复铺垫成本高。

方案:本地优先知识库,统一存储三类资产,agent 通过 MCP 连接后一键续接:

| 资产 | 内容 | 存储 |
|---|---|---|
| 个人记忆 / 画像 | 技术栈、编码偏好、工作习惯 | SQLite `memories` + 分发为各家 agent 的记忆文件 |
| 会话记录 | 与各 agent 的对话,自动捕获、摘要、可检索 | SQLite(原文 append-only) |
| 开发过程 | 项目决策、进度、经验 | MD 笔记(vault)+ 会话沉淀 |

## 2. 总体架构

```
┌ Electron 主进程 ────────────────────────────────────┐
│ Plugin Host — 加载/生命周期/能力注册(IPC·MCP·UI·DB) │
│ ┌ 内置插件(与社区插件同机制) ─────────────────────┐ │
│ │ core.db  core.vault  core.search  core.settings │ │
│ │ capture-codex  capture-zcode  capture-hermes    │ │
│ │ summarizer-rules  summarizer-llm                │ │
│ │ mcp-server  privacy-export  memory-core         │ │
│ │ ui-session-browser  ui-memory  …                │ │
│ │ sync-archive  sync-folder                       │ │
│ └─────────────────────────────────────────────────┘ │
│ better-sqlite3(+FTS5)  chokidar watcher             │
├ Electron 渲染进程(React)───────────────────────────┤
│ 会话浏览器 / 记忆画像 / 笔记编辑(CodeMirror 6, M4) │
└─────────────────────────────────────────────────────┘
```

## 3. 插件系统(一步到位)

- 插件 = 目录 `src/plugins/<id>/`:`manifest.json`(id、name、version、capabilities)+ `index.ts`(默认导出实现 `MemorySQLPlugin` 接口的类)
- 宿主提供 `PluginContext`,插件只能通过它拿能力:
  - `db`:迁移注册(`migrations: {version, up}[]`)+ 仓储助手
  - `ipc`:注册渲染进程可调用的 channel(经 preload 白名单暴露)
  - `mcp`:注册 MCP 工具(宿主汇总,供 mcp-server 插件使用)
  - `watcher`:chokidar 封装(路径白名单:被监测的 agent 数据目录)
  - `summarizer`:注册摘要 provider;`events`:全局事件总线;`settings`:读写设置;`log`
- 生命周期:`load → init → start → stop → unload`,宿主按依赖顺序启停
- 内置插件与未来社区插件走同一加载协议;API 未稳定前不承诺外部兼容

## 4. 数据模型(SQLite,FTS5 全文检索)

```
sessions        id PK · external_id · agent_type · project_id? · cwd
                · started_at · ended_at? · title · summary
                · raw_path? · content_hash(去重) · updated_at · device_id · deleted
session_messages id PK · session_id FK · seq · role · content · ts? · meta(JSON)
memories        id PK · kind(fact|preference|persona|decision) · content
                · source_session_id? · confidence · status(candidate|active|retired)
                · updated_at · device_id · deleted
projects        id PK · path · name · tech_stack · updated_at · device_id · deleted
notes           id PK · rel_path · title · links(JSON) · tags(JSON)
                · updated_at · device_id · deleted   ← 文件为事实来源,此处只存索引
devices         id PK · name · created_at
FTS: sessions_fts(title, summary) · messages_fts(content)  — contentless + 外部 rowid 映射
```

- 所有业务表带 `updated_at / device_id / deleted`(tombstone),为 sync-folder 增量同步预留;会话原始数据 append-only 天然免冲突,记忆/笔记 LWW 合并
- DB 文件:`<dataDir>/memory.db`;数据目录自包含(vault/ + memory.db + settings.json)→ 整夹拷贝即迁移

## 5. 适配器(捕获层)

统一产出 `RawSession{externalId, agentType, cwd?, startedAt, endedAt?, title?, messages[], rawPath?}`,经摄取管道:归一化 → content_hash 去重 → 规则摘要 → 实体抽取 → 入库 + FTS。

### capture-codex
- 源:`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`(JSONL,逐行解析,容错跳过坏行)
- 解析要点见 `src/plugins/capture-codex/README`(以真实文件为准,快照测试锁定)

### capture-zcode
- 源:`~/.zcode/cli/rollout/`(另有 `tasks-index.sqlite` 任务索引,后续版本利用)

### capture-hermes
- 根:`D:\Hermes Agent CN Desktop\data\hermes-home\profiles\<profile>\`(默认 `daily`;路径为设置项,含目录选择器)
- `state.db`:会话主库(SQLite+FTS5)。**只读连接**(`mode=ro` + busy_timeout),锁冲突降级为拷贝后读;`.lock` 跳过
- `memories/MEMORY.md`(环境/坑)+ `USER.md`(交互偏好):导入为 `memories`(source=hermes)
- `sessions/request_dump_*.json`:请求转储
- **不导入** `config.yaml` / `.env`(密钥文件)
- 记忆分发(M3):MemorySQL 反向生成 Hermes `MEMORY.md` / Codex `AGENTS.md` 等各家格式

## 6. 隐私模型

- 入库**不脱敏**:本地一切(界面、MCP 返回)全量明文,用户自己可见
- **出口脱敏**:`privacy-export` 插件在一切"向别人公开"的路径(导出 MD、分享摘要、未来 Publish)统一执行密钥/隐私正则扫描
- 适配器层硬规则:密钥文件(`.env`/`config.yaml`/`credentials*`)永不入库

## 7. 决策记录(用户确认,2026-08-29)

| # | 决策 | 理由 |
|---|---|---|
| D1 | Electron + TS + React 桌面应用 + 内置 MCP server | Obsidian 同源生态,Node 直接读各 agent 目录 |
| D2 | 混合存储:笔记 MD,记忆/会话 SQLite(FTS5) | 结构化检索与人可读两头兼顾 |
| D3 | 接入三路:MCP + 自动导入 + 项目文件监听 | MCP 通用,导入兜底,监听让沉淀发生在项目内 |
| D4 | MVP 以会话捕获为先 | 数据先积累,再围绕数据建检索与 UI |
| D5 | 三适配器:Codex + ZCode + Hermes | 本机真实数据验收;Hermes 路径由用户提供 |
| D6 | 脱敏仅发生在出口 | 隐私信息自己可见,公开时才脱敏 |
| D7 | 默认本地规则处理,LLM 后台可选(含模板) | 零成本零依赖可用,LLM 是增强 |
| D8 | 一步到位插件系统 | 核心功能即内置插件,扩展接口从第一天存在 |
| D9 | 知识库迁移:归档导入导出 + 增量同步 | 除 LLM 外零服务器依赖,数据目录自包含 |
| D10 | 开发文档 AGENTS.md 主入口 + docs/ | 本项目自身跨 agent 开发(dogfooding),并写入 agent 全局记忆 |

## 8. 里程碑

- **M0** 骨架:electron-vite + React + TS;better-sqlite3 + electron-rebuild;插件宿主;开发文档 + 全局记忆
- **M1** 捕获 MVP:三捕获插件 + 规则摘要 + 实体抽取 + FTS5 + 极简 UI(列表/详情/搜索)。验收 = 本机三源真实会话全部导入、可搜可浏览
- **M2** 服务层:mcp-server(`memory_get_context` / `memory_search` / `memory_write`)+ privacy-export + sync-archive
- **M3** 记忆与同步:memory-core 画像;summarizer-llm(切换 + 模板 + 降级);记忆分发;sync-folder
- **M4** 完全体:CodeMirror 6 笔记 + 双链/反链 + 图谱 + capture-watcher;插件 API 文档化
