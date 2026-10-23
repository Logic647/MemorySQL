# CSDN 帖(教程 + 分享向)

> CSDN 受众比掘金杂,标题带足关键词利于搜索;正文把 MCP 等概念讲透,少用行话。发布时勾选「原创」,标签:#AI #开源项目 #Electron #MCP #大模型。
>
> ⚠️ 截图使用:**01**(演示库)、**02/03**(v0.6.0 新截);**04/06/07 是旧 UI,弃用**。CSDN 编辑器粘贴图片即可。

## 标题候选(选一)

1. 开源|给AI编程助手做"记忆":会话自动入库 + MCP连接即续接,支持12家Agent(Codex/Claude Code/Cursor…)
2. 同时用多个AI编码助手总失忆?我用SQLite+MCP做了个本地记忆库,换Agent不丢上下文
3. MCP实战:把12家AI Agent的会话统一存进SQLite,新会话一句话恢复全部背景

---

## 正文

## 你有没有过这种体验

现在用 AI 编程的人,手里往往不止一个 agent:Codex 跑长任务,ZCode 干日常,Claude Code、Cursor、Hermes 换着用。功能差异不是最烦的,最烦的是**每个新会话都要重新铺垫一遍背景**——项目讲到哪了、我什么技术偏好、之前踩过什么坑,换个 agent 全部归零。

更糟的是这些会话历史各存各的:`~/.codex/sessions`、`~/.claude/projects`、各家桌面版自己的私有库……格式互不相同,想搜"上个月那个改 WebSocket 重连的会话",基本无从下手。

我为此做了个开源项目 **MemorySQL**,把这件事系统性解决掉。这篇文章讲清楚它是怎么做的,以及背后的 MCP 是什么。

## MemorySQL 是什么

一个**本地优先的桌面应用**(Electron),干三件事:

1. **会话自动捕获** —— 支持 12 家 agent(Codex / ZCode / Claude Code / Hermes / Gemini CLI / Cursor / OpenCode / Qwen Code / Kimi CLI / CodeBuddy Code / WorkBuddy / Qoder CLI),监听它们本地的会话文件,增量入库,零手动操作
2. **记忆与画像** —— 维护一份开发者画像 + 长期记忆,每条记忆带 agent 归因;agent 干完活结构化汇报"做了什么/下一步/卡在哪",人工确认后才进正式记忆
3. **MCP 服务端** —— 本机起一个 MCP 服务,任何 agent 连上后,新会话说一句「续接 <项目名>」,上下文全部回来

〔图:02-sessions —— 会话库界面〕

**数据 100% 存本机**:SQLite 单文件,除你自己配置的 LLM API 外零服务器依赖,语义检索也是本地 ONNX 模型,全程离线。

## 先科普:MCP 到底是什么

MCP(Model Context Protocol)是 Anthropic 推出的开放协议,可以理解为 **"AI agent 的 USB 接口"**:

- 一方是 **MCP server**:把能力(查数据库、读文件、调 API)包装成"工具"声明出去
- 一方是 **MCP client**:各种 AI agent(Claude Code、Cursor、ZCode……都已支持),连上 server 就能调用这些工具

过去每家 agent 有私有的插件机制,接入一家做一遍;有了 MCP,做一次 server,所有支持协议的 agent 都能用。这正是 MemorySQL 选择做 **MCP server 而不是各家私有插件**的原因:写一次,12 家通吃。

## 核心设计:一个 MCP 工具调用恢复全部上下文

MCP 层一共 7 个工具,核心是 `memory_get_context`。新 agent 会话里说一句「续接 MemorySQL 项目」,agent 调用它,一次拿回:

- **开发者画像**:你是谁、技术偏好
- **长期记忆**:可按 agent 维度过滤
- **项目状态**:当前进展、决策、待办
- **最近会话列表**:带 id,agent 可以接着回读细节
- **上一棒交接摘要**:上一个 agent 干到哪,内联在返回里

〔图:01-context-handoff —— agent 终端里的续接包实况〕

agent 拿到这个"续接包"就能直接接着干活,不用你再复述一遍。

其余 6 个工具:`memory_get_project_brief`(项目交接简报)、`memory_list_sessions` / `memory_get_session`(会话回读)、`memory_search`(全文 + 语义双路检索)、`memory_write`(写记忆,带去重)、`memory_log_progress`(收工汇报)。

## 存储设计:SQLite 双索引

- **全文检索**:FTS5 trigram 分词器,中文友好,不需要额外分词库
- **语义检索**:sqlite-vec 向量扩展 + 本地 ONNX embedding(bge-small-zh)。字面搜"换机器了数据怎么办"能命中标题写着"迁移"的会话——向量召回补足,结果用「·语义」标注区分

业务表都带 `updated_at / device_id / deleted` 三件套,为将来多机增量同步预留。

## 怎么用

```bash
winget install Logic647.MemorySQL   # 或 scoop / GitHub Releases 下安装包
```

支持 Windows / macOS / Linux 三平台(macOS 包未签名,首次启动右键「打开」)。

三步上手:

1. 启动 MemorySQL(托盘常驻,MCP 端点 `http://127.0.0.1:8642/mcp`)
2. 设置 → 连接 Agent 向导 → 一键写入你用的 agent 的 MCP 配置(写入前自动备份原配置)
3. 重启 agent,新会话说「续接 <项目名>」——上下文回来了

想验证连通性:`curl http://127.0.0.1:8642/health`

## 隐私说明(重要)

这类"收集我的会话数据"的工具,隐私必须先说清楚:

- 数据 **100% 本地** SQLite 明文存储,除 LLM API(可选项)和版本更新检查外不联网
- 本地 MCP 端点只绑 `127.0.0.1` 且无鉴权——同机其他进程可读,这是信任模型的一部分,完整披露在仓库 `PRIVACY.md`
- 捕获适配器对各家 agent 的原始文件**只读不改**,`.env`/`credentials*` 一律跳过
- 任何导出/分享路径强制过脱敏模块

## 写在最后

项目开源(MIT):https://github.com/Logic647/MemorySQL

源码全部可查,插件体系也对外开放——核心能力和第三方插件走完全相同的加载协议,想接新 agent 或加 MCP 工具都可以自己动手。

欢迎 issue 区交流:你在同时用哪几家 agent?最想要什么记忆能力?
