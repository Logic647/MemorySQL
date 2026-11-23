# MemorySQL 全功能测试报告

- 测试对象:`MemorySQL` v0.7.8(HEAD `01d04e3`,工作树含未提交的官网/截图/巡检报告改动)
- 测试时间:2026-11-23
- 测试方式:静态基线 + 隔离数据目录的 headless 全链路 + CDP 驱动 GUI 真实交互 + MCP 端点协议级调用
- 结论:**核心读写链路可用,发现 1 个 P1 隐私缺陷、4 个 P2 缺陷、若干 P3 问题**;打包版与语义检索未能端到端验证

---

## 一、结论摘要

| 维度 | 结果 |
|---|---|
| 静态基线(typecheck / vitest / build) | 全绿:0 错 / 702 通过(2 skip) / 构建成功 |
| 捕获与入库(8 家本机 agent) | 通过:465 会话、71912 消息全部落库,时间戳零异常 |
| 增量扫描 | 通过:首轮 16.4s → 二轮 2.8s(水位生效) |
| 检索(FTS + LIKE 回退) | 通过:英文/中文 3 字走 trigram,2 字走 LIKE |
| MCP 端点(7–8 工具) | 通过:initialize/instructions/工具矩阵/错误路径均正常 |
| 记忆(scope/锁定/编辑/停用/删除) | 通过,但同内容重复写入未被拒绝 |
| 项目总结(digest) | 通过:32 个项目 rules 引擎全成功 |
| 同步 / 备份 / 归档 | 通过:同步门禁、push/pull、归档导出导入与重启切换均正确 |
| 语义检索 | **失败**(上游模型源 403 + 坏缓存毒化) |
| GUI(列表/详情/搜索/记忆/设置/主题) | 通过,项目总结弹窗有「永久加载中」缺陷 |
| 隐私(演示库/导出脱敏) | **演示库泄露真实会话(P1)**;导出脱敏计数正常 |

---

## 二、测试环境与方法

| 项 | 值 |
|---|---|
| 平台 | Windows 10/11 x64,Node v24.15.0,Electron 44.0.0 |
| 真实库 | `%APPDATA%\memorysql\data\memory.db`(**322 MB**,装机版实例运行中,全程未触碰) |
| 隔离库 A(真实数据) | `%TEMP%\msql-verify\data`(headless,`MEMORYSQL_DATA_DIR` 覆盖) |
| 隔离库 B(演示数据) | `%TEMP%\msql-gui\data`(`scripts/seed-demo.ts` 生成) |
| GUI 驱动 | `electron . --remote-debugging-port=9223 --user-data-dir=…`,CDP `Runtime.evaluate` 调 `window.memorysql.invoke(channel, payload)` |
| MCP 驱动 | 隔离实例独立端口 `127.0.0.1:8645/mcp`(8642 被装机版占用,顺延逻辑实测有效) |
| 隔离原则 | 不写真实库、不改真实 agent 配置、跑完即关闭测试实例(装机版 4 进程未受影响) |

---

## 三、静态基线

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 0 错误 |
| `npm test` | **702 通过 / 2 跳过**(65 个测试文件:64 通过 + 1 跳过) |
| `npm run build` | 成功:`out/main/index.js` 483.82 kB、`out/preload/index.cjs` 0.71 kB、renderer JS 296.94 kB + CSS 38.74 kB |
| `npm run upstream:check` | 🟢 7 正常 · 🔴 0 漂移 · 🟣 0 检查器故障 · 🟡⚪ 17 未验证(本机未装) |

跳过的 2 条是 `test/real-db-check.test.ts`,需 `MEMORYSQL_REAL_DB` 指向真实库副本,属设计内跳过。

---

## 四、捕获与入库(headless,隔离库 A)

一次进程执行 `--scan --dispatch --devlog --sync --export-archive`,**exit 0,耗时 16.4 秒**。

### 4.1 捕获矩阵(24 家中 8 家检测到源)

