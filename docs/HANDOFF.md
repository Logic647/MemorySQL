# MemorySQL 交接文档(快照:2026-09-17 · v0.5.1 发版后)

> 这是一份**时点快照**,供新会话/新接手者快速进入状态。长期维护的入口仍是 `AGENTS.md`(唯一入口)与 `docs/DEVLOG.md`(追加式日志);两者与本文冲突时以它们为准。

## 一、项目定位

本地优先的 Electron 桌面应用:存储个人记忆(人物画像)、AI agent 会话记录、开发过程,通过本地 MCP server 让任意 agent "连接即续接"。除 LLM API 外零服务器依赖。核心资产是 `data/memory.db`(SQLite+FTS5)、`data/vault/`(Obsidian 兼容笔记库)与 16 个能力插件。

## 二、发布与渠道现状(截至本快照)

| 事项 | 状态 |
|---|---|
| **最新版本** | v0.5.1(2026-09-17),main @ `41ef7c4`,工作树干净 |
| **Release 资产** | 7 项全平台齐:`Setup-0.5.1.exe`(169MB)+ blockmap + `latest.yml`;Linux 首发 `AppImage`(386MB)/ `deb`(275MB)/ `tar.gz`(377MB)+ `latest-linux.yml` |
| **CI** | 双矩阵全绿(windows+ubuntu × ci+package);`ci` 双平台跑 typecheck/97 单测/build,`package` 各自 `electron-rebuild` 后分平台打包上传 |
| **winget** | PR #426778(0.4.0 首收录)open,**Azure-Pipeline-Passed + Validation-Completed + New-Package**,卡在微软人工审查队列;合并后需提 0.5.1 版更新 PR |
| **scoop** | bucket 已上线(Logic647/scoop-bucket) |
| **MCP 目录** | mcp.so 已提交申请(2026-09-13,数日无动静可去催);PulseMCP 暂停收录;Smithery 形态不匹配暂缓 |
| **宣传物料** | `docs/promo/` 全套就绪;截图 6/8(01 演示库可公开,02-07 真实库**待用户过目**;05 图谱已放弃,08 待手动) |
| **自动更新链路** | 0.4.2 修复后已实战验收(静默下载→退出即装);0.5.1 含应用内更新状态显示 |

## 三、近期完成的工作(0.4.2 → 0.5.1)

1. **换机适配**(9b03013):Hermes/Codex 路径失效自动回退(注册表→盘符探测);Claude Desktop 捕获(桌面版 SDK 不落盘,收元数据+history.jsonl,三源合并);ingest 对自带标题/零消息会话跳过 LLM
2. **国内 agent 适配**(1950949):capture-qwencode / capture-kimicli / capture-codebuddy 三插件 + 连接向导支持;侧栏列表补全
3. **对话导入插件 import-chat**(4530c5a):粘贴/文件启发式还原会话——Trae CN(加密)、通义灵码(云端)、网页版聊天的通用正门;内容哈希幂等
4. **自动更新状态透出**(12d269d):updaterState + `memorysql:host:updateStatus` + 设置页 15s 轮询常驻显示
5. **Linux 跨平台**(75d4e8e):electron-builder linux 三 target + CI 矩阵 + Linux 保留系统标题栏(WCO 在 Linux 不可用)
6. **发版 x2**:v0.5.0(09-12)、v0.5.1(09-17),全部走"直推 + API 收尾"流程

## 四、系统能力现状

- **捕获矩阵(10 家)**:codex / zcode / hermes / claudecode(含 Claude Desktop 三源)/ qwencode / kimicli / codebuddy / gemini / cursor / opencode;另有 capture-watcher(登记式自定义,进 memories 表)与 import-chat(手动导入,进 sessions 表)
- **MCP 工具 7 个**:get_context(agent 过滤+交接摘要)、memory_list_sessions、memory_get_session(full)、memory_search(kind/agent/project/since)、memory_write(归因+tags/project)、memory_log_progress(收工汇报→候选记忆)、memory_get_project_brief
- **服务端点**:Streamable HTTP `http://127.0.0.1:8642/mcp`(被占顺延 8643,设置页可见实际端口);stdio 客户端用 `resources/mcp-bridge.mjs` 桥
- **语义检索**:fastembed bge-small-zh-v1.5 + sqlite-vec,水位增量同步,空闲 15min 释放模型
- **连接向导覆盖**:codex/zcode/claudecode/qwencode/kimicli/codebuddy/gemini/cursor/opencode/hermes 全部一键写配置

