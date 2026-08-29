# MemorySQL 开发日志(追加式)

> 规则:每完成一个里程碑/重要变更,在文件**顶部**新增一条(新在上);不删改历史条目。接手 agent:读最新一条即知当前进度与下一步。

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
