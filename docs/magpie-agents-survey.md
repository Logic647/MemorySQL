# Magpie 支持的 agent 调研与适配决策(2026-11-10)

> 背景:用户要求对照 [magpie](https://usemagpie.ai/zh/)(AI coding agent 的模型网关,60+ 家接线)
> 的支持名单补全 MemorySQL 的捕获矩阵;**闭源一律走黑盒**(装→逼会话→抓格式→校准),不靠猜。
> 情报底座:magpie 是开源的(yetone/magpie,33k stars),它的 `internal/sessions/` 为了画用量
> 视图已经把**每家的会话存储位置与格式**用真实文件实证过一遍 —— 这是本次调研的主要事实来源,
> 辅以各上游仓库源码核对与三路并行网络调研。

## 一、结论速览

| 分层 | 家数 | 名单 |
|---|---|---|
| **已适配(本轮前)** | 13 | Codex / ZCode / Claude Code / Hermes / Gemini / Cursor(IDE) / OpenCode / Qwen Code / Kimi CLI / CodeBuddy / WorkBuddy / Qoder / DeepSeek Harness |
| **本轮新增实现** | 10 | **Goose / Droid / Cline CLI / Pi / omp / OmO / Grok Build / MiniMax Code / DevEco Code / MiMo Code** |
| **黑盒队列(格式已定位,待装机校准)** | 6 | Copilot CLI / Devin / Command Code / Snow CLI / fx / AtomCode |
| **黑盒队列(存储未定位)** | 5 | Muse Code / QwenPaw / OpenHanako / Empryo / Mister Morph |
| **不可行/不值得** | — | Antigravity 桌面版(正文加密)、Copilot 云端同步部分、Devin 云端会话主体、各桌面壳(Cindy/Lody/AionUi/Cherry Studio/Alma/Raft 等,内嵌引擎的会话已被上游捕获) |

## 二、本轮新增的 10 家(实现细节)

| agent | 厂商/开源 | 会话存储 | 证据 |
|---|---|---|---|
| **Goose** | Block→aaif-goose,Apache-2.0 | SQLite `<data>/sessions/sessions.db`(Win `%APPDATA%\Block\goose`,mac `~/Library/Application Support/Block/goose`,Linux `~/.local/share/goose`);sessions+messages 两表,session_type='subagent' 标子代理,archived_at 归档 | **源码核对**(session_manager.rs) |
| **Droid** | Factory,闭源 | `~/.factory/sessions/<id>.jsonl`(根级+按 cwd 分文件夹两代),首行 session_start,Anthropic 风格块;callingSessionId 标子代理 | **magpie 真实样本回放验证** |
| **Cline CLI** | cline/cline,开源 | `~/.cline/data/sessions/<id>/`(manifest + messages.json + 子代理 `<agentId>.messages.json`) | **真实样本回放验证** + 上游类型定义 |
| **Pi** | earendil-works/pi(原 badlogic/pi-mono),MIT | `~/.pi/agent/sessions/<cwd>/<time>_<id>.jsonl`,session 头 + message/usage/title_change 条目 | **真实样本回放验证** + 上游仓库 |
| **omp** | Pi fork | `~/.omp/agent/sessions/…` 同 Pi;子代理在与文件同名的 artifacts 目录 | **真实样本回放验证** |
| **OmO** | oh-my-openagent,开源 | `~/.omo/agent/`(引擎 senpi = pi fork),MCP `~/.omo/agent/mcp.json` 上游文档确认 | family(pi 形状)+ 上游文档 |
| **Grok Build** | xAI,**开源 Apache-2.0**(2026-07) | `~/.grok/sessions/<urlencode(cwd)>/<id>/`(summary.json + updates.jsonl,ACP 式流式 chunk) | 官方 changelog 确认路径 + **真实样本回放验证** |
| **MiniMax Code** | MiniMax,**CLI 开源 MIT**(bin mcode) | `~/.minimax/v2/sessions/<y>/<m>/<d>/<ts>-session_<base64(id)>/messages.jsonl`;**运行时 vendor 了 pi-mono** | **真实样本回放验证**(base64 id 解出 mvs_…)+ 仓库核对 |
| **DevEco Code** | 华为,BitFun+OpenCode 构建(npm @deveco/deveco-code) | opencode 系布局(会话路径官方未写,黑盒队列);MCP `.deveco/deveco.jsonc` 官方文档确认 | family + 官方文档 |
| **MiMo Code** | 小米,**开源 MIT**(XiaomiMiMo/MiMo-Code,OpenCode fork) | `~/.local/share/mimocode/mimocode.db`(Windows 同路径,`%LOCALAPPDATA%` 不用) | **真机校准 2026-11-10**:本机实装,133MB/222 会话/73 子代理,opencode legacy 三表,生产解析器副本验证 222/222 全过 |

## 三、黑盒队列(下一轮校准的输入)

### 格式已定位,装机后一次校准即可

| agent | 已知 | 安装 | 校准动作 |
|---|---|---|---|
| **Copilot CLI** | `~/.copilot/session-state/<id>/` + `session-store.db`(SQLite);MCP `~/.copilot/mcp-config.json`;COPILOT_HOME 覆盖 | `npm i -g @github/copilot`(需 GitHub 登录) | 装好后跑一轮,检查 session-state 文件格式;注意云端同步(本地删除≠用户删除,tombstone 语义要单独设计) |
| **Devin** | `~/.local/share/devin/cli/sessions.db`(message_nodes 表,chat_message JSON) | 官网脚本(需 Devin 登录) | 副本检查 schema;区分 local/cloud 会话主体 |
| **Command Code** | `~/.commandcode/projects/<slug>/<id>.jsonl` + `.meta.json` sidecar;MCP `~/.commandcode/mcp.json` | `npm i -g command-code` | 拉真实样本对 parser;⚠ 该产品默认读 Claude Code/Codex/Cursor 的会话上传做"taste 学习"——隐私文案对比点 |
| **Snow CLI** | `~/.snow/sessions/` 目录已确认 | `npm i -g snow-ai` | 跑一轮看 sessions 内部格式 |
| **fx** | `~/.fx/sessions/`(README 官方确认) | `curl -fsSL https://fx.sh/setup.sh \| bash` | 跑一轮看文件格式 |
| **AtomCode** | `~/.atomcode/sessions`(事件日志权威+快照投影) | `npm i -g @atomgit.com/atomcode` 或 cargo | 跑一轮看事件日志格式 |

### 存储未定位

- **Muse Code**(Meta,闭源):有 `--no-session-log` 标志说明本地有日志,路径未写;配置 `~/.config/muse/settings.json`。
- **QwenPaw**(阿里 AgentScope,开源):个人助理平台优先于 coding,`~/.qwenpaw/workspaces/<agent>/`,会话格式未确认,优先级低。
- **OpenHanako**(开源桌面):better-sqlite3 WAL 存对话,`~/.hanako`,表结构未探测。
- **Empryo**:资料少,v3 私有,优先级低。
- **Mister Morph**(开源):`~/.morph/journal/journal.db`(SQLite 统一日志 = 会话权威源),方向明确,价值中等。

### 不可行/不做

- **Antigravity 桌面版**:消息正文静态加密(magpie 实测),只能读到 usage;CLI 版(agy,`~/.gemini/antigravity-cli/brain/<id>/` + conversation_summaries.db)可捕获,待用户需求再排。
- **Devin 云端会话 / Copilot 云端同步**:会话主体在云端。
- **桌面壳类**(Cindy/Lody/AionUi/Cherry Studio/Alma/Raft/PI-Desktop/Kimi Code Desktop…):内嵌引擎写的会话已被对应上游适配器捕获,壳本身不加第二个入口(Alma 的 SQLite 若用户有需求再评估)。
- **VS Code Chat / JetBrains Air / Zed**:IDE 内置会话存储复杂(state.vscdb/全局存储),未列入队列。

## 三·补、真实样本回放(2026-11-10)

magpie 仓库自带 `internal/sessions/testdata`(**真实抓取的会话样本**,174 个文件),拿我们的 6 家新解析器
直接回放,发现并修掉两个只有真样本才暴露的问题:

1. **droid 角色硬编码**:用户消息的 `content` 也是 Anthropic 块数组,旧实现按「数组内容 → assistant」
   把每条用户消息都写成助手发言(样本里角色序列 `aatttta` 应为 `uatt…`)。改为内容形状不决定角色,
   角色一律取 `ev.message.role`。
2. **grok 标题回退**:`generated_title` 为空时要用 `session_summary`(magpie 同口径)。

同时确认了三条语义与我们的实现一致:cline 的 fork 会话 manifest 无 title(留空正确)、grok 只有 hook
事件无消息的会话应跳过、grok `session_kind` 只在前缀为 `subagent` 时才算子代理(有 `parent_session_id`
但无 kind 的是 fork/restore,不算)。

## 四、对 magpie 情报的几个横向认知

1. **OpenCode 与 pi 是两大血统**:MiMo Code、DevEco Code 是 OpenCode fork;OmO、StepCode(StepFun,黑盒)、MiniMax Code(vendor pi-mono)、omp 都是 pi 系。抓住这两个家族的格式,新 fork 的适配成本接近零(布局探测已内建"未知 schema 返回 []",不会误报)。
2. **magpie 的 sessions 读取器 = 现成的格式实证库**,但只覆盖它需要画用量图的 20 来家;goose/crush/copilot 这些它没写读取器的,仍要自己调研。
3. ** Crush 特殊**:数据按项目散落(`<project>/.crush/crush.db`),没有全局库 —— 捕获需要项目发现策略(从 MemorySQL 已知项目的 cwd 反查),暂缓。
4. **一个隐私对比点**:Command Code 默认(可跳过)读取竞品会话上传厂商;MemorySQL 是本地明文+出口脱敏,文案可用。
