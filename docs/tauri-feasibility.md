# MemorySQL × Tauri 可行性评估

> 2026-10-25 · 应「软件体积太大,能否换技术栈」立项评估。本文只评估不迁码;
> 体积数字为当日实测,估算部分明确标注。**同日下午已用最小 spike 实测替代
> 关键估算(见「Spike 实测」节),结论不变、数字校准。**

## 结论先行

**现在不迁移。** 体积收益真实(spike 实测:纯壳安装包仅 **1.58MB**、壳+侧车
压缩口径合计约 **38MB**,比本文原估算还要低一个量级),但代价是把 100% 的
主进程(26 个插件、MCP 服务、13 家 agent 捕获解析器、更新链路)推倒重来,
工作量以人月计;而 0.7.0 已经把「Electron 内能砍的」砍完了(105.5→99.5MB,
语义组件 20MB 转按需下载)。**另注意:内存收益远小于体积收益**——Tauri 壳
托盘驻留实测 152MB private(Electron 全功能 406MB),WebView2 六子进程并不
比 Electron 轻多少。**建议保持关注 + 设定重评触发条件**(见文末),若将来
启动,从 `out/tauri-spike/` 骨架续做,走「Tauri 壳 + Node 侧车」半步路线
保住插件生态,而不是直接全 Rust 重写。

## 体积测算(2026-10-25 实测 + 估算)

| 方案 | 安装包 | 解压 | 口径 |
|---|---|---|---|
| Electron 0.6.0(基线) | 105.5 MB | 357 MB | 实测 |
| Electron 0.7.0(语义组件外置) | **99.5 MB** | **329 MB** | 实测;+20MB 组件按需下载 |
| Tauri + Node 侧车 | 约 55-65 MB | 约 180-220 MB | **估算**:Tauri 壳 3-8MB + Node 运行时(压缩约 25MB)+ 原生三件套不变 |
| Tauri 全 Rust | 约 15-25 MB | 约 60-90 MB | **估算**:WebView2 系统自带(Win10 2004+/11),Rust 壳+rusqlite+ort 绑定 |

估算依据:MemorySQL.exe(Electron 底子)解压 234MB、压缩后约占安装包 85MB;
Node 22 独立运行时压缩约 25-30MB;Tauri 空壳典型 3-8MB。**压缩口径下 Electron
的体积大头其实是 Chromium 本体,LZMA 已经压得很好**——这是「换前端栈无意义、
换壳才有意义」的量化根据。

## Spike 实测(2026-10-25,本机 Win11 · out/tauri-spike/)

**spike 范围**:原文末设想的「托盘 + MCP 服务 + 读库」三件事,一天完成。
①托盘常驻(菜单 显示/退出,关窗隐藏);②读**真实库副本**(651.7MB 快照,
rusqlite bundled SQLite 只读打开,FTS5 trigram `MATCH('MemorySQL')` 命中 14 条);
③Node 侧车(node.exe + better-sqlite3 开同一快照,`/health` + MCP 形状 `/mcp`,
tools/call 真查 FTS 与会话表)。构建:VS2026 MSVC(本机已有)+ rustup minimal,
cargo release 首次全量 ~4 分钟、增量 43 秒;NSIS 由 tauri CLI 自动下载,直连成功。

| 项 | 实测 | 本文原估算 |
|---|---|---|
| Tauri 纯壳(解压,单 exe,含托盘+rusqlite+FTS5) | **4.03 MB** | 空壳 3-8 MB ✓ |
| Tauri 纯壳安装包(NSIS,downloadBootstrapper 口径) | **1.58 MB** | 全 Rust 安装包 15-25 MB(远低于) |
| Node 侧车原始部署(node.exe 87.4 + node_modules 14.0) | 101.4 MB | — |
| Node 侧车 zip 压缩(node.exe 独占约 31MB) | **36.5 MB** | Node 运行时压缩 25-30 MB ✓ |
| **路线 B 合计(压缩口径:壳 1.58 + 侧车 36.5)** | **≈38 MB** | 55-65 MB(低于) |

内存(托盘驻留态,WorkingSet / Private,同机同时刻 PowerShell CIM 实测):

| 进程树 | WS | Private |
|---|---|---|
| Tauri spike(壳 25.7 + WebView2 六进程 ~337) | 363 MB | **152 MB** |
| Node 侧车(单进程,只读打开 651MB 库) | 62 MB | 25 MB |
| Electron 0.7.0 装机版(4 进程,全功能常驻) | 510 MB | **406 MB** |

**读数要点:**
1. **磁盘体积结论被强化**:纯壳 1.58MB 安装包连原估算的下限都远低于(估算按
   embedBootstrapper 等保守口径);路线 B 合计 ≈38MB。若真迁,体积收益比本文
   原估更大——但 99.5MB 现状并不痛,收益够不着重写成本。
2. **内存收益有限**:WebView2 六子进程托盘驻留 152MB private,对比 Electron
   406MB——且**功能不对等**(spike 无任何插件/watcher/MCP 全量逻辑),真实
   等价 Tauri 版会显著更高。「换栈省内存」的直觉在 WebView2 上不成立多少。
