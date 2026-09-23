# MemorySQL — 面向个人开发者的"可延续开发"知识库

> 本文件是任何 agent 接手本项目的**唯一入口**。读完本文件 + `docs/DEVLOG.md` 最新一条,即可无缝续接开发。

## 一句话定位

本地优先的 Electron 桌面应用:存储**个人记忆(人物画像)、AI agent 会话记录、开发过程**,通过 MCP 让任意 agent "连接即续接"——新会话一句话恢复全部上下文。除 LLM API 外零服务器依赖。

## 必读文档

| 文件 | 内容 |
|---|---|
| `docs/architecture.md` | 架构、插件系统、数据模型、适配器细节、全部决策记录 |
| `docs/DEVLOG.md` | 追加式进展日志,**最新一条 = 当前进度与下一步** |
| `docs/HANDOFF.md` | 时点交接快照(2026-09-17 · v0.5.1 后):发布渠道现状、待办、发版流程与关键操作知识 |

## 技术栈(已定,勿改)

- Electron + TypeScript(strict)+ React + CodeMirror 6(M4 编辑器)
- 存储:笔记 = Markdown 文件(`vault/`);记忆/会话 = SQLite(better-sqlite3 + FTS5)
- 插件系统:**一步到位**,核心功能即内置插件(见 architecture.md)
- 构建:electron-vite;测试:vitest

## 目录结构

```
AGENTS.md                  ← 本文件
docs/architecture.md       ← 架构与决策记录
docs/DEVLOG.md             ← 进展日志(追加式)
src/main/                  ← 主进程:入口、插件宿主、DB
src/plugins/<id>/          ← 插件(manifest.json + index.ts)
src/preload/  src/renderer/  src/shared/
vault/                     ← MD 笔记库(Obsidian 兼容)
test/fixtures/             ← 脱敏真实会话样本(适配器测试用)
memory.db                  ← SQLite 数据库(运行时生成)
```

## 常用命令

```bash
npm install          # 安装依赖
npm run dev          # 开发模式(热重载)
npm run build        # 构建
npm run typecheck    # 类型检查
npm test             # vitest 单元测试
npm run import:scan  # 无头模式:扫描导入三个 agent 的真实会话(验收用)
npm run dist         # 打包 Windows 安装包 + 免安装目录(需 ELECTRON_BUILDER_BINARIES_MIRROR,见 DEVLOG)
```

## 开发铁律

1. **一切功能皆插件**:新增功能 = 新增 `src/plugins/<id>/`,通过 PluginContext 注册能力,禁止在宿主里写业务逻辑
2. **本地明文,出口脱敏**:入库不做脱敏,本地界面/MCP 全量可见;任何"导出/分享"路径必须过 `privacy-export` 模块
3. **处理默认本地规则**:LLM 永远是可切换的可选项,LLM 不可用时自动降级回规则
4. **不导入密钥文件**:各 agent 的 `.env`/`config.yaml`/`credentials*` 一律跳过
5. **原始文件只读**:所有适配器只读 agent 的数据,永不修改外部文件
6. **同步字段**:业务表必须带 `updated_at / device_id / deleted`(tombstone),为增量同步预留
7. 文档同步:每完成一个里程碑,追加 `docs/DEVLOG.md` 并更新本文件"当前状态"

## 当前状态(接手 agent 从这里开始)