| 插件 | 源 | 发现 | 入库 | 健康 |
|---|---|---|---|---|
| capture-codex | `~/.codex/sessions` | 1 | 1 | healthy |
| capture-zcode | `~/.zcode/cli/db/db.sqlite` | 100 | 100 | healthy |
| capture-hermes | `G:\Hermes Agent CN Desktop\data\hermes-home` | 8 | 8 | healthy |
| capture-claudecode | `~/.claude/projects` | 109 | 109 | healthy |
| capture-gemini | `~/.gemini` | 0 | 0 | healthy |
| capture-opencode | `~/.local/share/opencode` | 22 | 22 | healthy |
| capture-dsh | `~/.dsh/sessions` | 1 | 1 | healthy |
| capture-mimocode | `~/.local/share/mimocode` | 224 | 224 | healthy |

其余 16 家(qwencode/kimicli/codebuddy/workbuddy/qoder/cursor/goose/droid/cline/pi/omp/omo/grok/minimax/deveco/copilot)按「未检测到源 → 默认关闭」跳过,**日志逐条注明原因**,符合 v0.7.5 的默认关闭策略。所有插件 `lastError=null`、`consecutiveFailures=0`。

### 4.2 入库结果与数据一致性(直接查库断言)

| 指标 | 实测 | 判定 |
|---|---|---|
| 会话 | 465(其中子代理 127,均带 `parent_session_id`) | 正常 |
| 消息 | 71 912 | 与 `messages_fts` 行数**完全一致** |
| 项目 | 32 | 见缺陷 P2-5(路径分隔符分裂) |
| 记忆 | 43(全部 `scope=project`,来自 hermes 记忆导入) | 正常 |
| `last_message_at IS NULL` | 0 | 正常 |
| `last_message_at = 0` | 0 | **「0 视为无效」回填生效** |
| `started_at` 无效 | 0 | 正常 |
| `ended_at = 0` | 0 | 正常 |
| schema 迁移 | 13 条(最高 v9) | 正常 |

### 4.3 增量与幂等

- 第二次运行(已推进水位):**2.8 秒**(首次 16.4 秒),`sessionsImported` 归 0 或仅新增 1 条(测试期间本机新写入的会话),说明「时间水位 + `hashSession` 未变则复用」生效。
- FTS 检索:英文 `MemorySQL` 命中 11 958 条;中文 3 字 `项目总结` 331 条;中文 2 字 `项目` 在 FTS 层 0 条但**搜索层 LIKE 回退**返回结果(见 P3-6)。

### 4.4 生成物

| 功能 | 结果 |
|---|---|
| 项目日志 `--devlog` | 32 个 Markdown 写入 `vault/devlog/` |
| 记忆分发 `--dispatch` | `vault/dispatch/MEMORY.md` + `AGENTS-snippet.md` |
| 归档导出 `--export-archive` | 104 MB `.msqlv`,exit 0 |
| 目录同步 `--sync` | 未确认明文时被**正确拒绝**(见 4.5) |
| 项目总结 `--digest` | 32 个项目全部 `ok`,rules 引擎,共 38 条 digest / 覆盖 326 会话 |

### 4.5 同步(隔离库 A / B 各测一次)

- **明文门禁生效**:未勾选「云同步不做脱敏」时 `syncNow` 抛「云同步明文未确认…」,不写任何文件 —— 符合铁律 2。
- 勾选后:隔离库 A push 62 MB bundle 至 `memorysql-sync/<deviceId>/`,隔离库 B push 13 MB。
- **pull 方向**(伪造第二台设备):`filesPulled: 1`、`sessionsAdded: 0`(已存在 → 幂等);追加一条新记忆后 `memoriesAdded: 1` 成功合入。
- **限制**:改用同一会话的新标题 + 更新 `updated_at` 后,`sessionsUpdated: 0`,库内没有出现新标题 —— 同步只做内容级合并,**不同步标题/元数据变更**(P3-12)。

---

## 五、MCP 端点与工具矩阵

