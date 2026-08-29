# MemorySQL 开发日志(追加式)

> 规则:每完成一个里程碑/重要变更,在文件**顶部**新增一条(新在上);不删改历史条目。接手 agent:读最新一条即知当前进度与下一步。

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
