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
- **M5** 全量增强(已完成,2026-08-30):审计修复(P0×1/P1×5/P2×8)、会话 id、七 agent 连接向导、记忆 agent 维度、LLM 模型列表、外部插件加载、液态玻璃 UI、M5.1 Cursor 校准 + Hermes MCP 直连。细节见 DEVLOG
- **M5.2** 外部测试修复(已完成,2026-08-31):memories/notes 进 FTS(v3 迁移 + 触发器自动同步)、Hermes 记忆 § 分段导入(内容寻址 key + legacy 清理)、MCP serverInfo 版本号接 app.getVersion()、headless scanNow 通道过滤、get_context 会话列表带 id。细节见 DEVLOG

### M6 记忆质量与 MCP 工具矩阵 v2(下一步,2–4 周)

目标:把「连接即续接」从单向拉取升级为闭环回流;切 agent 从 4+ 次带猜测的调用降到 **2 次确定性调用**。

**MCP 工具矩阵 v2:**

| 工具 | 变更 | 说明 |
|---|---|---|
| `memory_get_context` | 增强 | `project?, agent?, include_last_session?`;记忆按 agent 过滤;最近会话带 id;`include_last_session=true` 时内联最近一次会话 tail 作为「上一棒交接摘要」 |
| `memory_list_sessions` | 新增 | `project?, agent?, since?, limit?, offset?` → `[{id, title, agent, started_at, message_count}]`;agent 侧系统性枚举入口(search 命中之外唯一的列举途径) |
| `memory_get_session` | 增强 | `id, tail?, full?`;full 模式去掉单条消息 2000 字符硬截断 |
| `memory_search` | 增强 | `query, kind?, agent?, project?, since?, limit?` 加过滤维度(已支持会话/消息/记忆/笔记四路) |
| `memory_write` | 增强 | `kind, content, agent?, project?, tags?`;归因接通 `memories.agent_type`(M5 已加列,数据流未接) |
| `memory_log_progress` | 新增 | `project, done, next?, issues?` 结构化收工汇报 → 自动关联项目 + 生成候选交接条。设计依据:agent 不会主动写好记忆,但会老实填表 |

**切 agent 理想调用流:** 现状 = `get_context` → `search` 碰运气找 id → `get_session` → …(4+ 次);v2 = `get_context(project=cwd, include_last_session=true)` → 可选 `get_session(id)`(2 次确定性)。

**其余三块:**

1. **交接简报(旗舰功能)**:`memory_get_project_brief(project?)` — 当前任务/最近决策/未完成事项/坑,自动从近期会话蒸馏成 agent 可直接消费的项目简报。需求来源:用户真实场景「为项目写一份交接文档,我要换 codex 来做这个项目」
2. **回流闭环**:会话结束自动触发 distill(规则引擎已有)→ candidate → UI 一键确认入库。铁律:**不做不经确认的全自动写入**,防止记忆库垃圾化
3. **记忆治理起步**:去重检测;冲突检测(新事实与旧 active 记忆矛盾时提示);agent_type 生效(Codex 的偏好不喂给 Hermes——既是隐私边界也是降噪)

### M7 壁垒(1–2 个月)

1. **本地语义检索**:sqlite-vec 扩展 + 本地小模型 embedding(fastembed/ONNX 级),FTS + 向量混合排序;全程离线,不破 local-first 承诺。「语义召回全部开发史,且不上云」是独一无二的卖点
2. **自动 DEVLOG**:从会话历史自动生成/维护每个项目的开发日志(用户手写 DEVLOG 的纪律就是需求证明);与 capture-watcher 双向打通,形成「项目文件 ↔ 知识库」活同步
3. **每日打开的理由**:托盘常驻 + 全局热键 Spotlight 式秒搜(会话/记忆/笔记一起搜);轻量「本周开发轨迹」仪表盘(按 agent/项目分布、活跃曲线,纯只读视图)。MCP 服务端常驻的前提是用户有每天打开它的动机
4. **静态加密(可选)**:SQLCipher,把「数据 100% 本地」升级为「100% 本地且加密」

### M8 分发与增长

1. **打包分发闭环**:electron-builder 安装包 + winget/scoop manifest + electron-updater 自动更新 + GitHub Actions CI(typecheck/test/build 三件套);发 v0.3.0 作为首个公开发行版
2. **能打的 demo**:60 秒视频——Codex 干到一半 → 换 Hermes → 一次 MCP 调用 → 无缝续接;产品价值一句话说清
3. **发布渠道**:中文社区先发(V2EX/掘金),MCP server 目录同步登记;收集首批外部用户反馈反哺 M6/M7 优先级