3. spike 只覆盖了「简单的 5%」:13 家捕获解析器、60+ IPC、更新链路切换、
   外部插件机制这些真正的成本项,spike 无法也不必替它们估算——架构映射表
   与两条路线的工作量判断维持不变。
4. 过程坑(已记 DEVLOG):WAL 库只读连接改 `journal_mode` 即 `SQLITE_IOERR_LOCK`
   (pragma 是写操作);`memories_fts` 列名为 `content`;trigram 查询词 ≥3 字符
   否则 0 命中(正确行为);exe 被驻留进程锁定时 `tauri build` 报 os error 5;
   Mimosa 拦「env/argv 路径 → Command/fs」污点流,spike 改编译期常量路径。

**磁盘占用**:spike 产物在 `out/tauri-spike/`(gitignored):cargo target
1.24GB + 库快照 652MB,不需要可直接删目录。

## 架构映射表(逐块评估)

| 现有资产 | Tauri 对应物 | 难度 | 备注 |
|---|---|---|---|
| 渲染层 React(产物 0.68MB) | 原样保留 | 低 | 唯一不用动的大块 |
| PluginHost + 60+ IPC channels | Tauri commands + events | 中 | 通道语义要 1:1 重建 |
| core-schema(SQLite + FTS5 trigram + ingest) | rusqlite + FTS5 | 高 | SQL 思路可抄,逻辑全重写 |
| MCP 服务端(自研 HTTP /mcp,8 工具) | Rust axum / tiny_http | 中 | 协议自研,行为须逐工具对齐 |
| capture-* ×13(解析器矩阵 + watcher) | Rust notify + 全部解析器重写 | **极高** | 上游漂移全靠这套消化,重写=把 2026-08 以来的适配坑重踩一遍 |
| electron-updater + latest.yml + blockmap | tauri updater(自有格式) | 中 | **两套更新器不能互切,存量用户必须手动装一次** |
| 托盘 / 秒搜热键 / spotlight | tauri 插件(tray / global-shortcut) | 低-中 | |
| core-launcher 开机自启 | tauri-plugin-autostart | 低 | |
| 语义检索 fastembed + onnxruntime | ort Rust 绑定,或延续「组件 zip 按需下载」 | 中 | N-API 兼容优势消失;0.7.0 的外置思路可平移 |
| 外部插件(CJS 动态加载) | 仅 Node 侧车方案可保 | 高 | Rust 无对应机制 |
| 归档/同步/隐私导出/项目总结 | Rust 或侧车 | 中 | |

## 两条路线

**A. 全 Rust 重写** —— 体积最优(15-25MB)。工作量估 4-6 人月,大头是 13 家
捕获解析器与 ingest 管线。风险:上游格式漂移的响应速度变慢(Rust 改动成本高)、
更新链路一次性切换、三平台原生矩阵重列(sqlite/ort/vec)。

**B. Tauri 壳 + Node 侧车(半步)** —— 渲染层不动、全部 TS 插件装进常驻
Node sidecar,Tauri 只做壳(窗口/托盘/热键/更新)。工作量估 3-4 人周。代价:
体积只降到 55-65MB;架构复杂度翻倍(IPC 双跳、双运行时打包、崩溃面扩大);
**除非体积是硬指标,性价比一般** —— 但它是唯一能保住插件生态与外部插件机制的
渐进路径,若真要迁,从这里起步。

## 风险清单

1. **更新链路断裂**:0.4.x-0.6.x 存量用户的 electron-updater 永远收不到
   Tauri 版,必须手动下载安装(0.4.2 时代更新链路坏了近一个月才被发现,
   这是本项目真实踩过的坑)。
2. 三平台原生矩阵:当前 CI 双矩阵(win/linux/mac arm64+x64)全绿是资产,
   Rust 侧要重新建立等价物。
3. 国内网络:WebView2 缺失时的引导下载、Rust 工具链与 crates.io 镜像、
   ort 模型分发。
4. macOS 未签名现状在 Tauri 下同样存在(ad-hoc 签名行为还有差异)。
5. 单实例锁、`--hidden` 登录驻留、headless CLI(--scan/--digest/--reindex)
   等行为需要在壳层重实现。

## 重评触发条件

满足任一即重开评估:

- (a) 安装包重新成为痛点(比如新增原生能力后回到 >150MB);
- (b) 出现必须 Rust 才能落地的能力需求(如内核级 hook、超低内存常驻);
- (c) Tauri 生态出现「SQLite+FTS5+文件监听+自动更新」的成熟参考范式,
  使捕获矩阵的重写成本显著下降。

**spike 已于 2026-10-25 提前做完**(范围「托盘 + MCP 服务 + 读库」,一天,实测
见前文)。若将来立项,2 周 spike 的范围缩小为:**迁移 1-2 家真实捕获解析器
(建议 hermes + zcode,一文件一库两形态)+ 更新链路对齐方案**,再决定是否全面立项。