`initialize` 返回 `serverInfo{name:memorysql,version:0.7.8}` 与 **852 字符的 instructions**(含「任何新任务第一步调用 memory_get_context」),协议版本协商正常,SSE/JSON 两种响应均能解析。

| 工具 | 调用 | 结果 |
|---|---|---|
| `memory_get_context` | `{project:'nebula-notes'}` | ✅ 1523 字符续接包(全局画像/偏好 → 项目记忆 → 最近会话) |
| `memory_get_project_brief` | 同上 | ✅ 2126 字符交接简报 |
| `memory_list_sessions` | `{project,limit}` | ✅ 带 id/agent/起止/最后时间/消息数 |
| `memory_get_session` | 缺 id | ✅ 明确报「参数错误:需要数字 id」 |
| `memory_search` | `{query:'SQLite'}` | ✅ 命中;传错参数名(`q`)时返回「未找到」而非参数错误(P3-8) |
| `memory_write` | 全局 fact | ✅ 返回 `已写入记忆 #39` |
| `memory_log_progress` | done/next/blocked | ✅ 落候选记忆并说明后续流转 |
| `memory_get_project_digest` | — | ⚠️ 本次实例**未注册**(演示库禁用了 `project-digest` 插件);真实库实例 8 工具可用 |

未知工具返回 `-32602 Unknown tool`,`memorysql:status` 报 `toolCount` 与实际注册数一致;端口 8642 被占用时**自动顺延 8643/8645 并在日志与侧栏提示**,降级行为正确。

---

## 六、GUI 功能(CDP 驱动,隔离库 B)

首次加载即暴露插件注册面:**38 个 IPC channel**,覆盖会话/搜索/记忆/捕获/导出/同步/日志/语义/LLM 配置。

| 功能 | 验证点 | 结果 |
|---|---|---|
| 会话列表 | 默认 163 条、按 `last_message_at` 倒序、子代理不占位 | ✅ 排序断言全通过;`includeSubagents` 后 238 条(75 个子代理) |
| 分页 | `limit/offset` 两页 | ✅ 零重叠 |
| Agent 过滤 | mimocode | ✅ 151 条全为 mimocode |
| 子代理折叠 | 父会话 `subagentCount` vs 实际拉取 | ✅ 一致(1 vs 1);UI 显示「↳ 70 个子代理会话 — 展开」 |
| 会话详情 | 消息时间线 + 系统注入降权 | ✅ 144 条消息,噪声消息渲染为「user · **系统注入**」 |
| 全文搜索 | 英文 / 中文 3 字 / 中文 2 字 / 空查询 | ✅ 20 / 6–11(三类召回) / 10(LIKE) / 0 |
| 统计口径 | `stats:overview` vs 列表总数 | ✅ 163 = 163(v0.7.2 的五处口径一致性保持) |
| 记忆页 | 34→35 条、scope 分组(全局 23 / 项目 12)、项目筛选器、来源标签 | ✅ 与 SQL 一致;分页零重叠 |
| 记忆写入 | 新增、编辑(默认锁定)、解锁、停用(`retired`)、删除 | ✅ 全通过;缺 project / 非法 kind 均报错 |
| 记忆重复 | 同内容连续写两次 | ❌ 生成两条(id 35/36),见 P3-7 |
| 分发 / 项目日志 | `generate` | ✅ 2 文件 / 19 文件 |
| 归档导出 | 写指定路径 | ✅ 19 MB |
| 归档导入 | 合法包 | ✅ staging + 校验 + **自动留 `.pre-import-*` 备份** + 重启切换 + marker 消费;导入后 238 会话/35 记忆一致 |
| 归档导入 | 非法文件 | ✅ 拒绝(`No END header found`)且**不重启** |
| 隐私导出 | 单会话 Markdown | ✅ 写入系统「文档」目录,返回脱敏计数 |
| 对话导入 | 粘贴文本 / 重复粘贴 | ✅ 1 会话 4 消息;重复 `skipped: 1`(幂等) |
| 冲突检测 | 无 LLM | ✅ 明确降级「LLM 未配置」 |
| 设置页 | 通用/会话捕获/智能引擎/同步与备份/插件/关于 | ✅ 6 分类 + 外观全部正常渲染;插件分组显示「会话捕获 2/26 启用」 |
| 主题 | 深色 ↔ 浅色 | ✅ `data-theme` 与 body 背景即时切换,浅色无字面颜色遗漏 |
| 立即扫描 | 按钮 + 计数 | ✅ 捕获计数由「新增 224/扫描 224」→「新增 0/扫描 1」,增量生效 |
| 项目总结弹窗 | 插件被禁用的库 | ❌ 永久「加载中…」,见 P2-4 |
| 开机自启 | dev 模式 | ✅ 返回 `supported:false` 并提示「开发模式下不可用(登录项注册的是 electron.exe)」 |

