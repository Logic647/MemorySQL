# 掘金帖(技术向)

> 标签建议:Electron、AI、MCP、开源。发布前把 `〔图:xx〕` 替换为实际贴图(掘金编辑器直接粘贴,自动上传图床),删掉所有引用块。标题选一个。
>
> ⚠️ 截图使用:**01**(演示库,可公开)、**02/03**(v0.6.0 新版重截)可用;**04/06/07 是旧 UI(带已下线的导航图标),弃用**。

## 标题候选(选一)

1. 我给 12 家 AI 编码 agent 造了个本地记忆库:会话自动捕获 + MCP「连接即续接」(开源)
2. 换 AI agent 不用重新铺垫背景了:SQLite + MCP 实现跨 agent 会话续接
3. 把各家 AI 编码助手的会话数据统一入库,再用 MCP 喂回去——MemorySQL 开发记

---

## 正文

## 起因:会话历史是一堆"数据孤岛"

我同时用三四个 AI 编码 agent(Codex 跑长任务、ZCode 日常干活、Claude Code / Hermes 换着用),它们各有一套会话存储,而且**藏得越来越深、格式各不相同**:

| Agent | 会话数据位置(2026-10 时点) | 格式 |
|---|---|---|
| Codex CLI | `~/.codex/sessions/**/rollout-*.jsonl` | JSONL 树(含分支) |
| ZCode | `~/.zcode/cli/db/db.sqlite` | **SQLite 三表**(2026-10 起开源) |
| OpenCode | `~/.local/share/opencode/opencode.db` | SQLite(2.x 换了新 schema) |
| Claude Code(CLI) | `~/.claude/projects/**` | JSONL |
| Claude 桌面版 | 元数据 + `~/.claude/history.jsonl` | **对话正文不落盘**,只有元数据 |
| Hermes(桌面) | 自带 `state.db` + `memories/*.md` | SQLite |
| Qwen Code | `~/.qwen/**/chats/*.jsonl` | JSONL 树,GenAI 线格式 |
| Kimi CLI | `~/.kimi/sessions/**/context.jsonl` | kosong 消息行,**无逐条时间戳** |
| CodeBuddy Code | `~/.codebuddy/projects/**/*.jsonl` | 与 Claude Code 同构 |
| WorkBuddy | `~/.workbuddy/projects/**/*.jsonl` + `workbuddy.db` | JSONL + SQLite 元数据 |
| Qoder CLI | `~/.qoder` / `~/.qoder-cn` 双根 | Claude 兼容 JSONL |

(还有两家桌面端没法直接抓:Trae CN 本地库 SQLCipher 加密、通义灵码纯云端——这类走内置的「导入对话」,粘贴聊天记录文本或选导出文件,启发式还原入库。)

这些孤岛带来两个问题:**换 agent 要重新铺垫全部背景**;**想搜一条历史会话无从下手**。

## 我做了什么

**MemorySQL**——本地优先的 Electron 应用,三件事:

**1. 捕获层:一家一个适配器,统一走 capture-factory**

12 家 agent 各一个捕获插件,共用同一套工厂:文件发现 → 解析 → 消息归一化(统一为 user/assistant/tool 三角色 + 工具名)→ 入库。chokidar 监听增量,原始文件**只读不改**;`.env`/`credentials*` 一律跳过。SQLite 权威存储的(ZCode/OpenCode)直接读库;Claude 桌面版那种"没有正文只有元数据"的,三源合并去重。

〔图:02-sessions —— 会话库,12 家 agent 的会话统一入库〕

**2. 存储层:SQLite 双索引**

better-sqlite3 单文件库,业务表全部带 `updated_at / device_id / deleted`(tombstone,为增量同步预留)。检索两条腿:

- **FTS5 trigram**:中文友好,不需要分词器
- **sqlite-vec + 本地 ONNX embedding(bge-small-zh)**:语义召回,全程离线;`memory_search` 里字面未命中的概念性查询用「·语义」标注补足

**3. MCP 层:7 个工具,本机 `http://127.0.0.1:8642/mcp`**

核心是 `memory_get_context`:一次调用返回画像 + 长期记忆(可按 agent 过滤)+ 项目状态 + 最近会话(带 id)+ **上一棒交接摘要**(内联最近会话 tail)。新会话一句「续接 <项目名>」就恢复全部上下文。

〔图:01-context-handoff —— agent 终端里的续接包实况〕

其余:`memory_get_project_brief`(交接简报)、`memory_list_sessions` / `memory_get_session`(回读)、`memory_search`(双路检索)、`memory_write`(写记忆,agent 归因 + 去重)、`memory_log_progress`(收工汇报 → 候选记忆,人工确认才转正)。

## 几个值得聊的工程决策

- **本地明文,出口脱敏**:入库不脱敏(界面/MCP 全量可见),但任何导出/分享路径强制过 privacy-export 模块——信任模型是"本机是你的地盘,出口才是边界"。代价也说清楚:本地 SQLite 是明文,且 MCP 端点只绑 `127.0.0.1`、无鉴权,完整披露在仓库 `PRIVACY.md`。
- **LLM 是可选项**:会话摘要/冲突检测用 LLM,但没有 LLM 自动降级回规则提炼,零配置可跑;语义检索是本地模型,不依赖任何云端 embedding。
- **一切皆插件**:捕获、检索、脱敏、开机自启,全是插件,和外部插件走同一套加载协议(`manifest.json + main.js` 单文件 CommonJS,ctx 提供 db/ipc/mcp/watcher/events 能力,单插件异常被宿主隔离)。
- **敢做减法**:上周(v0.6.0)把「笔记」和「知识图谱」两个功能整个砍了——长期自用后判断实用性不高,连带移除 CodeMirror 与 cytoscape,renderer 产物 2.79 MB → 0.68 MB(-75.7%)。旧数据一概不删。做加法容易,砍功能才是对自己诚实。
- **上游会改格式,得有人看着**:12 家 agent 没有一家公开承诺会话格式稳定,所以做了契约台账 + 每日黑盒探针(四态判定:匹配/漂移/源不存在/检查器故障),上游一改存储布局就能发现,而不是等用户报"会话不显示了"。
- **内存治理踩过的坑**:语义索引全量重算改水位增量、ONNX InferenceSession 空闲 15 分钟释放、大会话 tail 分页——桌面常驻应用,内存就是产品体验的一部分。

## 试用

```bash
winget install Logic647.MemorySQL   # 审核中
# 或 scoop / Releases 下安装包(Windows 105MB / macOS arm64 / Linux AppImage·deb·tar.gz)
```

装完它就在托盘常驻(MCP 保持在线),设置 → 连接 Agent 向导一键写入各家 agent 的 MCP 配置(写入前自动备份原配置)。macOS 包未签名,首次启动右键「打开」确认一次即可。

GitHub(MIT):https://github.com/Logic647/MemorySQL

欢迎来 issue 区提需求:想接哪家 agent、想要什么 MCP 工具。