- **M0–M6 全部完成**(2026-08-31):M5 = 审计修复 + 会话 ID + 七 agent 捕获矩阵 + 记忆 agent 维度/规则提炼/LLM 精炼 + 外部插件加载 + 液态玻璃 UI(细节见 DEVLOG);M5.2 = 外部测试修复(记忆/笔记进 MCP 全文检索、Hermes 记忆 § 分段、版本号、get_context 会话 id);**M6 = MCP 工具矩阵 v2(4→7 工具:get_context agent 过滤+交接摘要、memory_list_sessions、memory_get_session full、memory_search kind/agent/project/since 过滤、memory_write 归因+tags/project、memory_log_progress 收工汇报→候选记忆)+ 交接简报 memory_get_project_brief + 写入去重**(LLM 冲突检测顺延 M7)
- **M0–M7 完成;M8 分发完成**(2026-08-31):语义检索/托盘秒搜/项目日志/冲突检测均已上线;CI 已接(main 推送自动 ci+package);**v0.4.1 已发版**(README 社区标准重写+CI 自动 Release);推送走服务器 bundle 中转(本机直连 github.com:443 被墙,见 DEVLOG);winget PR 已提(microsoft/winget-pkgs#426778,CLA 已签)+ scoop bucket 上线
- **内存治理 + 开机自启动**(2026-09-02):A1–A7 七项优化(cytoscape 泄漏、语义索引水位增量同步+移除清扫、embedder 空闲 15min 释放、sessions:get 尾页 200 分页、memories:list 分页、memory_get_session 线性化、单实例锁);core-launcher 插件(setLoginItemSettings + `--hidden` 驻留托盘,设置页「通用 · 启动」);顺带修 privacy-export 传参 bug(会话导出一调即抛)
- **v0.4.2 已发版**(2026-09-02):内存治理七项 + core-launcher 开机自启动 + **检查更新/自动更新链路修复**(electron-updater ESM 互操作 bug,0.4.0/0.4.1 的自动更新自始未工作过——旧版用户需手动装 0.4.2,之后可自动更新)。CI 发版注意:electron-builder publish 常只传上 blockmap,需从 artifact `gh release upload --clobber` 补齐三件套后转正
- **换机适配修复**(2026-09-11):用户从旧机(用户目录 `C:\Users\18144`、项目在 F:)迁到新机(`C:\Users\Logic`、项目在 H:)。Hermes/Codex 配置路径失效自动回退(resolveHermesHome 探测链:配置→注册表→盘符→home;factory+codex 双处);**Claude Desktop 捕获上线**(桌面版 SDK 不落盘对话,只有元数据+history.jsonl,三源合并去重);ingest 对自带标题/零消息会话跳过 LLM。真实验证:claudecode 103 / codex +2 / hermes +1 / 记忆候选 +7
- **国内 agent 适配**(2026-09-12):新增 capture-qwencode / capture-kimicli / capture-codebuddy 三插件(格式经官方文档/源码调研,本机未装→合成样本+隔离端到端验证);连接向导同步支持三家;App.tsx 侧栏捕获列表补全为 10 个。Trae CN(加密)/通义灵码(云端)不可行已记录;iFlow CLI 留作后续
- **v0.5.0 已发版**(2026-09-12):换机适配 + 国内 agent 适配内容。**推送通道变更:新机器网络下 github.com:443 直连已恢复,直接 `git push` 即可,服务器 bundle 中转流程退役**;gh CLI 缺失时发版收尾走 GitHub API(凭据在 git credential store)。package job 在 main 推送也会建草稿(与 tag 草稿重复,发版时删重再转正)
- **宣传物料已备**(2026-09-13):`docs/promo/` 全套中文首发帖(V2EX/掘金/少数派/即刻)+ 发布 checklist(顺序/渠道规则/Q&A 预案)+ 截图清单;**6 张截图已自动化截好**(01 用演示库可公开,02-07 真实库待用户过目;05 图谱放弃、08 待手动);README 加嵌图段(图已入位);MCP_LISTING 核对至 0.5.0 + 各目录提交表单(**mcp.so 立即可提**、PulseMCP 暂停收录、Smithery 形态不匹配暂缓)
- **v0.5.1 已发版**(2026-09-17):包含 `import-chat` 对话导入插件（粘贴聊天文本或选择导出文件即可启发式还原入库，解决 Trae CN/通义灵码等加密与云端 agent 捕获）+ **Linux 跨平台首发支持**（electron-builder AppImage/deb/tar.gz 产物、Linux 窗口自适应边框兼容、GitHub Actions 双矩阵构建同时产出 Windows 与 Linux 全量资产）+ 设置页应用内更新状态透出。CI 全绿，三件套与 Linux 四资产公网可达。
- **ZCode/OpenCode SQLite 权威存储适配**(2026-09-20):两家(opencode 系同源)把权威会话库迁到 SQLite 三表(session/message/part,ZCode 在 `~/.zcode/cli/db/db.sqlite`、OpenCode 在 `~/.local/share/opencode/opencode.db`),旧适配器读 rollout/JSON 树导致"项目不识别/未检测到"。修复:共享解析器 `_lib/agent-db-parser.ts`(快照读锁库,cwd/标题/时间/工具全量携带,externalId 用会话原生 id → 旧数据自动升级),zcode watcher 事件按会话增量重读权威库,**GUI 启动自动扫描**(离线期间会话启动即入)。真机验证:money 项目识别(4 会话)、opencode 6 会话入库
- **v0.5.2 已发版**(2026-09-21):SQLite 权威存储适配 + 启动自动扫描。**发版收尾已脚本化**: `node scripts/publish-release.mjs <tag> <title> <notes-file>`(删重复草稿→转正→notes,token 走 credential store);本版 7 项资产由 electron-builder 合并在同一草稿,脚本验证后转正。0.5.1 装机启动即静默收本版
- **v0.5.3 已发版**(2026-09-22):①启动自动更新——probe 改走 api.github.com + 失败进 `updaterState.error` 不再静默 + `push:update-status` 应用壳横幅 + 状态机遮蔽修复(`src/main/core/update-check.ts` + `startupUpdateCheck`);②项目/会话重命名——`content_hash` 相同仍轻量 UPDATE title/cwd/project(+FTS),`ensureProject` 对同父目录孤儿项目收养并 re-point 旧会话,cwd 仅在磁盘存在时采纳,`capture-opencode` 补 db watcher;审查修 P1 probeConfirmed 防 latest.yml 滞后清可用性、P2 横幅/Settings 状态互斥、P3 watchPaths 函数化+WAL match。typecheck 0 错 / vitest 120:120(`update-check` 14 + `ingest-sync` 6)。https://github.com/Logic647/MemorySQL/releases/tag/v0.5.3
- **腾讯 WorkBuddy 适配**(2026-09-22):`capture-workbuddy` 捕获 `~/.workbuddy/projects/**/*.jsonl` + `workbuddy.db` 元数据增强(title/cwd/created_at);watcher 覆盖 jsonl/db;MCP 连接器写 `~/.workbuddy/mcp.json` 的 `mcpServers.memorysql`。本机未装,合成样本单测 5 用例
- **Qoder CLI / CN 适配**(2026-09-23):`capture-qoder` 双根 `~/.qoder` + `~/.qoder-cn` 的 `projects/**/*.jsonl`(Claude 兼容)+ `state.json` 补 title/cwd;`watchPaths` 工厂签名改为收 `sourceRoot`;MCP 连接器写 `settings.json`。调研:iFlow 已停服(待办作废)、Comate Zulu 高优先待做
- **v0.5.4 已发版**(2026-09-23):WorkBuddy + Qoder 双适配 + capture-factory `watchPaths(sourceRoot)`。CI 双矩阵全绿,7 资产;typecheck 0 / vitest **126:126**。https://github.com/Logic647/MemorySQL/releases/tag/v0.5.4
- 精确进度:见 `docs/DEVLOG.md` 最新一条(顶部);下一步:**真机验收 v0.5.4(WorkBuddy/Qoder 适配 + 0.5.3→0.5.4 自动更新,装机后)**、用户过目截图 → 按 `docs/promo/checklist.md` 发布宣传(V2EX 首发等)、winget bot 跟进(0.5.x 版 PR)、评估 Comate Zulu
- 常用验证:`npm run import:scan`;`npx electron . --dispatch`;`npx electron . --sync <folder>`;`npx electron . --scan --export-archive <path>`;`npx electron . --reindex`(语义全量重建);运行中 `curl http://127.0.0.1:8642/health`
- 验收数据(本机真实存在):Codex `~/.codex/sessions/**/rollout-*.jsonl`;ZCode `~/.zcode/cli/db/db.sqlite`(权威库,rollout 仅剩 model-io 日志作 watcher 信号)+ `~/.zcode/cli/rollout/`;Hermes `G:\Hermes Agent CN Desktop\data\hermes-home\state.db`(0.7.0 布局:根级,旧机曾为 profiles/daily)+ `memories/*.md`;Claude Desktop `%LOCALAPPDATA%\Claude-3p\claude-code-sessions\**\local_*.json`(仅元数据,无对话正文)+ `~/.claude/history.jsonl`;OpenCode `~/.local/share/opencode/opencode.db`(SQLite,storage/ JSON 树为旧版遗留);Qwen Code/Kimi CLI/CodeBuddy/WorkBuddy 本机未装(格式:qwen `~/.qwen/**/chats/*.jsonl`、kimi `~/.kimi/sessions/**/context.jsonl`、codebuddy `~/.codebuddy/projects/**/*.jsonl`、workbuddy `~/.workbuddy/projects/**/*.jsonl` + `workbuddy.db`),合成样本单测 + `MEMORYSQL_DATA_DIR` 隔离端到端覆盖;Gemini/Cursor 本机未装,合成样本单测覆盖