---

## 七、缺陷清单

### P1-1 演示库泄露真实会话(宣传截图隐私事故)

**现象**:`scripts/seed-demo.ts` 声称生成「完全虚构」的演示库(13 会话 / 16 记忆),但应用启动后被导入本机真实 agent 数据。

**证据**:
- seed 输出:`demo db: ... sessions=13 memories=16`
- 启动仅数分钟后再查同一库:`465` 会话,其中 `mimocode 224` 条,标题包含「读取nas-setup记忆并测试米家设备控制」「阅读docs/HANDOFF.md,了解项目情况」(即本次测试会话)。
- `capture-mimocode` 是唯一注册了 `status/scanNow` 的捕获插件 —— 因为其余 13 家被 seed 关闭,而**新增的 10 家(mimocode/goose/droid/cline/pi/omp/omo/grok/minimax/deveco/copilot)不在 seed 的 `demoPlugins` 名单里**,宿主按「源存在即默认启用」把它们打开了。

**影响**:`scripts/take-screenshots.mjs` 用同一 seed 流程截图,产出的宣传图会含真实会话标题(项目名/任务名),属对外发布即泄露。这正是 seed 注释里想防的场景,只是名单与 `BUILTIN_PLUGIN_IDS` 已经脱同步。

**建议**:seed 改为「遍历 `BUILTIN_PLUGIN_IDS` 中所有 `capture-*`/`import-chat`/`capture-watcher` 一律写 `enabled:false`」,或引入 `demo:true` 硬开关让宿主直接跳过全部捕获插件;并在截图脚本启动后断言 `sessions` 行数等于 seed 声明值。

---

### P2-2 settings.json 带 UTF-8 BOM → 静默清空全部设置

**现象**:设置文件若以 UTF-8 BOM 保存(记事本、部分编辑器默认),应用启动 `JSON.parse` 抛错 → `catch` 里 `this.data = {}` → 之后任一 `set()` 用空对象覆盖原文件。

**复现**:在隔离库写入带 BOM 的 `settings.json`(含 `sync-folder:plaintextAck: true`)后启动 `--sync`:
- `deviceId` 由 `dev-ff7fecbc` 变为 `dev-a8077dc7`(**同步身份漂移,旧 bundle 成孤儿**)
- `plaintextAck` 消失,同步被拒
- 用户可见症状:所有插件启停、捕获水位、LLM 配置、端口设置凭空回到默认

**代码**:`src/main/core/settings.ts:15-19`(解析失败静默降级为 `{}`,随后 `set` 覆盖)。

**建议**:读取时 `replace(/^\uFEFF/, '')`;解析失败把原文件改名为 `settings.json.corrupt-<ts>` 并在设置页顶部提示,而不是用空对象覆盖。

---

### P2-3 语义检索不可用:上游 403 + 坏缓存毒化

**现象**:开启 `semantic-search:enabled` 后 `--reindex` 恒失败 `TAR_BAD_ARCHIVE: Unrecognized archive format`。

