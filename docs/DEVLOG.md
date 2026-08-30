# MemorySQL 开发日志(追加式)

> 规则:每完成一个里程碑/重要变更,在文件**顶部**新增一条(新在上);不删改历史条目。接手 agent:读最新一条即知当前进度与下一步。

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