## 五、待办(按优先级)

**需要用户做的:**
1. 过目真实库截图(02-07)→ 按 `docs/promo/checklist.md` 发布(V2EX 周二~周四上午首发 → 掘金/即刻 → 少数派)
2. 验收 v0.5.1 自动更新链路(0.5.1 装好后,0.5.2 发布时应静默收取,设置页可见状态)

**接手 agent 可推进的:**
3. winget:盯 #426778 合并,合并后用 wingetcreate/API 提 0.5.1 版 PR(Version-Update,大概率 bot 自动合)
4. mcp.so 催收录;PulseMCP 重开后提交
5. ~~iFlow CLI 适配~~ **已作废**(2026-09-23:iFlow 于 2026-04-17 停服并迁 Qoder;Qoder/Qoder CN 适配已完成见 DEVLOG 顶部,未发版)
6. PTY tee 包装器(加密方案②,`msql-wrap`,node-pty;仅在用户高频使用加密 CLI agent 时值得)

## 六、遗留技术债(记录在案,非阻塞)

- 列表虚拟化(react-window);capture-* watcher 全目录 watch 与全文件重读;sync-folder 旧 bundle 累积;索引水位毫秒边界依赖 updated_at 单调
- capture-codex 是独立实现未并入 capture-factory(路径回退已单独修过)
- claudecode watcher 只盯 `~/.claude/projects`,Claude Desktop 新会话要等启动/手动扫描;history.jsonl 只有用户侧无回复
- 国内三家适配器(qwen/kimi/codebuddy)格式来自文档调研,本机未装,真机如有出入需补 fixture 校准

## 七、关键操作知识(接手必读)

**发版流程**(docs/RELEASE.md 为准):`npm version x.y.z` → commit → tag → `git push origin main vX.Y.Z` → 盯 CI 矩阵 → **删重复草稿**(main 推送的 package job 也会建草稿,与 tag 草稿重复)→ 齐全草稿 PATCH `draft:false` + notes → 验证 `releases/download/vX/latest.yml` 公网可达
**网络与工具**:git push 直连秒通(服务器 bundle 中转已退役);**无 gh CLI**,发版收尾全走 GitHub API,token 在 `~/.git-credentials`(credential store),curl 加 `-m 25 --ipv4` + 重试(网络间歇抖动,别因几次失败断定通道死了)
**隔离测试**:`MEMORYSQL_DATA_DIR=<临时目录>` 跑 headless 扫描/端到端,不污染真实库;国内三家本机未装,禁止在本机找真实数据验证
**常用命令**:`npm run import:scan`(补录+验收)/ `npm test` / `npm run typecheck` / `npm run dist` / `dist:linux`;运行中 `curl http://127.0.0.1:8642/health`
**真实验收数据(本机)**:Codex `~/.codex/sessions/**/rollout-*.jsonl`;ZCode `~/.zcode/cli/rollout/`;Hermes `G:\Hermes Agent CN Desktop\data\hermes-home\state.db`(0.7.0 根级布局);Claude Desktop `%LOCALAPPDATA%\Claude-3p\claude-code-sessions\**\local_*.json` + `~/.claude/history.jsonl`;数据库规模参考(09-12 扫描):claudecode 103 / codex 13 / hermes 44 / zcode 16 / memories 31

**Antigravity MCP 接入(本轮调研结论,repo 此前无记录)**:配置在 `~/.gemini/config/mcp_config.json`(Linux/Windows 同路径,二进制内嵌文档实锤);支持 stdio(`command/args`)与远程 `serverUrl`(标注 SSE 传输);MemorySQL 是 Streamable HTTP,`serverUrl` 直连可能不兼容,**推荐 stdio 桥方式**(`node /opt/MemorySQL/resources/mcp-bridge.mjs`,AppImage 挂载路径不稳定勿引用)

## 八、架构红线(勿违反)

一切功能皆插件;本地明文、出口必过 privacy-export;LLM 永远可降级回规则;不导入密钥文件(.env/config.yaml/credentials*);对 agent 数据只读;业务表带 updated_at/device_id/deleted(tombstone);里程碑必更新 DEVLOG + AGENTS.md
