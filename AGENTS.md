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
upstream/                  ← 上游监控:台账 JSON 导出件 + 黑盒漂移检查(check.ts)
tools/upstream-watch/      ← 云端看板服务(零依赖,部署到阿里云,见 DEPLOY.md)
test/*.test.ts             ← 单测。**样本内联在各 .test.ts 里,test/fixtures/ 不存在**
memory.db                  ← SQLite 数据库(运行时生成)
```

## 常用命令

```bash
npm install          # 安装依赖
npm run dev          # 开发模式(热重载)
npm run build        # 构建
npm run typecheck    # 类型检查
npm test             # vitest 单元测试
npm run upstream:check  # 上游契约黑盒检查:哪个 agent 改格式了导致捕获可能失效
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
- **跨 agent 会话回读**(2026-09-29,MCP 拉知识库复核):9/22–9/23 的 opencode 会话已全部对账——#216/#213/#214(启动更新排查)→ 已随 v0.5.3 落地;#217(capture 插件模式调研,含 11 家适配器结构对照表)→ 已随 v0.5.4 落地,**做 Comate Zulu 等新适配器前先读 KB 会话 #217**;#218 = 给 opencode 本体全局配置接入 `open-computer-use` MCP(`~/.config/opencode/opencode.json`,与 memorysql MCP 并列,非本项目代码);#215 = 用该环境做补天/CNVD 漏洞提交(域外工作,佐证 MCP 日常在用)。无未落地的代码增量
- **v0.5.5 已发版**(2026-09-29):OpenCode 2.x schema 适配 + 更新进度条/安装询问弹窗。CI 双矩阵全绿,7 资产一次传齐(未复现 blockmap 缺资产坑),`publish-release.mjs` 转正。https://github.com/Logic647/MemorySQL/releases/tag/v0.5.5(**装机验收已于 2026-09-30 完成**:自动更新链路 + OpenCode 2.x 捕获均真机确认,详见下方 9/30 条与 DEVLOG 顶部;WorkBuddy/Qoder 本机未装维持合成样本覆盖)
- **更新体验:进度条 + 完成询问**(2026-09-29):下载进度条(`download-progress`→`progress` 事件,横幅+设置页)与下载完成弹窗(立即重启安装/稍后,按版本记稍后);`updateNow` 不再静默 quitAndInstall,新通道 `updateInstallNow`
- **OpenCode 2.x 新 schema 适配**(2026-09-29):opencode ≥2.0 权威库三表(session/message/part)→ `session_v2` + `session_message`(parts 内嵌消息 JSON,tool 字段 `tool`→`name`)。`_lib/agent-db-parser.ts` 布局探测:legacy 优先 → session_v2 → 未知 schema 返回 [](不再抛 "no such table");zcode 旧三表零影响。vitest **128:128**;真库验收 sessionsImported 3
- **OpenCode MCP 连接器修复(2026-09-30,发版后补修)**:`agent-connect.ts` 的 opencode 连接器 `apply()`/`snippet()` 原本只写 `{url, enabled}`,**缺 `type`**;OpenCode ≥2.0 起 `type` 必填,缺了会在配置规范化阶段被**静默丢弃**(`kind=unsupported action="omitted enabled-only legacy MCP entry"`,仅 WARN 不报错),症状=会话里 7 个 MCP 工具整个不出现。重跑连接向导即自动修复存量配置。本机配置已手修(备份 `opencode.json.bak-before-mcp-fix`),`opencode mcp list` → connected;`test/agent-connect.test.ts` 4 用例锁回归
- **滚动条观感(2026-09-30)**:`styles.css` 滚动条由 9px→12px 轨道且改用 `background-clip: padding-box`(旧 `content-box` + 2px border 让净宽只剩 5px);三态高亮 常态 `.16` / hover `.34` / 按下 `--msql-accent`;`::-webkit-scrollbar-button{display:none}` + `corner/resizer{background:transparent}` 抹掉 Chromium 默认 stepper 造成的底部白方块。**已由用户 2026-09-30 在 dev 模式目视验收通过**
- **claudecode 断流已结案(2026-09-30)**:此前挂着的「自 9/11 起 19 天无新会话」**不是故障**——dev 日志 `source not detected, watcher disabled: C:\Users\18144\.claude\projects` + `scan ok: 0 found`,源目录不存在 = **本机已不装/不用 Claude Code**。其余未装适配器(qwen/kimi/codebuddy/workbuddy/qoder/gemini/cursor)同理,勿当 bug 排查
- **dev 环境两个坑(非故障)**:①dev 数据目录**不是**真库(`env.ts:23-27` 按 `app.isPackaged` 分支,dev 用仓库内 `data/`),不会污染 95MB 真库;②dev 下 MCP 显示 **8 个**工具,多出的是 `data/plugins/hello` 示例插件注册的 `hello_greet`——「7 个工具」口径对装机版成立
- **上游契约台账 + 黑盒漂移检查(2026-09-30,第 0 期)**:`src/shared/upstream-agents.ts` 声明 12 家 agent 的上游/changelog 类型/本地源/依赖的表与列/MCP 必需键(**放 shared 是因为产品代码也读它**——连接向导回读校验要用,必须进打包产物);`upstream/check.ts` 探测真实数据 schema,四态判定 🟢匹配/🔴漂移/🟡源不存在/⚪仅黑盒。**跑 `npm run upstream:check`**。**改任一 capture-* 的存储布局、或任一连接器写入的 MCP 配置格式,必须同步台账**(两条断言会红:`upstream-contract.test.ts` 台账自洽 + `agent-connect.test.ts` 连接器写入须通过台账校验)。要点:①`localRoots` 支持 `{resolver}` 复用生产代码的路径探测(hermes 装在注册表/盘符任意位置,实测在 **D 盘**而 AGENTS.md 曾记 G 盘)②`tablesAnyOf` 支持多代布局并存 ③**CI runner 无 agent 数据,漂移检查在 CI 空跑**——CI 守的是台账自洽,真实漂移须在开发机跑 ④**4 家闭源(qoder/codebuddy/workbuddy/zcode)无任何公开 changelog,只能靠黑盒**;kimicli 正确仓库是 `MoonshotAI/kimi-code`(非已归档的 Kimi-Dev)
- **捕获失效可见化 + MCP 连接回读校验(2026-09-30,第 1 期)**:`CaptureStatus` 加 `health`(unknown/healthy/suspect/failing,阈值 3,成功即归零)+ `consecutiveFailures`/`lastFailure*`/`lastSuccessAt`;**修掉 4 处静默失效点**(capture-factory 增量、codex 增量+单文件、zcode 增量+单文件、**hermes 库读取失败——最隐蔽,它在 scan 内部,失败后 scan 仍报成功连 lastError 都没有**);后三者区分「全部失败 vs 部分失败」避免误报。`connectAgent` 写完**回读校验**(按台账 jsonpath+必需键,TOML/YAML 不校验),失败则 `configured=false` + `verifyError`;期望值全取自台账,报错里 URL 替换为 `<url>`。设置页改三态(`dim` 未装 / `ok` / `warn` 偶发 / `bad` 连续失败+红)——**「没装」与「装了但读不懂」该采取的行动相反,过去渲染成同一个状态**
- **云端上游监控看板(2026-09-30,第 2 期)**:`tools/upstream-watch/` 零依赖服务(Node 内置 http/fetch,**部署无需 npm install**),`AUTH_TOKEN` 鉴权 / `GITHUB_TOKEN` 提限流 / `LLM_API_KEY` 可选增强(失败降级纯规则)/ `REFRESH_HOURS=24`。部署见 `tools/upstream-watch/DEPLOY.md`。**云端读 `upstream/ledger.json` 而非 TS 源**(云端 Node 20 跑不了 TS)——改台账后必须 `npm run ledger:export`,`upstream-contract.test.ts` 会断言两者逐字段一致,忘导出会 CI 变红。四种上游形态:github 有正文 5 家 / 退化 commit 2 家(codex release 正文全空、cursor 0 release)/ npm 1(kimicli)/ **闭源 4 家仅黑盒 + 手动粘贴入口**。白盒强信号用**短语级**(`rename table`/`database schema`)并带**否定句式**(`no known breaking changes`)——单词级曾致 4 家全误报,现已 0
- **看板已上线(2026-09-30)**:`https://watch.logic-yjb.top`(阿里云,子域名 + certbot HTTPS + nginx 注入 token header,pm2 常驻,每日抓一次)。部署坑记在 DEVLOG 顶部条,其中两条值得记:**①`pm2 --env` 传参会静默失败**(AUTH_TOKEN 没进进程,不带 token 也能访问=裸奔),改用环境变量前缀启动;②**验证必须同时看 `no-token:401` 和 `with-token:200`**,只看后者会以为配好了。运维速查:token 存 `~/.msql-watch-token`(600),改 token 后 `AUTH_TOKEN=$(cat ...) pm2 restart <name> --update-env` 再 `pm2 save`
- **黑盒探针(2026-09-30,第 3 期)**:`scripts/upstream-probe.mjs` 跑黑盒 → POST 云端 `/api/probe` → 写 `docs/upstream-reports/<日期>.md`。**刻意不直接写 memories 表**(应用数据目录,CLI 直写有并发风险),结论落 memories 仍由 agent 用 `memory_log_progress` 做。`upstream/check.ts` 已有 CLI 入口(`--json`,退出码 drift=1 / 检查器故障=2),**探针用子进程调它而非 import**,保持工具与生产代码解耦
- **新判定 checker_error(🟣)**:**检查器自身故障 ≠ 上游漂移**,必须分开——否则检查器的 bug 会伪装成上游问题,白白触发一次适配发版。解析器加载失败(`Cannot find module` 等)归此类
- **LLM 评估(2026-09-30,补做 + MiMo 适配)**:`evaluate.mjs` 的 `llmEnhance` 此前**从未实际跑过**(未配 key),是未验证交付。已补 14 个 mock 测试(全分支)+ `scripts/check-llm.mjs` 真调自检(**含 4 个 provider 预置:`mimo`/`openai`/`anthropic`/`deepseek`,`node scripts/check-llm.mjs mimo` 一键套用,key 只走 env 不落文件**)。**用户用小米 MiMo**,按官方文档核对后发现两处不兼容已修:①认证头 MiMo 要 `api-key`(非 `Authorization: Bearer`)—— 现非 Anthropic 端点**默认两个头都发**,另有 `LLM_AUTH_HEADER` 可显式指定 ②MiMo 用 `max_completion_tokens`,现两字段都发。⚠ **`mimo-v2.5-pro`/`v2.5` 将于 2026-10-21 下线**,用 `mimo-v2.6-flash`(用户选定,预置默认;可切 `-pro`);Token Plan 用户端点 `token-plan-cn.xiaomimimo.com`、key 前缀 `tp-`/`ttp-`。两条设计约束别改坏:①只对规则判 medium/high 调用 ②**只能加严不能放松**(LLM 说没事不会把 high 降级,但理由仍展示)
- **云端脚本不许 import `.ts`(踩过坑)**:`check-llm.mjs` 曾 import TS 台账,在服务器(Node 20.20.2)直接 `ERR_UNKNOWN_FILE_EXTENSION` —— Node 20 不支持 `--experimental-strip-types`(22.6+ 才有),**加 flag 也救不了**。现改读 `upstream/ledger.json`,纯 .mjs+.json 依赖。`upstream-probe.mjs` 仍需 Node ≥22.6(要执行 TS 检查器,只能本机跑),已加前置检查给中文提示
- **看板已完全跑通(2026-09-30)**:`https://watch.logic-yjb.top` 实测 `risk={low:1,medium:4,none:3,unknown:4}`(**与回归前基线完全一致**)+ **MiMo 真实应答 4 家、零错误**(hermes=HIT,qwencode/claudecode/gemini=clear)。运维用 `tools/upstream-watch/setup-watch.sh`(先验 token 再动手·活进程 env 快照·落盘 600+pm2 save·假 token 实测不碰 pm2);服务器 `~/.msql-watch-env` 是唯一配置真相源,`--verify/--show/--reset` 子命令齐全
- **403 不是一种错(踩过坑)**:`fetch.mjs` 过去把 403/429 全标成「限流」**并丢掉响应体**,导致 GitHub 的四种互斥情形(主限流 / 二级滥用 / **授权不足** / IP 级封禁)长得一模一样——一次 IP 级滥用检测被误读成"token 没配好",白排查一轮。现按 `x-ratelimit-remaining` + body 关键字分类、附 GitHub 原话,新增显式布尔 `rateLimited`(**只有它 true 才值得 retry,授权问题重试无用**)+ `test/watch-fetch.test.ts` 10 用例。另修 `?per_page=15&per_page=1` 重复键(GitHub 取第一个故一直没暴露,改取末值就会静默只剩 1 行 changelog)
- **macOS 打包已上线(2026-09-30,第三平台)**:`electron-builder.yml` 加 `mac:` 段 + CI package job 加 **macos-14(arm64)/ macos-13(x64)两个 runner**。**先验证过可行性再动手**:四个原生模块逐个查过 darwin 产物(better-sqlite3 `prebuilds/darwin-*` / onnxruntime `bin/napi-v3/darwin/*` / sqlite-vec 可选包 `sqlite-vec-darwin-*` / tokenizers 可选包 `tokenizers-darwin-universal`);`src/` 扫过**无写死 Windows 假设**(注册表已被 `platform!=='win32'` 守住、无 powershell/cmd、所用 Electron API 均跨平台)→ **不需要为 macOS 改业务代码**。**三个坑**:①`build/icon.png` 原本 256×256 而 .icns 自动转换要求 ≥512 → 已放大到 1024×1024(Bicubic + **只锐化 RGB 不动 alpha**,否则透明边缘出白边);②**dmg 之外必须有 zip**(zip 才是 updater 在 mac 的替换载荷)+ `latest-mac.yml`,缺了 mac 用户永远收不到更新**且无报错**;③未签名 → Gatekeeper 拦首启,已写进 README 顶部,转签名的 5 secret/3 配置在 RELEASE.md。**本地无法验证**(electron-builder 硬性要求在 macOS 构建),**唯一证明是 CI mac runner 变绿**
- **精确进度:见 `docs/DEVLOG.md` 最新一条(顶部);下一步:** winget 0.5.6 版 PR(msftbot 以 `outdatedSensitiveVersion` 退回 0.4.0 的 PR #426778,要求换当前版 + 公开隐私披露 + 把隐私政策 URL 写进 manifest;`PRIVACY.md` 已就位)→ 等 macos-13 runner 补 x64 产物 + 合并清单 → 探针配 Windows 计划任务 → 用户过目真实库截图 02-07 → 按 `docs/promo/checklist.md` 发宣传 → mcp.so 催收录
- **macOS 发版踩过的坑(必读)**:两个 CI job 各产出一份 `latest-mac.yml`,后传的覆盖先传的;electron-updater 读**这一份**再按架构过滤(`MacUpdater.filterFilesForArch`,`node_modules/electron-updater/out/MacUpdater.js:30`),**只剩 x64 条目时 arm64 Mac 会装上 Intel 版**(sqlite-vec/onnxruntime 按架构编译,换架构即损坏且不报错)。已写 `scripts/merge-mac-manifest.mjs`,合并后用**它自己的函数**校验两架构都能解析到 zip,单架构清单拒绝输出,版本不一致在写盘前抛错;`test/merge-mac-manifest.test.ts` 24 用例。**补 x64 时必须走合并,不能直接上传覆盖。**
- **`macos-13`(Intel)是最抢手的托管 runner,实测排队 95 分钟仍未分配**(`runner_name` 为空),与代码无关。`ci.yml` 已加 `concurrency`:main 推送自动取消被取代的 run(tag 单独分组且**永不取消**——发版构建不能被 main 推送连带取消)。**排查 mac 打包前先看这个,别当成构建失败。**
- **查 CI 产物别整包下载**:`gh run download` 几百 MB 会超时到看不出结果。改用 Range 请求读 zip 尾部中央目录列条目,再按偏移定点取小文件(本轮核对 mac 三件套就是这么做的,免了 374 MB)。本机到 `api.github.com` 链路不稳,`gh run list` 会 TLS 超时,改用 `fetch` + `gh auth token` 更稳
- **总体情况面板(2026-09-30)**:`buildBrief()` **纯函数算全部数字**,`summarize()` 把 brief 当唯一事实源喂 LLM 只写叙述 —— **数字由代码算、叙述由 LLM 写**,面板分两块显示,LLM 谎报时用户当场看得见(测试:喂它谎报"12 家全高风险",断言 brief 一字未变;且 prompt 里不含 changelog 原文)。`attention` 取三信号**并集**。`llm.mjs` 补上(方案规划过没做的),MiMo 兼容现只存一处。**实测 2/2 无影响·2/2 有影响·0 失败**
- **四个静默失败(部署时实测撞出,都是"失败要看起来像失败"家族)**:①**`running` 被写进 state.json → 服务永久锁死**(抓取途中被杀=每次部署都会发生;重启后 `runOnce` 判定"已在跑"直接 return,数据永远停在那刻;症状是 online+200+页面正常;实测复现:刷新 9ms 秒回旧数据;**写盘剔除+读盘强制 false 两侧防护**)②`/api/refresh` 撞上运行中抓取回 **200+旧数据**且前端忽略响应 → 改 409 ③**贪婪正则 `/\{[\s\S]*\}/` 抠 JSON** 遇两段 JSON/字符串含花括号即产出垃圾 → 改括号配平(跳字符串字面量)+`tool_calls` 兜底+带 `finish_reason`;**其错误信息立刻兑现:报出被 maxTokens 截断,重试即成功,根因 `maxTokens:300` 太小(MiMo 推理 token 就占 136)→ 提到 800/1200** ④闭源 agent 的"无公开更新日志"被算成**抓取失败**标红 → 过滤(这条**测试全绿,是截图暴露的**,测试覆盖不到"红标该不该红")
- **两条 GitHub 链路可靠性不同(别互相归因)**:服务器 `api.github.com` 稳定 0.36s(看板靠它),**`github.com`(git)间歇性连不上**——实测 `git pull` 卡 129s 超时、一次 fetch 重试 7 次才成;`git -c http.version=HTTP/1.1` 可绕开偶发的 `curl 16 HTTP2 framing layer`
- **看板 LLM 可视化(2026-09-30)**:`llmState()` 把 LLM 拆成**五态**(有影响/无影响/调用失败/**按设计未调用**/**未启用**)——后两者不占头部徽章但用虚线弱提示区分,「没配」和「跳过」含义完全不同;统计块未启用时整组隐藏防误读。**踩坑自留:改既有渲染函数必须整体验证**——曾把 `const ls` 写到使用点之后,TDZ 致 `card()` 抛 `ReferenceError`、整列表空白(空页面),而当时只测了新增的 `llmState`/`llmBlock` 没测 `card()`;正确姿势=整段脚本丢 `vm` 里跑 + mock `fetch`,**别用正则替换删多行箭头函数(会留残骸)**。**另一坑:`GITHUB_TOKEN` 不配会被 GitHub 匿名限流(60/小时),表现不是报错而是 11/12 家全变「无法评估」**+ 连带 LLM 因 `evaluate` 对 unknown 短路而永不调用
- **v0.5.5 装机验收已通过(2026-09-30)**:自动更新 0.5.4→0.5.5 **真实验收闭环**(`%LOCALAPPDATA%\memorysql-updater\pending\` 存有完整下载的 `MemorySQL-Setup-0.5.5.exe` 177,318,979 字节,与 `latest.yml` 声明 size 一致;11:42 重启 → 11:56 下载 → 11:57 落盘);OpenCode 2.x 捕获在装机版确认可用(#233 实时摄入);typecheck 0 / vitest **130:130**(当轮;补修连接向导后为 134:134)。**无代码增量**,`main` @ `4396ed6` 干净
- **两个已查清的操作坑(查历史会话前必读)**:①仓库内 `data/memory.db`(62MB)是**过期的开发副本**(id 只到 #221),真库在 `%APPDATA%\memorysql\data\memory.db`(95MB / 236 会话)——查会话一律走 MCP 或 `%APPDATA%`;②`sessions.started_at`/`ended_at` 存**秒**,`updated_at` 存**毫秒**,全链路刻意自洽(写侧各 parser `Math.floor(t/1000)`,读侧 `App.tsx:42 fmtTime` `new Date(ts*1000)`)——直查库按毫秒解读会全显示 1970,别误判成时间戳损坏
- 常用验证:`npm run import:scan`;`npx electron . --dispatch`;`npx electron . --sync <folder>`;`npx electron . --scan --export-archive <path>`;`npx electron . --reindex`(语义全量重建);运行中 `curl http://127.0.0.1:8642/health`
- 验收数据(本机真实存在):Codex `~/.codex/sessions/**/rollout-*.jsonl`;ZCode `~/.zcode/cli/db/db.sqlite`(权威库,rollout 仅剩 model-io 日志作 watcher 信号)+ `~/.zcode/cli/rollout/`;Hermes `<安装目录>\data\hermes-home\state.db`(**路径随注册表/盘符变动,2026-09-30 实测在本机 D 盘**;探测链见 `resolveHermesHome`,台账用 `{resolver:'hermes'}` 引用,勿硬编码)+ `memories/*.md`;Claude Desktop `%LOCALAPPDATA%\Claude-3p\claude-code-sessions\**\local_*.json`(仅元数据,无对话正文)+ `~/.claude/history.jsonl`;OpenCode `~/.local/share/opencode/opencode.db`(SQLite,storage/ JSON 树为旧版遗留);Qwen Code/Kimi CLI/CodeBuddy/WorkBuddy 本机未装(格式:qwen `~/.qwen/**/chats/*.jsonl`、kimi `~/.kimi/sessions/**/context.jsonl`、codebuddy `~/.codebuddy/projects/**/*.jsonl`、workbuddy `~/.workbuddy/projects/**/*.jsonl` + `workbuddy.db`),合成样本单测 + `MEMORYSQL_DATA_DIR` 隔离端到端覆盖;Gemini/Cursor 本机未装,合成样本单测覆盖