**根因链**:
1. `fastembed` 从 `https://storage.googleapis.com/qdrant-fastembed/fast-bge-small-zh-v1.5.tar.gz` 下载模型;
2. 该 bucket 现返回 **403 AccessDenied**(响应体 399 字节 XML,含「Anonymous caller does not have … permission … qdrant-fastembed」);
3. 下载实现不校验 HTTP 状态,直接把错误体写成 `fastembed-cache/fast-bge-small-zh-v1.5.tar.gz`(**399 字节**);
4. 解压必然失败;删除缓存重试会**再次写坏缓存**,永不自愈;
5. 用户侧只有 `TAR_BAD_ARCHIVE`,无法得知是上游 403。

**影响**:M7 核心能力「语义补足召回」在本版本彻底不可用;**不是网络墙问题**(任何网络环境同一结果),也不是本项目自有代码的 URL。

**建议**:① 下载后校验 `res.ok` 与文件大小/魔数;② 失败即删除半成品缓存;③ 换成可用镜像或在项目侧自托管模型包;④ 状态页区分「上游不可达 / 校验失败 / 未启用」。

---

### P2-4 项目总结弹窗永久「加载中…」

**现象**:在 `project-digest` 插件被禁用(或依赖未启用)的库里点「项目总结」,弹窗标题正常但内容永远停在「加载中…」,等待 10 秒以上无变化。

**根因**:`src/renderer/src/App.tsx:1470-1474` 只处理 `digestInfo == null`(加载中)与 `!digestInfo.enabled`(未开启);但插件被禁用时 `project-digest:latest` channel **根本不存在**,`invoke` 抛错后 `digestInfo` 恒为 `null`,落进「加载中」。

**建议**:`openDigest` 加 try/catch,失败时设置「项目记忆插件未启用(设置→插件 开启后重启)」状态 —— `SettingsView.tsx:1327` 已有同款文案可复用。

---

### P2-5 同一路径因分隔符分裂成两个项目

