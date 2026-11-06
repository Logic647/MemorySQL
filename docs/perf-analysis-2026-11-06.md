# MemorySQL 性能分析 · 合并摘要（2026-11-06）

> 三份分域报告：`out/perf/main-process.md`（启动/主进程/MCP）、`out/perf/database.md`（SQLite/查询）、`out/perf/renderer.md`（React/IPC/资源）。
> 方法：只读源码 + 真库只读快照（702MB / 307 会话 / 56,288 消息）+ 隔离微基准；**未启动 GUI**。标注【实测】/【静态】。
> 局限：主进程数字为热缓存；renderer 的「渲染工作量」用 `renderToStaticMarkup` 作代理，不含 DOM commit/layout/paint。

## 一句话结论

**卡顿的根不在查询、也不在索引（现有 8 条索引已覆盖全部高频查询，实测均 < 0.6ms），而在两条写/重建路径：①任何一条新消息都触发整会话删+重插（1.0–1.4s，94% 是 FTS trigram）；②启动时串行全量重解析所有 agent 数据源（≈1.5s 连续主线程块，且不让出事件循环）。** 前端另有「首屏假空态」和「列表硬编码 200 条」两个用户可见问题。

## P0（用户可感知的卡顿/错误）

| # | 问题 | 位置 | 实测 | 修法 | 预期 |
|---|---|---|---|---|---|
| 1 | **ingest 整会话重写**：内容哈希一变，删全部消息+FTS 再逐条重插 | `core-schema/ingest.ts:288` | 7,303 条/3.6MB 会话 **1,409ms**（FTS 占 94%）；无变化时 22–26ms | 按消息前后缀 diff，只重写变化尾部（原型已验：**11–25ms，中位 13.3**） | **~100×**，WAL 32–46MB/次 → 0.11MB |
| 2 | **opencode 每次 db 写入全库重解析**，且一个防抖批次按路径重复触发（db/-wal/-shm 最多 3 次） | `capture-opencode/index.ts:54`（`rescan:true`）+ `plugin-host.ts:325-337` | **633ms/次**，最坏 **1.9s** | 增量读 + 批次内按会话去重 + time_updated 水位 | 活跃会话期 CPU −90% |
| 3 | **启动即全量扫描，串行且不让出事件循环** | `main/index.ts:700-715` | 5 个启用适配器合计 **≈1.50s**；等价 await 链实测 1000ms 内 `setTimeout(0)` 不触发 | 延后到渲染层就绪后 + 分批 `await setImmediate` + 解析搬 `utilityProcess` | 首屏数据 −1.0~1.5s |
| 4 | **首屏「假空态」**：`sessions=[]` 直接渲染「暂无会话，点击立即扫描」 | `App.tsx:1122-1124` + `refresh()` 3 次串行 IPC `231-242` | 与 #3 叠加，错误提示 **1.5–2s** | 骨架屏 + `Promise.all` | 消除「空库」误判 |
| 5 | **会话列表硬编码 `limit:200` 且无分页**，真库 307 条 → **107 条不可见**；标题写 200、chip 写 307 | `api.ts:78`；后端本已支持 `offset` | 307 vs 200 | 接上 offset + 「加载更多」或虚拟列表 | 数据可达性 |

## P1（明显浪费，但需改动）

- **`memory_get_session` 全量读正文再截断**：`#260` 全量 10.99ms vs `tail=200` **0.19ms（58×）**；`distillSession` 同理（9.58→1.24ms，8×）。预算窗口应下推到 SQL。
- **2 字中文查询走 `LIKE '%…%'` 全表扫**：不命中 **49–53ms**（扫 28MB 正文）；`<3 字符` 守卫本身正确（FTS 对 1–2 字返回 0）。可改 `messages_fts` 加 bigram 列或对 2 字查询用前缀+后过滤。
- **`capture-hermes` 在窗口创建前同步 spawn `reg.exe`**（timeout 4s，未命中不缓存）：未装 Hermes 的机器每次开机重来。改成异步 + 缓存否定结果。
- **28 个插件 init/start 两轮串行且在 `createWindow()` 之前**；含 `~/.gemini` 全树 chokidar（**377ms / 321 目录**）。可并行化 + watcher 后置。
- **渲染层 0 处 `useMemo`/`memo`，全部状态挂 App 根**：131 行列表渲染 **5.29ms/次**，搜索/重命名/导入每敲一键重建整表；点一次筛选 chip 重打 **16 个 IPC**（3 refresh + 13 captureStatus），`overview/hostPlugins` 与筛选无关仍重取。

## P2（白捡 / 规模风险）

- **renderer 产物未压缩**（electron-vite 5 默认 `minify:false`，配置未覆盖）：711,566B → 276,726B（**−61%**），装机 asar 内同样是未压缩版。零风险白捡。
- **库 76% 是空闲页**：702MB → `VACUUM` 后 **185MB（1.19s）**；`messages_fts_content` 还额外存 38.5MB 正文副本；`notes/notes_fts` 死表 ~2.7MB。不拖慢查询，拖慢备份/复制/杀毒扫描。
- **语义检索 ONNX 推理在主进程**（本机 enabled=true）：init 152ms、每次 query 24–33ms，与 UI/同步 DB 抢主线程。
- **分组渲染 O(n²)**（`App.tsx:988`）：现 0.15ms，但正好挡在「放开 200 上限」前面，800 行时 **8.44ms**。
- **20 个图层 `backdrop-filter` 叠在永久动画 aurora 上**，GPU/合成开销。

## 明确「不要做」的事

- **不要加索引**：逐个加 5 个候选索引做对照，最大收益 0.47→0.26ms；`memories.source` 之类只值 0.007ms。钱该花在写路径与读放大上。
- MCP 请求路径本身健康：`memory_get_session` 最坏 3.98ms、FTS 3 字 0.07ms、prepare 0.009–0.022ms。

## 建议修复顺序

1. **ingest 消息级 diff**（P0-1，收益最大，已有原型数据）→ 连带解决 opencode/所有 watcher 的写入放大
2. **启动扫描后置 + 分批让出**（P0-3）→ 首屏立刻有数据
3. **首屏骨架屏 + Promise.all**（P0-4，改几行）→ 与 2 一起解决「开窗即报错」
4. **列表分页/虚拟化**（P0-5，需先修 O(n²) 分组）
5. **renderer 开 minify**（P2，一行配置）+ `VACUUM` 一次性回收 500MB
6. P1 各项按用户可感知度排序（memory_get_session 下推 → 2 字查询 → hermes 异步）

## 复现

脚本均在 `out/perf/`：`main-*.{cjs,ts,mjs}`、`dbprobe-*.cjs`、`bench-*.cjs`。

库快照已删除以回收 703MB（分析结束时 H 盘仅剩 3G）。复现前先重拷：

```bash
cp "$APPDATA/memorysql/data/memory.db" out/perf/db-copy.sqlite   # ~700MB
```

`dist/`（1.3GB）是既有打包产物，未清理。
