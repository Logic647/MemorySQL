# V2EX 首发帖(分享创造节点)

> 发布前:把 `〔图:xx〕` 替换为实际贴图(图见 [screenshots.md](screenshots.md)),删掉所有引用块。标题选一个,别带「开源」「求 star」以外的营销词。

## 标题候选(选一)

1. 同时用三四个 AI 编码 agent,我给自己造了个本地记忆库
2. 换 AI agent 不用重新铺垫背景了,写了个本地优先的知识库
3. MemorySQL:10 家 agent 的会话自动捕获,MCP 连接即续接

---

## 正文

各位好,分享一个我最近一两个月一直在打磨的小东西,已经发到 v0.5.0。

先说痛点。我平时同时用好几个 AI 编码 agent:Codex 跑长任务、ZCode 日常干活、Claude Code / Hermes 偶尔换着用。换来换去最烦的不是功能差异,而是**每个新会话都要重新铺垫一遍**:项目讲到哪了、我有什么偏好、之前踩过什么坑。昨天 agent A 把一个模块改了一半,今天换 agent B 接手,前因后果得再讲一遍。

更糟的是,这些会话历史各存各的:`~/.codex/sessions`、`~/.claude/projects`、各家桌面版自己的私有库,格式还都不一样。想搜"上个月那个改 WebSocket 重连的会话",基本无从下手。

所以我做了 **MemorySQL**:一个本地常驻的桌面应用,干三件事:

**1. 会话自动捕获** —— 支持 10 家 agent(Codex / ZCode / Claude Code / Hermes / Gemini / Cursor / OpenCode / Qwen Code / Kimi CLI / CodeBuddy Code),监听它们本地的会话文件增量入库,零手动操作。换机重装后重新扫描一遍,历史全回来。

**2. 记忆与画像** —— 维护一份开发者画像 + 长期记忆(偏好、决策、事实),每条记忆带 agent 归因。agent 干完活可以结构化汇报"做了什么/下一步/卡在哪",人工确认后进正式记忆,不确认就不进。

**3. MCP 服务端(核心)** —— 本机起一个 MCP 服务,任何 agent 连上后,新会话说一句「续接 <项目名>」,agent 调用 `memory_get_context` 一次拿回:你的画像、相关记忆、项目状态、最近会话列表、以及**上一棒 agent 的交接摘要**——它直接接着干就行。

〔图:01-context-handoff —— agent 终端里的续接包实况〕

〔图:02-sessions —— 会话库〕

几个顺手的小东西:

- 全局 `Alt+Shift+M` 秒搜所有会话/记忆/笔记,不切窗口
- 语义检索:本地 ONNX 模型,字面搜不到的概念性提问也能召回(「怎么把知识库迁到另一台机器」能命中"换机迁移"的会话)
- 按项目自动生成开发日志(时间线 + 决策 + 待办),Markdown 落盘
- 7 个 MCP 工具:回读会话、检索、写记忆、收工汇报、项目交接简报

**隐私立场先说清楚**:数据 100% 存本机(明文 SQLite + Markdown,Obsidian 兼容);联网的只有你自己配置的 LLM API(可选项,做会话摘要)和 GitHub 版本更新检查,其余全程离线——语义检索也是本地模型;任何导出/分享路径强制过脱敏模块。

技术栈:Electron + TypeScript + React + better-sqlite3(FTS5)+ sqlite-vec + CodeMirror 6。一切功能皆插件——会话捕获、语义检索、脱敏导出,和外部插件走完全相同的加载协议。

GitHub(MIT,求 issue 拍砖):https://github.com/Logic647/MemorySQL

安装:Releases 下安装包/便携版;`winget install Logic647.MemorySQL`(审核中);scoop bucket 也有,README 里有命令。Windows 优先,macOS/Linux 暂时源码可跑。

欢迎提需求:最想接哪家 agent、想要什么 MCP 工具,评论区聊。
