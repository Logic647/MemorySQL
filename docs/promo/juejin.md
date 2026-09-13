# 掘金帖(技术向)

> 标签建议:Electron、AI、MCP、开源。发布前替换 `〔图:xx〕` 并删除引用块。比 V2EX 版多架构与数据层细节,读者是"想知道怎么做的"。

## 标题候选(选一)

1. 我用 Electron 造了个 agent 记忆库:10 家 AI 编码 agent 会话自动捕获 + MCP「连接即续接」
2. 给 AI agent 做"跨会话记忆"这件事,我在本机把它落地了(开源)

---

## 正文

## 起因:会话历史是一堆"数据孤岛"

我同时用三四个 AI 编码 agent(Codex、ZCode、Claude Code、Hermes……),它们各有一套会话存储,而且**藏得越来越深、格式各不相同**:

| Agent | 会话数据位置(2026-09 时点) | 格式 |
|---|---|---|
| Codex CLI | `~/.codex/sessions/**/rollout-*.jsonl` | JSONL 树(含分支) |
| ZCode | `~/.zcode/cli/rollout/` | JSONL |
| Claude Code(CLI) | `~/.claude/projects/**` | JSONL |
| Claude 桌面版 | `%LOCALAPPDATA%\Claude-3p\**\local_*.json` + `~/.claude/history.jsonl` | **对话正文不落盘**,只有元数据 |
| Qwen Code | `~/.qwen/projects/**/chats/*.jsonl` | JSONL 树,GenAI 线格式(`functionCall`/`functionResponse`) |
| Kimi CLI | `~/.kimi/sessions/<md5(cwd)>/<uuid>/context.jsonl` | kosong 消息行,**无逐条时间戳** |
| CodeBuddy Code | `~/.codebuddy/projects/**/*.jsonl` | 与 Claude Code 同构 |
| Hermes(桌面) | 自带 state.db + `memories/*.md` | SQLite |

(桌面端如 Trae 走 SQLCipher 加密、通义灵码纯云端,会话在本地根本拿不到——这部分只能放弃或走导入。)

这些孤岛带来两个问题:**换 agent 要重新铺垫全部背景**;**想搜一条历史会话无从下手**。

## 我做了什么

MemorySQL——本地优先的 Electron 应用,三件事:

**1. 捕获层:一家一个适配器,统一走 capture-factory**

10 家 agent(Codex / ZCode / Claude Code / Hermes / Gemini / Cursor / OpenCode / Qwen Code / Kimi CLI / CodeBuddy Code)各一个捕获插件,共用同一套工厂:文件发现 → 解析 → 消息归一化(统一为 user/assistant/tool 三角色 + 工具名)→ 入库。chokidar 监听增量,原始文件**只读不改**;`.env`/`credentials*` 一律跳过。Claude 桌面版那种"没有正文只有元数据"的,三源合并去重(完整 transcript > 桌面元数据 > history 提示分组)。

**2. 存储层:SQLite 双索引**

better-sqlite3 单文件库,业务表全部带 `updated_at / device_id / deleted`(tombstone,为增量同步预留)。检索两条腿:

- **FTS5 trigram**:中文友好,不需要分词器
- **sqlite-vec + 本地 ONNX embedding(bge-small-zh)**:语义召回,全程离线;`memory_search` 里字面未命中的概念性查询用「·语义」标注补足

**3. MCP 层:7 个工具,本机 `http://127.0.0.1:8642/mcp`**

核心是 `memory_get_context`:一次调用返回画像 + 长期记忆(可按 agent 过滤)+ 项目状态 + 最近会话(带 id)+ **上一棒交接摘要**(内联最近会话 tail)。新会话一句「续接 <项目名>」就恢复全部上下文。

〔图:01-context-handoff —— agent 终端里的续接包实况〕

其余:`memory_get_project_brief`(交接简报)、`memory_list_sessions` / `memory_get_session`(回读)、`memory_search`(双路检索)、`memory_write`(写记忆,agent 归因 + 去重)、`memory_log_progress`(收工汇报 → 候选记忆,人工确认才转正)。

〔图:02-sessions —— 会话库〕

## 几个值得聊的工程决策

- **本地明文,出口脱敏**:入库不脱敏(界面/MCP 全量可见),但任何导出/分享路径强制过 privacy-export 模块——信任模型是"本机是你的地盘,出口才是边界"。
- **LLM 是可选项**:会话摘要/冲突检测用 LLM,但没有 LLM 自动降级回规则提炼,零配置可跑。
- **一切皆插件**:捕获、检索、脱敏、开机自启,全是插件,和外部插件走同一套加载协议(`manifest.json + main.js` 单文件 CommonJS,ctx 提供 db/ipc/mcp/watcher/events 能力,单插件异常被宿主隔离)。
- **内存治理踩过的坑**:cytoscape 实例泄漏、语义索引全量重算改水位增量、ONNX InferenceSession 空闲 15 分钟释放、大会话 tail 分页——桌面常驻应用内存就是产品体验的一部分。

## 试用

```bash
winget install Logic647.MemorySQL   # 审核中
# 或 Releases 下安装包 / 便携版;scoop bucket 见 README
```

装完它就在托盘常驻(MCP 保持在线),设置 → 连接 Agent 向导一键写入 10 家 agent 的 MCP 配置(写入前自动备份原配置)。

〔图:08-project-log —— 自动项目日志(可选;截图未就位就删掉这段)〕

GitHub(MIT):https://github.com/Logic647/MemorySQL

欢迎来 issue 区提需求:想接哪家 agent、想要什么 MCP 工具。