**现象**:查项目表发现同一物理目录登记两次,`\` 与 `/` 各一条:

| 项目名 | 两条路径 | 会话分布 |
|---|---|---|
| MemorySQL | `H:\桌面\MemorySQL` / `H:/桌面/MemorySQL` | 50 / 7 |
| temp | `H:\桌面\temp` / `H:/桌面/temp` | 139 / 14 |
| money | `H:\桌面\temp\money` / `H:/桌面/temp/money` | 5 / ? |

**根因**:`projects.path` 按原样字符串唯一;不同 agent 的 `cwd` 序列化风格不同(claudecode 用 `/`,Windows 原生 agent 用 `\`),`ensureProject` 未做规范化。

**影响**:同一项目的会话被拆到两个「项目」,项目总结只覆盖其中一半、项目记忆归属错位、列表折叠分组出现两个同名组。v0.7.7 的**项目三级匹配**在读取侧做了兜底(名字/路径段/子串),缓解了 agent 侧续接,但库内仍在持续分裂。

**建议**:`ensureProject` 统一 `path.resolve` + 平台化分隔符(或大小写归一),并对存量做一次性合并迁移(re-point 会话、合并记忆、去重)。

---

### P3 级问题

| 编号 | 问题 | 证据 / 位置 | 建议 |
|---|---|---|---|
| P3-6 | 2 字中文查询走 `LIKE %x%` 全表扫 | `search.ts:61,126`;71 912 消息库上可用但随库增长线性变慢 | 按 AGENTS 待办补 bigram 索引 |
| P3-7 | IPC `memory-core:save` 同内容不去重 | 连续两次同内容 → id 35/36 两条都在;`memories:list` 出现重复行 | 复用 `addMemory` 的内容哈希去重,或 UI 二次确认 |
| P3-8 | `memory_search` 传错参数名返回「未找到」 | 传 `q` 而非 `query` → 输出「未找到与""相关的记录」,易误导 agent | schema 校验必填参数,缺失时报参数错误 |
| P3-9 | `--reindex` 未启用时只报 `Unknown channel` | 语义插件默认关闭 → CLI `semantic-search:reindex` 不存在 | CLI 特判并提示「语义检索未启用(设置→智能引擎开启)」 |
| P3-10 | 设置页硬编码「8 个工具」 | `SettingsView.tsx` 使用指引文案 vs `mcp-server:status.toolCount`(本配置 7) | 用 `toolCount` 动态渲染 |
| P3-11 | `pluginSetting` 误报需重启 | `sync-folder:plaintextAck` 保存返回 `restartNeeded:true`,但 `syncNow` 立即可用 | 仅对 `plugin.*.enabled` 返回 true |
| P3-12 | 跨设备同步不同步元数据 | 伪造远端改标题 + 抬高 `updated_at` → `sessionsUpdated:0`,库内无新标题 | 明确文档化「只同步内容」,或对 title 也走 LWW |
| P3-13 | `memory_get_project_digest` 随插件启停消失 | 插件禁用 → agent 侧工具静默少一个(无 8→7 提示) | 在 `initialize` instructions 或 `tools/list` 标注未启用能力 |

---

## 八、未覆盖项与残余风险

| 项 | 原因 |
|---|---|
| 语义检索端到端(嵌入/KNN/召回) | 被 P2-3 的上游 403 阻塞,只能验证到「失败路径正确」 |
| 装机版(asar、原生模块、自动更新下载与安装) | 需打包 + 联网下载,本轮只验证 dev 构建产物 |
| Spotlight 秒搜 / 托盘 / 全局热键 | 需真实窗口焦点与系统快捷键,CDP 无法可靠模拟 |
| 连接向导「一键连接」与「写入规则」 | 会改写真实 agent 配置,按铁律不在测试中触碰(仅验证 `agentSnippet` 路径可用) |
| LLM 真实调用(摘要/整理/冲突检测) | 本机无 key;验证了四条 provider 配置读写与「未配置」降级 |
| macOS / Linux 行为 | 无对应环境 |
| 真实库(322 MB)上的 GUI 交互 | 用隔离库替代:装机版正在运行且有单实例锁,避免污染 |

---

## 九、建议修复顺序

1. **P1-1 演示库隔离**(宣传物料直接对外,风险最高且改动小:名单从 `BUILTIN_PLUGIN_IDS` 派生)。
2. **P2-2 settings BOM 容错**(用户改配置即可能触发,且后果是「设置全丢 + 同步身份漂移」)。
3. **P2-3 语义检索**:先修「不校验 HTTP 状态 + 缓存毒化」,再解上游源(否则该功能对外即坏)。
4. **P2-5 项目路径归一**(影响项目总结/项目记忆的正确性,且存量会持续累积)。
5. **P2-4 项目总结弹窗错误态**(纯前端 3 行)。
6. P3 按发布节奏清理,P3-7/8 建议随下次记忆相关改动一起做。

---

## 十、复现入口(供后续回归)

```powershell
# 静态基线
npm run typecheck; npm test; npm run build; npm run upstream:check

# 后端全链路(隔离库,不碰真库)
$env:MEMORYSQL_DATA_DIR="<tmp>\data"
npx electron . --scan --dispatch --devlog --sync "<tmp>\sync" --export-archive "<tmp>\out\a.msqlv"

# GUI(演示库 + 独立 userData 绕过单实例锁)
node --experimental-strip-types scripts/seed-demo.ts "<tmp-gui>\data"
$env:MEMORYSQL_DATA_DIR="<tmp-gui>\data"
Start-Process node_modules\electron\dist\electron.exe -ArgumentList '.','--remote-debugging-port=9223',"--user-data-dir=<tmp-gui>\userdata"
# 之后经 CDP: window.memorysql.invoke('<pluginId>:<name>', payload)
```

本轮所有隔离数据留在 `%TEMP%\msql-verify\`、`%TEMP%\msql-gui\`,测试用 electron 进程已全部关闭,装机版 MemorySQL 与真实库未被修改。
