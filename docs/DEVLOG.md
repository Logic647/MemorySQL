# MemorySQL 开发日志(追加式)

> 规则:每完成一个里程碑/重要变更,在文件**顶部**新增一条(新在上);不删改历史条目。接手 agent:读最新一条即知当前进度与下一步。

---

## 2026-08-31 · M5.2 外部测试修复 + 计划书细化到 M8

**背景:** Hermes agent 对 v0.2.0 做了全量功能测试(会话 #59):环境链路全绿(typecheck / vitest 36 / 构建 / 无头扫描 56 会话 / 归档 / sync / dispatch / stdio 桥 / 端口避让),但抓出 4 个 bug + 一批 MCP 调用断点。本轮全部修复,并按测试报告的后续开发建议把路线图细化到 M8。

**修复:**
- **P0 记忆/笔记进全文检索**:migrations v3 建 `memories_fts`(trigram)+ 存量回填 + 三个触发器(AI/AU/AD)自动同步索引——一次覆盖 ingest / memory-core / sync-folder 共 10 处写路径;`search.ts` 四路查询(memory + note,含 <3 字符 LIKE 回退;retired 记忆不入结果),`SearchHit.kind` 补 `note`(类型里预留的 `'memory'` 终于落地);UI 搜索结果标签补「记忆」「笔记」。注意坑:notes 表无 content 列(正文只在 notes_fts),LIKE 回退只搜标题
- **P1 Hermes 记忆 § 分段**:新 `capture-hermes/split.ts` 按行首 § 分段(单测覆盖);source 改内容寻址 `hermes:<rel>#<sha1前10>`——编辑→新行、重排→key 稳定、相同内容自然去重;导入后 tombstone legacy 整文件行与失效分段(文件是事实来源)。实库验证:旧 2 条巨型记忆 → 12 条分段(avg 209 字符 / max 757),legacy 清零,`memories_fts` 行数与活记忆严格一致
- **P2 版本号**:`handleRpc` 加可选 serverInfo 参数(默认值单测无感),mcp-server 传 `app.getVersion()`——package.json 成为单一事实来源
- **P2 headless**:`--scan` 用 `host.listChannels()` 过滤,只调用注册了 scanNow 的插件(capture-watcher 不再每次报 Unknown channel)
- **快赢**:`get_context` 会话列表带 `#id`,尾部提示补 `memory_get_session({id})`——切 agent 调用流从「4+ 次带猜测」迈向「2 次确定性」的第一步

**验证:** typecheck 零错 / vitest **48:48**(新增 search×6 + hermes-split×6)/ 构建 + `npm run import:scan` 真实数据冒烟(无 Unknown channel,分段导入正确)
**坑:** FTS5 特殊命令 `INSERT INTO ft(ft, rowid, ...) VALUES('delete', ...)` 在普通 fts5 表的触发器里报 "SQL logic error"(node -e 最小复现坐实),触发器改用 `DELETE FROM memories_fts WHERE rowid=?` + `INSERT…SELECT…WHERE new.deleted=0`

**计划书:** architecture.md §8 回填 M5/M5.2 + 新增 M6(MCP 工具矩阵 v2 全表 + 切 agent 调用流对照 + 交接简报 + 回流闭环 + 记忆治理)/ M7(sqlite-vec 本地语义检索 + 自动 DEVLOG + 托盘秒搜 + SQLCipher 可选)/ M8(打包 CI + demo + 发布渠道),全部详细条目。版本 0.2.1。
**下一步:** 按 M6 开工,建议顺序:MCP 工具矩阵 v2 → `memory_log_progress` 回流闭环 → 交接简报 `memory_get_project_brief` → 记忆治理

---

## 2026-08-30 · Hermes MCP 直连适配(连接向导第七家)

- 定位:Hermes Agent CN Desktop 是 **NousResearch/hermes-agent** 的打包发行版(本机 config.yaml 出现 hermes auth/Nous Portal/tirith 等特征),MCP 配置根键为 `mcp_servers:`(snake_case),原生支持 Streamable HTTP `url:` 与 `protocol: stateless`、`trust: untrusted`,改后 `/reload-mcp` 热加载
- 连接向导新增第七家:Hermes(定位活跃 profile 的 config.yaml:daily 优先 → mtime 兜底);YAML 无解析依赖文本手术(mcp_servers 已存在则插入条目,否则追加整块;memorysql 子块幂等替换),写前备份 `.bak-memorysql`
- **已实测写入本机** `profiles/daily/config.yaml`(PyYAML 结构校验通过:url/protocol/trust 三字段就位);Hermes 重启或 `/reload-mcp` 后即可用 memory_get_context 等四工具
- 顺带:stdio 桥修复退出竞态(process.exit 截断管道 stdout → 自然排空 + 30s 超时),Codex 类客户端关键路径

---

## 2026-08-30 · M5.1 追加:Cursor 格式校准 + 记忆批量确认 + P2 三修

- **Cursor 解析器按社区资料重写**(依据 cursor-chat-export 等项目与 vibe-replay 的存储分析):主存储 = globalStorage state.vscdb 的 `cursorDiskKV` —— `composerData:<id>` 只含 `fullConversationHeadersOnly` 头数组(type 1=用户/2=AI,定顺序),正文在 `bubbleId:<sessionId>:<bubbleId>` 行(text + toolFormerData 工具调用);旧 inline conversation 与 ItemTable chatdata 作回退。时间戳用 composer 的 lastUpdatedAt/createdAt,bubble 级无时间戳(与社区结论一致)
- **记忆批量确认**:memory-core 新 `confirmAll`(可按 agent/kind 收窄),记忆页按钮按当前筛选批量转 active
- **P2 三修**:MCP 端口避让只存运行时不覆盖用户配置;summarizer-llm setConfig 全字段字符串类型校验(provider 白名单、掩码 key 不覆盖);.msqlv 导入要求 manifest 必须存在
- 验证:typecheck 零错 / vitest 36:36 / 构建 3 产物
- Cursor 适配仍标 EXPERIMENTAL:本机未装,格式以 2025 社区资料为准,装 Cursor 后跑一次扫描即可校准

---

## 2026-08-30 · M5 全量增强:11 项需求 + 液态玻璃重设计 + 审查修复

**审计修复(代码审查代理二轮):**P0×1(宿主 IPC 通道与 preload 桥路径脱节,设置页宿主功能全不可用 → 单 payload + `memorysql:host:` 前缀分流)、P1×5(claude startedAt 恒等 ended_at;gemini externalId 跨项目同名覆盖 → home 相对路径命名空间;refine 复用 300 token 截断 → maxTokens 参数化 2000;MCP 端点无 Origin/Host 校验 → rebinding/CSRF 防护 + 10MB body 上限;外部插件 init/start 异常炸启动 → 逐插件隔离)。P2 修了 8 项(tombstone 不复活、refine 按行退役+产物仍 candidate、skipped 重置、core-schema 解除 rules 依赖、--scan 遍历全部 capture-*、main 路径逃逸防护、空路径守卫、sqlite-ro 泄漏)。

**新能力:**
- **会话 ID**:列表徽标 + 详情一键复制 + MCP `memory_get_session(id, tail?)`
- **Agent 矩阵**:新增 Claude Code / Gemini CLI / Cursor(实验)/ OpenCode+Copilot CLI 四适配器(capture-factory 统一骨架,未安装优雅降级);`AgentType` 放宽支持自定义;设置页逐 agent 开关(重启生效)+ 数据路径修改;宿主级联禁用
- **自定义 agent 登记**:capture-watcher 改登记式(agent 名 + 目录 + 文件模式),命中只读导入
- **记忆体系**:memories 加 agent_type(迁移 v2);规则提炼引擎(偏好/决策句、极简风格 persona → candidate 待确认,每会话 ≤3 条);记忆页 agent 筛选 chips;LLM 精炼按钮(产物仍 candidate 待确认)
- **存储位置**:设置中迁移整库(快照+复制+标记+重启切换,可恢复默认)
- **MCP 端口**:设置可改 + EADDRINUSE 自动顺延(≤10 次)+ Origin/Host 校验
- **LLM 模型列表**:三家 /models 拉取,模型输入框带 datalist
- **外部插件**:`<数据目录>/plugins/<id>/{manifest.json, main.js}`,new Function CJS 加载(对 ESM 应用 scope 免疫,可 require electron),单插件失败只记录不炸启动;设置页启停管理;README + docs/plugins.md 规范
- **备份含 settings.json**(导入一并恢复,旧配置轮转保留)

**UI 重设计(用户指定的三 skill 链:ui-ux-pro-max → design-taste-frontend → impeccable):**
- 「蓝黑精密仪器 × 液态玻璃」:环境光场(双色 radial)+ 玻璃面板(blur 18px saturate 160% + 顶部 1px 高光 + 内描边),石板蓝 token(#0F172A 系),单一薄荷绿强调(#34D399),JetBrains Mono 元数据,10px 圆角锁定,15-200ms 克制动效;reduced-motion / reduced-transparency 回退
- 元数据行去 emoji 改 mono 文案;图谱节点配色同步;CodeMirror 主题同步;图标重绘为液态玻璃菱形(多层半透明 + 高光刻面)
- 实测截图验收(列表卡片脊线/ID 徽标/玻璃质感全部呈现)

**验证:**typecheck 零错 / vitest 36:36(新增四适配器解析器 6 测)/ 构建 3 产物 / 7 适配器无头扫描优雅降级 / 外部插件 hello 实测加载且 MCP tools/list 暴露 hello_greet(5 工具)/ GUI 实测
**遗留(审查 P2 已记录未修):**端口避让结果不持久化语义、setConfig 类型校验、sync-archive manifest 严格化、外部插件产物确认 UI 清单化

**下一步候选:**GitHub 推送与 Release(安装包产物)、记忆页候选确认流优化、capture-cursor 实机格式校准(装 Cursor 后)

---

## 2026-08-30 · 打包分发(electron-builder → Windows 安装包)

**产物:**
- `dist/MemorySQL-Setup-0.1.0.exe`(NSIS 安装包,115MB,可选安装目录 + 桌面快捷方式)
- `dist/win-unpacked/`(免安装目录,396MB,直接运行 MemorySQL.exe)
- 应用图标:琥珀菱形 × 石墨圆角方(tape-archive 设计语言),PIL 生成 `build/icon.ico|png`

**配置要点(electron-builder.yml):**
- `files`: 只打 `out/**` + package.json;**渲染层依赖全部移到 devDependencies**(react/codemirror/cytoscape 已被 vite 打进 bundle),生产依赖只剩主进程三件套(adm-zip / better-sqlite3 / chokidar)
- `asarUnpack: better-sqlite3`(原生模块不能从 asar 加载);`npmRebuild: false`(node_modules 里已是 electron ABI,避免构建期再下载工具链)
- `extraResources`: scripts/mcp-bridge.mjs → 安装后 `resources/mcp-bridge.mjs`(agent stdio 配置指向它)
- 数据目录:打包版走 `%APPDATA%/MemorySQL/data/`(env.ts 的 isPackaged 分支),与开发版隔离
- **构建镜像(国内必配)**:`ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`(NSIS/7zip 工具链),连同 `ELECTRON_MIRROR` 一起 export 后再 `npm run dist`

**验证:**免安装版 `MemorySQL.exe --scan` 无头跑通(61 会话写入正确的打包数据目录);GUI 启动正常,五视图可用(记忆视图已由用户实测点开使用)

**命令:**`npm run dist`(先 electron-vite build 再 electron-builder --win)

---

## 2026-08-29 · M4 知识库完全体完成 —— 四个里程碑全部落地

**core-vault(笔记系统):**
- 迁移 v2:`notes` 表 + `notes_fts`(trigram);**.md 文件为事实来源**,db 只做索引
- 解析器(纯函数,单测):`[[链接#锚|别名]]`、内联 #标签(CJK 支持,过滤十六进制色/纯数字伪标签)、frontmatter `tags:`、标题取首个 H1
- vault 全量扫描 + chokidar 增量监听(新建/修改/删除→tombstone)
- IPC:notes:list/get/save/create/delete/search/backlinks/graph(反链按链接标题解析;图数据只保留解析到的边)

**UI:**
- 笔记视图:CodeMirror 6(markdown 语法、行包裹、暗色 tape 主题、Ctrl+S 保存、外部更新标注防误报 dirty)+ 笔记列表 + 标签条 + 反向链接面板
- 图谱视图:cytoscape(cose 布局,琥珀节点/暗边,节点点击显示标题)
- 视图导航扩为五项:会话 / 记忆 / 笔记 / 图谱 / 设置

**capture-watcher(项目文件监听):**
- 设置页添加/移除监听目录;只读导入 AGENTS.md / CLAUDE.md / MEMORY.md 为记忆(source=`project:<path>`);变更增量导入

**插件 API 文档化:**
- `docs/plugins.md`:插件解剖、生命周期、PluginContext 全能力表、内置插件清单、约定(铁律映射)、最小 Hello 插件示例

**验证:**typecheck 零错 / vitest 27:27(新增 note-parser 5)/ 构建 3 产物 / `--dispatch` 启动实跑:5 篇笔记索引正确(双链/标签/FTS 中文检索全对)/ GUI 全 14 插件启动正常(watcher×3 + vault + MCP)
**遗留:**笔记/图谱视图的自动化点击走查同 M3 受帧绑定限制未截图(编译与 IPC 层已验),待人工点开;图谱布局参数(边长/斥力)可再调

**项目状态:规划的全部里程碑(M0–M4)已完成。**后续方向(未排期):打包分发(electron-builder)、外部社区插件目录加载、FTS external-content 省存储、会话时间线可视化增强、sync-folder 删除传播(tombstone 已预留)。

---

## 2026-08-29 · M3 记忆与同步完成

**summarizer-llm(可选 LLM 摘要):**
- provider 三模板:OpenAI 兼容 / Anthropic / Ollama;设置页切换;API Key 存 settings.json(本机明文,MVP 取舍);**注册在 rules 之前**,host 取第一个 available —— 配置了 LLM 用 LLM,没配/挂了自动落回本地规则
- 摘要器接口异步化:`SummarizerProvider.summarize` 可返回 Promise;摄取管道重构为**摘要全部在事务外执行**(LLM 调用绝不持有 SQLite 写锁),三个捕获插件的 scan 改 async、watcher 回调 fire-and-forget
- 解析容错:严格 JSON → ```json 围栏 → 行启发式,三级 fallback(单测覆盖)

**memory-core + memory-dispatch:**
- 记忆 CRUD IPC:save(增/改)/ delete(tombstone)/ setStatus(candidate|active|retired)
- 记忆视图:按 画像/偏好/事实/决策 分组,新增/编辑/停用/删除;「生成分发文件」按钮
- 记忆分发 `--dispatch`(也可 UI 触发):生成 `vault/dispatch/MEMORY.md`(画像+记忆汇编)与 `AGENTS-snippet.md`(粘贴进项目 AGENTS.md/CLAUDE.md 用的 `<memorysql_context>` 片段);**不直接改写 Hermes/Codex 的活记忆文件**(避免覆盖它们自己维护的内容),实测生成正确

**sync-folder(增量同步,零服务器):**
- 通过网盘同步文件夹(OneDrive/坚果云…):push 写 `<folder>/memorysql-sync/<deviceId>/bundle-<ts>.json`,pull 合并其他设备未导入过的 bundle(文件台账 cap 300)
- 合并语义(自然键,**跨设备 id 永不冲突**):projects 按 path、sessions 按 (agent_type, external_id)(消息随会话,FTS 同步重建)、memories 按 content 并集;冲突 LWW on updated_at;**删除不传播**(MVP 限制,整库迁移走归档)
- 真实 deviceId(随机生成,登记 devices 表);`MEMORYSQL_DATA_DIR` 环境变量支持多数据目录;headless `--sync <folder>`(可与 --scan 组合)
- **双设备往返实测**:A(55 会话/5 记忆)⇄ B(新建目录扫同样来源 + 注入独有记忆)——B 收到 A 的 MCP 记忆、A 收到 B 的独有记忆,两边收敛为 55 会话/6 记忆 ✓
- 插曲:验收断言一度"失败",实为更早 curl(GBK)写入的乱码残留记忆,数据清理后确认无碍(教训已在 M2 记录:测试中文一律走 python 客户端)

**UI:**侧栏新增 视图 导航(会话/记忆/设置);设置页 = 摘要引擎表单(含"留空保持不变"的 key 掩码)+ 同步文件夹配置与立即同步

**验证:**typecheck 零错 / vitest 22:22(新增 llm 解析+transcript 5)/ 构建 3 产物 / 双设备同步往返实测 / dispatch 文件实测 / 窗口实测
**未竟:**记忆/设置视图的点击走查因自动化帧绑定限制未完成(构建与数据层已验),待人工点开确认;LLM 真实调用需配 Key 后人工验证

**下一步(M4 知识库完全体):**CodeMirror 6 笔记编辑 + 双链/反链 + 图谱(Cytoscape.js);capture-watcher 项目文件监听(AGENTS.md/MEMORY.md 双向同步,与 dispatch 打通);插件 API 文档化(第三方插件)

---

## 2026-08-29 · M2 服务层完成:MCP server + 出口脱敏 + 归档迁移

**mcp-server 插件:**
- 手写 MCP JSON-RPC 2.0(`src/main/core/mcp-protocol.ts`,纯函数可单测):initialize / tools/list / tools/call / ping,无状态 Streamable HTTP 子集,**只绑 127.0.0.1**,端口默认 8642(设置 `mcp-server:port`)
- stdio 桥:`scripts/mcp-bridge.mjs`(agent 只支持 stdio 时用,`env MEMORYSQL_MCP_PORT`);Codex 配置示例见脚本头注释
- 三个工具由 core-schema 注册(经宿主 `ctx.mcp` 注册表,mcp-server 只负责服务):
  - `memory_get_context(project?)` — **续接包**:画像 + 长期记忆 12 条 + 项目状态 + 最近 5 会话
  - `memory_search(query, limit)` — trigram 中文全文检索
  - `memory_write(kind, content)` — 逐条插入(新增 `MemoriesService.addMemory`,与文件型 upsert-by-source 分离)
- 插件间调用新通道:`ctx.ipc.call(channel, payload)`(privacy-export 复用 core-schema:sessions:get)
- 工具名规范:MCP 名只允许 `[a-zA-Z0-9_-]`,宿主存 `插件id.名` 作内部 key、对外暴露原始名并查重

**privacy-export 插件(唯一脱敏出口):**
- `src/main/core/redact.ts`:PEM 私钥/sk-/AKIA/ghp_/xox/JWT/`password=`类/URL user:pass 八类规则,`redactWithCount` 返回命中数
- IPC `privacy-export:exportSession {sessionId}` → 组装 MD(头部元信息 + 摘要 + 时间线)→ 保存对话框 → 落盘;实测 RustDesk 会话导出正确遮蔽 `password='…'`

**sync-archive 插件(.msqlv 迁移):**
- 导出:`VACUUM INTO` 一致性快照 + vault 打 zip(manifest.json + memory.db + vault/**);UI 按钮 + headless `--export-archive <path>`
- 导入:校验(manifest + 空库开包验核心表)→ 暂存 `data/.import-staging` + 标记 `.import-pending.json` → `app.relaunch()` → **下次启动 bootstrap 前换库**(旧库轮转 `.pre-import-<ts>`,staging 清理),实测换库往返成功
- settings.json 不进归档(机器路径各异,首次启动用默认值)

**UI:**侧栏知识库区新增 导出备份/导入备份 按钮 + MCP 状态行(端口/工具数);会话详情新增「导出 MD(脱敏)」

**验收记录:**typecheck 零错 / vitest 17:17(新增 redact 6 + mcp-protocol 7)/ curl+python 客户端实测 initialize、tools/list、三工具(中文检索、写入回读)/ 无头导出 8.6MB 归档校验通过 / 启动导入换库实测 / 窗口实测新 UI 正常
**坑:**Git Bash 里 curl -d 发中文会变 GBK 乱码(测试端问题),用 python urllib 保证 UTF-8

**下一步(M3 记忆与同步):**memory-core 画像视图;summarizer-llm(设置页切换 + 配置模板 + 离线降级);记忆分发(反向生成 Hermes MEMORY.md / Codex AGENTS.md);sync-folder(同步文件夹增量双向,行级 LWW + tombstone,字段早已预留)

---

## 2026-08-29 · UI 重设计(tape-archive)+ 全量代码审查修复

**流程:**按用户要求,UI 动手前调用 frontend-design 技能;代码健康由 general-purpose 审查代理出具报告(P0×0 / P1×5 / P2×9)。

**UI 重设计("磁带档案室"):**
- 设计系统重写 `styles.css`:石墨蓝底(#14171C)+ 琥珀签名色(#E2A93E,仅用于品牌/扫描按钮/选中态/详情头虚线条带);等宽字体承载全部元数据(会话号、计数、时间戳、眉头标签)
- 签名元素①:会话列表项 = 档案索引卡,左侧 2px agent 色脊线(codex 紫 / zcode 蓝 / hermes 粉)
- 签名元素②:消息时间线 = 连续走带线 + 角色节点圆点;详情头 = 磁带标签(external_id chip + 琥珀虚线条带)
- 质量底线:focus-visible 琥珀描边、prefers-reduced-motion、subtle 滚动条

**截图验收时抓到并修复的真 bug:**`sessions:list` 返回 snake_case 而渲染层读 camelCase → badge/时间/计数全空、脊线失效。SQL 加别名修复。(此 bug 正是审查报告 P2"IPC 边界裸断言无校验"的实例。)

**审查修复(5×P1 全修):**
1. `sessions:get` 的 `tool_name` 未别名 → 工具名永远显示 "tool";已加 `"toolName"` 别名
2. 搜索的 session 命中缺 `sessionId` → 点击无响应;已补
3. Hermes 多 profile 同 id 会话互相覆盖(静默数据丢失)→ externalId 加 `profiles/<name>/` 命名空间
4. Hermes 锁库快照泄漏 %TEMP% 临时目录 → cleanup 里 rmSync;结构重构为 openHermesDb 返回 {db, cleanup}
5. `sandbox: false` 无必要 → preload 改 CJS 输出(`index.cjs`),恢复 `sandbox: true`,已实测窗口+IPC 正常

**顺带修的 P2:**GUI 退出优雅关闭(stopAll + db.close);content_hash 改为对截断后内容计算(>100KB 消息会话不再每轮重扫重写);settings.json 原子写(temp + rename)

**遗留备忘(P2,进 M2/后续处理):**IPC 边界运行时校验(zod);全量重扫 mtime+size 短路;FTS 改 external-content 表省体积;ZCode 连续去重丢真实重复消息;Codex 续写文件 last-write-wins(仅告警未合并);settings.get 类型防护

**验收:**typecheck 零错 / vitest 4:4 / 重建后全量重扫 55 会话 2374 消息(Hermes id 已带命名空间)/ 应用窗口实测正常。工作区未提交变更随后提交 git。

---

## 2026-08-29 · M0+M1 完成并真实数据验收通过

**完成:**
- 插件宿主:manifest.requires 拓扑排序启动;PluginContext 六能力(db.migrate / ipc / mcp 注册表 / watcher / summarizer / services 服务定位器);IPC 通道名 = `<pluginId>:<name>`
- 5 个内置插件:summarizer-rules、core-schema(schema v1 + 摄取管道 + trigram FTS5)、capture-codex、capture-zcode、capture-hermes
- 渲染层:三栏 UI(会话列表 / 消息时间线 / 侧栏过滤与捕获状态),全文搜索入口,「立即扫描」
- **真实数据验收(本机)**:Codex 17 个 rollout → 11 会话(6 个为同会话续写文件,按 content_hash 更新合并);ZCode 2;Hermes 41(多 profile state.db 汇总,只读打开+锁降级拷贝);4 份记忆文件(MEMORY.md/USER.md×2 profile);共 54 会话 / 2230 消息;中文 FTS(trigram)检索验证通过
- 质量修正:摘要器剥离各家 boilerplate(`<app-context>`/`<environment_context>`/`[Hermes UI Workspace]`/`[System:…]`/Hermes 恢复占位/Codex 历史评估 prompt),标题质量问题清零;无有效用户消息时回退 assistant 文本
- 单测 4/4(两个解析器,合成样本);`npx tsc --noEmit` 零错误;应用窗口实测渲染正常(列表/详情/侧栏)

**踩坑记录:**
- Electron 二进制下载需镜像:`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js`(GitHub release 直连失败,与 Hermes 记忆一致)
- vite 版本:electron-vite@5 需 vite@7 + @vitejs/plugin-react@5(plugin-react@6 要 vite8 会 ERESOLVE)
- preload 产物是 `index.mjs`,main 里 preload 路径要写 .mjs
- better-sqlite3 需 `npx electron-rebuild -f -w better-sqlite3` 切 electron ABI;切完后 vitest(node ABI)不能再用 better-sqlite3,需要重装依赖恢复
- `npx electron . --scan` 前必须先 `npm run build`,否则跑的是旧产物

**下一步(M2 服务层):**
1. mcp-server 插件:stdio + `memory_get_context` / `memory_search` / `memory_write`(宿主 mcpTools 注册表已就绪)
2. privacy-export 插件:导出 MD/分享摘要的出口脱敏(密钥正则扫描)
3. sync-archive:.msqlv 归档导出/导入(数据目录 = `data/`(memory.db + vault/ + settings.json),已自包含)
4. UI 小修:捕获状态面板在应用启动时显示库内累计数而非本次扫描数

---

## 2026-08-29 · 项目启动,决策定稿,M0 开始

**完成:**
- 需求澄清完毕,全部关键决策经用户确认(见 `architecture.md` §7 D1–D10)
- 开发文档体系建立:AGENTS.md(入口)+ architecture.md(架构与决策)+ 本日志
- 决策要点:Electron+TS+React;笔记 MD / 记忆会话 SQLite(FTS5);插件系统一步到位;脱敏仅出口;默认规则处理 LLM 可选;三适配器(Codex/ZCode/Hermes)真实数据验收;归档+增量同步迁移

**下一步(M0):**
1. electron-vite 脚手架 + better-sqlite3(electron-rebuild)
2. 插件宿主(PluginContext 五能力:db/ipc/mcp/watcher/summarizer + events/settings)
3. DB schema migration 机制 + FTS5

**再下一步(M1):**capture-codex → capture-zcode → capture-hermes → 摄取管道(summarizer-rules + 实体抽取)→ 极简 UI → 真实数据验收(Codex 17 会话 / ZCode rollout / Hermes state.db)

**环境备注:**Node 24.18 + npm 11.16(无 pnpm);Python 3.12(可用来检查 Hermes SQLite);Hermes 数据根 `D:\Hermes Agent CN Desktop\data\hermes-home\profiles\daily\`
