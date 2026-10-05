# MemorySQL 开发日志(追加式)

> 规则:每完成一个里程碑/重要变更,在文件**顶部**新增一条(新在上);不删改历史条目。接手 agent:读最新一条即知当前进度与下一步。

---

## 2026-10-05 · 公网入口曾对写端点完全敞开(nginx 注入 token 的副作用)

### 怎么发现的:一个"不可能成功"的成功

跑完探针,输出里**缺了「云端上报成功」那一行**,而 `PROBE_TOKEN` 被设成了字面量
占位符 `<token>`(是我上条消息里的示例,被照抄了)。**带着错 token 却上传成功,不合理。**

查 nginx 配置,`/etc/nginx/sites-enabled/msql-watch` 第 9 行:

```nginx
location / {                                                            # 一个 location 罩住全部路径
    proxy_set_header Authorization "Bearer <真 token>";                 # 无条件覆盖客户端的头
}
```

nginx 用自己的值**覆盖**客户端发来的 `Authorization`,所以服务里的 `auth()`
(L154,路由之前全局生效)永远看到正确的 token —— **等于所有请求都认证通过**。

实测(从服务器上打,本机网络不稳不可靠):

| | 改前 |
|---|---|
| 公网经 nginx `GET /api/state` 无 token | **200** |
| 内网绕过 nginx `:8788` 无 token | 401 |

**读公开可能是有意的**(页面本来就要匿名能开),问题在**写**:

| 端点 | 谁能调 | 后果 |
|---|---|---|
| `POST /api/probe` | **任何人** | 伪造黑盒结果,面板显示假的「0 漂移」 |
| `POST /api/manual` | **任何人** | 伪造 changelog,白盒结论整个失真 |

更糟的是探针上报的 `ledgerHash` 也在这条路径里 —— **任何人都能伪造它,把真正的契约不一致
掩盖掉,或反过来凭空造一条红条**。这正好绕过了契约指纹校验存在的唯一理由:
指纹比较的是数据,而数据本身可以被人随便改。

### 修法:按读/写拆开

`location = <精确路径>` 优先级高于 `location /`,把两个写端点摘出来透传客户端自己的
`Authorization`(探针本来就持有 `PROBE_TOKEN`)。nginx 在值为空时**省略该头**,
于是不带 token 的请求落到服务自己的 `auth()` → 401。

`/api/refresh` **保持公开**:页面上的「立即刷新」按钮要用,而页面不该持有密钥。
它只触发一次抓取(运行中返 409)、不改已存数据 —— 小风险,已在配置注释里写明代价。

实测通过(备份在 `/root/nginx-backups/`,`nginx -t` 先过再 reload):

| 请求 | 改后 |
|---|---|
| `GET /api/state` 无 token | 200(页面仍匿名可开) |
| `GET /api/probe` 无 token | **401** |
| `GET /api/probe` 有 token | 404 ← 期望值,证明头确实透传(否则探针会一直 401) |
| `GET /api/manual` 无 token | **401** |

### 第二次踩坑:备份放错目录

第一次应用时把备份 `msql-watch.bak-xxx` 放在 `sites-enabled/` 里 ——
**nginx 会 include 该目录下每一个文件**,于是备份被当成第二份 `server` 块,
报 `duplicate listen options for [::]:443`,`nginx -t` 一直红、之后任何 reload 都会挂。
回滚了配置但校验仍红,得再跑一次把备份挪到 `/root/nginx-backups/`。
**好在全程没执行 reload**(校验失败就退出),内存里还是旧配置,线上没受影响。
已写进 `DEPLOY.md`:备份目录不在 `includes` 范围内。

### 教训

**"带着错凭据却成功"是这类洞的典型暴露方式。** 当时如果只看「云端上报成功」就收工,
这个洞会一直开着 —— 而且从面板上完全看不出来(数据看着挺正常,只是内容是别人写的)。
同一晚上我还犯了两个同类错:PowerShell 的 `Get-Content -Raw` 按 GBK 解码弄坏 AGENTS.md、
把 U+FE4E(私有区)当成 `个`。**三个错都是"看起来做完了"的那种。**

DEPLOY.md 原来推荐的正是那个有洞的配置,已重写为按读/写拆开 + 四条实测清单。

---

## 2026-10-05 · ZCode 开源,黑盒升白盒(契约从推测变成源码确认)

台账里 zcode 原是 `upstream: { kind: 'none' }` + `monitor: 'blackbox_only'`(4 家闭源之一)。
ZCode 公开了仓库 **`zai-org/ZCode`**(Z.ai 的 coding agent harness,7.4k star,客户端/后端/Agent CLI 源码齐全),
于是从"黑盒推测"升级成"逐条查源码"。

### 查源码逐条核对,结论是台账本来就对

| 声明 | 依据 | |
|---|---|---|
| `.zcode/cli/db/db.sqlite` | `adapters/src/storage/session-store/paths.ts` 的 `getDefaultSessionDbPath()` | ✅ |
| 表 `session`/`message`/`part` | 同目录 `migrations.ts` 的 `0001_base_session_store` 建表 SQL | ✅ |
| `session` 的 5 个必需列 | 同上,实际 20 列,5 个逐一核对 | ✅ |
| `mcp.requiredKeys: ['type','url']` | `adapters/src/config/schema.ts` | ✅ |

**交叉验证**:源码里数出 23 张表,本机黑盒实测也是 **23 张**(`布局 [session,message,part] 与列均匹配(共 23 张表)`)。
上游源码与实际安装完全一致 → 本机没有私有分叉,源码推出的契约可信。

### 顺带发现:和 opencode 那个 bug 是同一类

```ts
const mcpServerSchema = z.preprocess(normalizeMcpServerConfigInput,
  z.discriminatedUnion("type", [stdio, http, sse]));
// http 分支 = z.object({ type: z.literal("http"), url: z.string().min(1) }).strict()
```

`type` 是**判别式** —— 缺它整条 server 被 strict 校验丢弃且不报错。
**这正是 v0.5.6 修的 opencode `type:remote` 那个 bug 的同构版本**。
好在连接器当初就写了 `type: 'http'`(`valueHints.type='http'`),存量用户没踩到。
已把依据写进台账注释 —— 免得以后有人当"多余字段"清掉它。

ZCode 源码自己也留了同类教训的注释:*"配置入口漏掉该字段会因 strict 校验丢弃整个 server"*。

### 两处顺手治理

1. **闭源小节标题里的家数删掉了**(原写"4 家")。每有一家开源就要改一次注释,迟早会忘 ——
   和 `note` 不进契约指纹是同一个道理。
2. `ledger.json` 是**手工同步**的(当时跑不了 `npm run ledger:export`),事后本机跑导出确认一致。

### 会看到红条,那是功能在工作

`upstream` 与 `monitor` 都在契约指纹的覆盖范围内,**这次改动必然改变指纹**。
服务器还没 pull 时,面板会显示红色「契约不一致」——**不是故障**,是昨天做的指纹校验在正确报警。
服务器 pull + 本机重跑 `npm run upstream:probe` 后自动变 `match`。

闭源从 4 家降到 **3 家**(qoder / codebuddy / workbuddy)。
zcode 现有白盒,当前仅 1 个 release(`v3.14.3`),内容是 workflow 并发与复用逻辑 ——
**不命中任何风险关键词**(schema/migration/table/…),判 low/none 是对的:
那些表(`workflow_run`/`dwf_*`)与 `session/message/part` 无关。

typecheck 0 / vitest **320:320** / 黑盒 🟢4 🔴0 🟣0。

---

## 2026-10-01 · v0.5.6 已发版(Windows + Linux + macOS arm64)

`96ea687` / tag `v0.5.6`。**12 个资产,三平台必传件全齐**,一次性传到齐(未复现 blockmap 缺件坑):

| 平台 | 资产 | updater 索引 |
|---|---|---|
| Windows | `Setup.exe` + `.exe.blockmap` | `latest.yml` ✅ |
| Linux | `.AppImage` + `.tar.gz` + `_amd64.deb` | `latest-linux.yml` ✅ |
| macOS arm64 | `.dmg` + `.zip` + 各自的 `.blockmap` | `latest-mac.yml` ✅ |

### 关键取舍:不等 x64 就发

`macos-13`(Intel)排了 **106 分钟仍未分配到 runner**(`runner_name` 为空),两个 run 各排一个。
决定**照发**,理由:macOS 是本版才首次支持,**不存在从 0.5.5 自动升级到 0.5.6 的 mac 用户**,
所以 arm64-only 清单的影响面推迟到了 0.5.6→0.5.7;而且 2026 年后的 Mac 全是 arm64。

发版说明里**写明**了:Intel 用户请手动下载、不要用应用内更新按钮(否则会因清单里没有 x64 包而报错)。
两个 x64 job 仍在排队,任一跑出来即可补传 x64 包 + 用 `merge-mac-manifest.mjs` 合并清单。

### 版本号只有 3 处

`package.json` 1 处 + `package-lock.json` 2 处。MCP `serverInfo` 与更新探测都走 `app.getVersion()`,
自动跟随。改 lockfile 时**按 `"version": "0.5.5"` 全局替换会误伤同名版本的依赖**(`mkdirp` 恰好就是 0.5.6)——
差点改坏,靠 `git diff` 只有 2 行 + 639 条依赖 `version`/`resolved` 一致性检查发现。

### 校验产物时省下的两个坑

1. **GitHub 的 release asset 带 `digest` 字段**(sha256),winget 要的哈希不用下 169 MB 也能拿到
2. 但**仍然自己流式下了一遍**并同时算 sha256 + sha512:sha256 与 GitHub digest 比、sha512 与
   `latest.yml` 里 electron-builder 写的比。两边都对上才敢填进 manifest —— 填错就是再被 msftbot 退一轮
3. 公网可达性:`latest-mac.yml` 第一次 curl 返 **HTTP 000**(本机到 GitHub 瞬时抖动,不是文件问题),
   重试 200/503 字节且 sha256 与 digest 一致。**HTTP 000 ≠ 文件缺失**,别误判

---

## 2026-09-30 · 契约指纹 + 隐私披露 + macOS 清单合并(发版前抓到的三个坑)

### ① 契约指纹:「台账版本差」与「上游漂移」原来长得一模一样

看板有两条独立证据链,白盒在**云端**用服务器自己那份 `upstream/ledger.json` 算,
黑盒在**开发机**用本机那份算再 POST 上来。两份是各自 git checkout 的文件,
而服务器靠手动 `git pull`(那条链路实测反复超时)。**所以它们真的可能不一致**,
一旦不一致就会出现「白盒说一切正常 / 黑盒说布局不匹配」,
而**你无法分辨这是上游改了格式还是两边台账版本不同** —— 这个判断直接触发一次适配发版。

两边各算一个指纹(`tools/upstream-watch/fingerprint.mjs`,只覆盖会改结论的字段,
`note`/`name` 明确排除),不一致时面板红条点名两个指纹 + 「结论不可比」+ 修复步骤。

**上线当天就抓到一个真实的**:部署后本机 `20bd187c` / 服务器 `ec173348`。
途中还验证了三态设计真的有用 —— 部署后、探针重跑前是 `unknown` 而不是误报的 `mismatch`
(上一次探针是功能上线前跑的,没带这个字段)。**两态实现此刻就会误报一个不存在的冲突。**

### ② 隐私披露:四条里有四条我第一遍就写错了

msftbot 以 `outdatedSensitiveVersion` 退回 winget PR,要求公开披露。写政策文件时
**逐条回源码核对,而不是照抄 bot 的话**(bot 说的对,但我自己写的不对):

| 我第一遍写的 | 实际 |
|---|---|
| provider = OpenAI/Anthropic/DeepSeek/MiMo | **只有 `openai \| anthropic \| ollama`** —— DeepSeek/MiMo 是**看板那个工具**的 provider,和本应用无关。用户会去找不存在的设置项 |
| vault 在 `memorysql/vault\` | 在 **`data/vault\`**;设置文件是 `data/settings.json`(我凭空编了个 `config.json`) |
| 「可在设置里关闭 MCP 服务」 | `plugin.mcp-server.enabled` 开关**存在**、设置页甚至有 `mcp disabled` 分支,但**界面只有端口输入框,没有开关**。安全文件里这么写是最糟的错法 —— 改成「已知产品缺口 + 真实办法是退出应用」 |
| 存了 thinking 块 | `RawMessage` 有 `meta`,改说「解析器保留的原始附加数据」(没确认任何 parser 抓 thinking) |

bot 说的**对**的两条也核实了才敢写:MCP 端点**确实无鉴权**
(`server.listen(port, '127.0.0.1')` + Host 白名单 + Origin 检查,防的是 DNS rebinding 与跨源,
**不是身份认证**)。另:文件夹同步有 `plaintextAck` 门禁(不勾选配不了目录),
停用**不删**已写出的文件。

### ③ macOS 清单合并:一个会真的发出去的坏更新

macOS 拆两个 runner 是因为 `macos-13`(Intel)**排了 86 分钟仍未分配到 runner**。
但代价是**两个 job 各产出一份 `latest-mac.yml`**,一个 release 只能放一个同名文件,后传的覆盖先传的。

用**装好的 electron-updater 自己的函数** `MacUpdater.filterFilesForArch`
(`out/MacUpdater.js:30`)实测:updater 读**这一份**清单,再从 `files:` 按架构过滤。

| 清单内容 | arm64 Mac 装到 | Intel Mac 装到 |
|---|---|---|
| 只有 arm64 | ✅ arm64 | `[]` → `ERR_UPDATER_ZIP_FILE_NOT_FOUND` |
| 只有 x64 | ⚠️ **Intel 版** | ✅ x64 |

**第二行是要命的**:Apple Silicon 会下载装上 **Intel 版**,而 `sqlite-vec` / `onnxruntime` /
`tokenizers` 全是按架构编译的原生模块 —— 换架构即损坏,**且不报任何错**,直到某个功能用到才崩。
CI 不会红,发版也不会报错。

`scripts/merge-mac-manifest.mjs` 合并两份 `files:`,然后**用 electron-updater 自己的函数**
校验两个架构都能解析到 zip(不是复述它的规则 —— 升级改了行为,校验跟着变),
单架构清单**拒绝输出**。版本不一致在**写盘前**抛错(实测退出码 1 且不生成输出文件)。

> 脚本第一版在 `assertBothArchesResolve(merged)` 里写成了 `m.files`,被新测试当场抓到;
> 另外单架构的情况实际报的是「arm64 与 x64 解析到了同一个包」,比「某架构取不到包」更准,改成锁这条信息。

**arm64 产物核对通过**(没整包下载 —— 374 MB 会超时,改用 Range 读 zip 尾部中央目录列条目、
再按偏移定点取 `latest-mac.yml`):`dmg` + `zip` + `latest-mac.yml` 三件套齐,**无 blockmap**
(只影响差分下载,清单里 `sha512` 仍校验完整性)。

### 状态

typecheck 0 / vitest **320:320**。`macos-13 x64` 仍是 GitHub runner 供给问题(两个 run 分别排了
86 / 17 分钟,**都没分配到 runner**,`runner_name` 为空),与代码无关。
**v0.5.6 仍不打 tag**,等 x64 产物出来以便验证合并后的清单。
winget 需等发布(要真实 SHA256)→ 用 `PRIVACY.md` 的 URL 改 manifest。

---

## 2026-09-30 · macOS 打包上线(第三平台)

### 先验证可行性,再动手

**没有假设原生模块支持 darwin,而是逐个查了** —— 其中三个靠 per-platform 可选依赖分发二进制,少一个就会做出「能装但语义检索静默失效」的包:

| 模块 | macOS 产物 |
|---|---|
| better-sqlite3 v13.0.3 | `prebuilds/darwin-{arm64,x64}.node` |
| onnxruntime-node v1.21.0 | `bin/napi-v3/darwin/{arm64,x64}/` |
| sqlite-vec v0.1.9 | 可选包 `sqlite-vec-darwin-{arm64,x64}` |
| @anush008/tokenizers | 可选包 `tokenizers-darwin-universal` |

**先扫了 `src/` 有没有写死的 Windows 假设**(这是加平台最容易被跳过、但事后最难查的一步):
唯一一处注册表调用**已被 `process.platform !== 'win32'` 守住**;无 powershell/cmd;
`setLoginItemSettings` / `showOpenDialog` / `shell.openPath` 都是 Electron 跨平台 API;
写死的 `D:\Hermes Agent CN Desktop\` 在 macOS 上不命中,而那正是应有结果(Windows-only 的 agent)。
**结论:不需要为 macOS 改任何业务代码。**

### 三个容易踩的坑

**① 图标只有 256x256,而 electron-builder 生成 .icns 要求 >=512**
macOS 会直接用 Electron 默认图标。已放大到 1024x1024(HighQualityBicubic + 轻量 unsharp mask)。
**unsharp 只作用 RGB 不动 alpha** —— 对 alpha 也锐化会在透明边缘产生白边。
(踩到的 GDI+ 坑:保存时源图仍被 `Bitmap` 占用会报「A generic error occurred in GDI+」,必须先 Dispose 源图。)

**② dmg 之外必须有 zip**
dmg 是给人装的,**zip 才是 electron-updater 在 macOS 上替换用的载荷**,`latest-mac.yml` 是它读的索引。
只发 dmg 的话 mac 用户装上之后再也不会收到自动更新,**且没有任何报错** —— 又是本项目的老朋友。

**③ 未签名 = Gatekeeper 拦首次启动**
没有 Apple Developer ID,`mac.identity: null` + CI 里 `CSC_IDENTITY_AUTO_DISCOVERY=false`。
代价是用户要点一次「右键 -> 打开」,或 `xattr -dr com.apple.quarantine`。
**这条写在 README 顶部而不是让用户自己撞。** 转签名的五个 secret 与三处配置已记进 RELEASE.md。

### 两个架构分开出包,不做 universal
`macos-14`(arm64)与 `macos-13`(x64)各出一个。universal 要合并两套 per-arch 可选依赖
外加 onnxruntime 的 dylib,而用**真实对应架构的 runner** 能让 `npm ci` 直接装对的可选包,无需跨架构技巧。

### 诚实的验证边界
**本地无法验证 mac 构建** —— electron-builder 硬性要求在 macOS 上构建,`--mac` 在 Windows 上
直接报 "supported only on macOS"。配置能解析、CI 矩阵能展开,但**真正的证明是 mac runner 变绿**。

---

## 2026-09-30 · 看板总体情况(LLM 叙述)+ 顺带挖出三个静默失败

### 总体情况面板

每张卡都有 LLM 判定,但没有一处回答"现在到底有没有事"。新增置顶面板:**程序统计**(代码算)+ **LLM 解读**(叙述)+ 需处理名单 + 动作清单 + 最大盲区。

**最重要的一条设计约束:数字由代码算,叙述由 LLM 写。**

最初想法是"把结果丢给 LLM 总结",但那必然出现 LLM 报"3 家高风险"而实际只有 2 家——**一个会编数字的看板比没有看板更危险,因为人会照着它行动**。所以 `buildBrief()` 是纯函数,算出全部计数/名单/判定;`summarize()` 把 brief 当**唯一**事实来源喂给 LM,只让它组织语言。面板把两者**分成两块显示**,对不上时用户当场看得见。测试里有一条专门让 LLM 谎报"12 家全部高风险",断言 brief 一字未变;另一条断言喂给 LLM 的 prompt 里**不含 changelog 原文**(只有算好的事实)。

`attention` 取**三信号的并集**而非最大值:白盒高/中 ∪ 黑盒漂移 ∪ LLM 判有影响。各自能发现对方发现不了的(黑盒抓白盒关键词匹配不到的格式变化,白盒覆盖本机没装的 agent)。闭源 4 家单独列——折进总数会造成"还有 8 家在监控"的错觉。

顺带补上了当初方案里规划过却没做的 `llm.mjs`:MiMo 那两处兼容(认证头 `api-key`、`max_completion_tokens`)以前在一个地方,现在 `evaluate` 与 `summarize` 共用一处。

### 三个静默失败(都是部署时实测撞出来的)

**① `running` 被落盘 → 服务可被永久锁死(最严重)**

`runOnce()` 靠 `state.running` 防重入,而 `saveState()` 把整个 state 含这个标志一起写盘。于是**抓取途中进程被杀**(即每次部署都会发生)会留下 `running:true`,下次启动的 `runOnce()` 判定"已在跑"直接 return,此后**永远不再抓取**。

症状极其隐蔽:服务 online、接口 200、页面照常显示,只是数据永远停在那一刻。**在服务器上实测复现**:把 `running` 置 true → 重启 → 刷新 **9ms 秒回旧数据**,再也刷不动。现两侧都防护:写盘剔除、读盘强制 false。

**② `/api/refresh` 撞上运行中的抓取时回 200 + 旧数据**,前端还完全忽略响应 → 点「立即刷新」看起来成功了,其实没刷新。改回 **409**,前端按状态码显示「已有抓取在进行」。

**③ JSON 提取用了贪婪正则** `/\{[\s\S]*\}/` —— 从第一个 `{` 吃到最后一个 `}`,文本里出现两段 JSON 或字符串含花括号就产出垃圾。摘要因此**间歇性**解析失败(`position 329` 落在 actions 数组里,毫无线索)。改为**括号配平扫描**(跳过字符串字面量),加 `tool_calls` 兜底(MiMo 返回里带这个字段),并把 `finish_reason` 带进错误信息。

第三条的错误信息立刻兑现了价值:报出"响应很可能被 maxTokens 截断",重试即成功——**根因是 `maxTokens:300` 太小**,MiMo 是推理模型,`reasoning_tokens` 就占掉 136。正文只剩不到 170。已提到 800 / 1200。

### 第四个:看渲染结果才发现的

页面上出现红色「**抓取失败 4 家**」,而那 4 家是闭源 agent,它们的 `fetchError` 恒为「闭源,无公开更新日志」——**那是预期状态不是故障**,而且紧挨着「黑盒尚未上报」自相矛盾。`buildBrief` 已过滤。**这一条测试一直是绿的,是截图暴露的**——测试覆盖不到"红标该不该红"。

### 附:两条 GitHub 链路可靠性不同

服务器上 `api.github.com` 稳定 0.36 秒(看板抓取靠它),而 **`github.com`(git 传输)间歇性连不上**:一次 `git pull` 卡 129 秒超时,一次 `fetch` 重试 7 次才成。**是两种不同故障,别互相归因。** 已记入 DEPLOY 并附重试循环。

---

## 2026-09-30 · 看板可用了,但 403 排查暴露了「四种病因被压成一种」

配 `GITHUB_TOKEN` 成功后,一轮抓取却仍然 12 家全部 `限流 (HTTP 403)`。查下来 token 完全正常(`remaining=4987`、内容读取 200),**那次 403 是 IP 级滥用检测**——匿名 60/小时刚被烧穿,换成 token 不会立刻解除 IP 级标记,约一分钟后自愈。重跑即恢复,分布回到基线 `{low:1, medium:4, none:3, unknown:4}`,且 **MiMo 真实应答 4 家、零错误**(hermes 判 HIT,另 3 家 clear)。

### 真问题:403 的四种病因被压成一种

GitHub 用 `403`/`429` 至少表示四种**处置方式互斥**的情况:

| 情形 | 判据 | 该怎么办 |
|---|---|---|
| 主限流 | `x-ratelimit-remaining: 0` | 等 reset |
| 二级限流/滥用 | body 含 `secondary rate limit` | 退避,通常 1 分钟自愈 |
| **授权不足** | body 含 `Resource not accessible` | **token 配错,等多久都没用** |
| IP 级封禁 | 以上都不是 | 等一分钟自己好 |

旧代码 `return { ok: false, error: '限流 (HTTP 403)' }` —— **把响应体丢了**,四种情况长得一模一样。本次只能靠在外面一遍遍试(先怀疑 token、再怀疑代码、最后靠"等一分钟"猜出是 IP 封禁)。

现在按上表分类,并把 **GitHub 原话**拼进错误串。另加显式布尔 `rateLimited`:只有它为 `true` 才值得按 `retry-after` 重试,**授权问题重试多少次都没用**。`fetch.d.mts` 里刻意声明成字段而非从文案推断。

新增 `test/watch-fetch.test.ts` **10 个用例**,每条锁一种区分;含一个防退化断言:`/commits?per_page=` 只能出现一次。

### 顺带修掉一个哑雷

`fetchCommits` 的 URL 是 `?per_page=15&per_page=1` —— 重复键。GitHub 取第一个(15)所以**一直没暴露**,但代码下面明确是把整个 list map 成多行 changelog,一旦服务端改成取末值就会静默只剩 1 行。已改为单一 `per_page=15`。

### 服务器运维:`setup-watch.sh`

`tools/upstream-watch/setup-watch.sh`,把三个**手工才能记住**的运维坑固化成脚本(已实测跑通):

- **先验证 token 再动手** —— 打 `rate_limit`,`core.limit < 100` 直接中止。实测用假 token 在这一步退出,**不碰 pm2、不写 env 文件**(`qa-server` 的 restarts 计数全程不变)
- **从活进程 env 快照再叠加新变量** —— 原来只在 pm2 命令行给的 `LLM_*` 不会因这次配置而丢失
- **落盘 `~/.msql-watch-env`(600)+ `pm2 save`** —— 修掉一个此前没人发现的隐患:`LLM_API_KEY` 原本**零持久化**,服务器一重启就没了,而页面只显示「LLM 未启用」,**全程无任何报错**
- 每次写入前自动备份;verify 必须**同时**通过 401 与 200;只动 `msql-upstream-watch`,不碰 `qa-server`
- 脚本是**纯 ASCII**:它要经 PowerShell 管道送到 Linux 执行,中文/多字节字符会让远端 `sed` 引号失配(本次踩过)

---

## 2026-09-30 · 看板 LLM 判定可视化 + 一个自引入的渲染崩溃

把 LLM 判定提升为**一等公民**:卡片头部**白盒 / 黑盒 / LLM 三信号并列**,配色刻意做轻(暖橙而非红)——LLM 是语义判断,权威性低于黑盒的 schema 探测,不该看起来比它更可信。

**LLM 状态必须区分五种**,因为它们对使用者的含义完全不同:有影响 / 无影响 / **调用失败** / **按设计未调用**(规则判 low-none 省 token)/ **未启用**(服务端没配 key)。后两者不占头部徽章(否则满屏提示像故障),但用虚线弱提示区分——「没配」和「按设计跳过」是两回事。顶部统计新增「LLM 判有影响」计数,**未启用时整组不显示**,避免"0"被误读成"跑了但没问题"。

### 自查踩坑:验证方法本身有缺陷

`const ls` 定义在第 305 行却在第 300 行被使用,`const` 暂时性死区 → `card()` 一调用就 `ReferenceError` → **整列表渲染失败,用户只看到空页面**。

**根因不在代码,在验证方式**:当时只测了新增的 `llmState`/`llmBlock`,**没测被改动的既有函数 `card()`** ——恰好是后者出问题。等于验证了新增部分、漏了改动部分。修正后把整段页面脚本在 `vm` 里执行、用 mock `fetch` 喂真实 state 形状,验证 `render()`/`card()`/`match()` 全链路(5/5 不抛异常、列表填充 5 张卡、六个筛选各自正确)。**教训:改既有渲染函数必须整体验证,只测新增片段会漏。**

(附带坑:用正则替换多行箭头函数绑定会留下残骸导致 `Unexpected token '}'`。**不删代码、只 mock 依赖**才是验证页面脚本的正确姿势。)

### 用户截图暴露的另一个问题:GitHub 匿名限流

一轮抓取后 11/12 家变成「无法评估」,而改动前是 4 medium + 4 none + 4 unknown。排查确认是 **GitHub API 匿名限流**(60 次/小时,一轮要打 9 个仓库,反复点刷新即超限),连带 LLM 也没被调用(`evaluate` 对 unknown 短路,根本到不了 LLM 那步)。**配 `GITHUB_TOKEN` 提到 5000/小时即可**,已记入 DEPLOY。

**这条再次印证本项目的核心教训:静默失败是主要敌人。** 限流的表现不是报错,是「全部退化为无法评估」——看起来像功能没实现,实际是配额用完。

---

## 2026-09-30 · 第 3 期:本机黑盒探针上报 + 看板改浅色重设计

前两期把「上游漂移」变成主动可见。本期补上闭环的最后一环,并重做界面。

### 探针:把「确定答案」送上云端

云端只有白盒(关键词粗筛,必然有误报),黑盒探测真实数据才有确定答案——但黑盒**只能在有 agent 数据的机器上跑**(本机)。`scripts/upstream-probe.mjs` 负责接起来:①跑黑盒(通过 CLI 子进程,不 import,保持工具与生产代码解耦)②POST 云端 ③写 Markdown 报告到 `docs/upstream-reports/`,进 git 可 review。

**刻意不直接写 memories 表**——那是应用的数据目录,CLI 直写有并发风险。结论落 memories 仍由 agent 收工时用 `memory_log_progress` 做。

配套:`upstream/check.ts` 加 CLI 入口(`node --experimental-strip-types upstream/check.ts [--json]`),退出码区分 drift=1 / 检查器故障=2;`tsconfig` 开 `allowImportingTsExtensions` 并把 `upstream`、`scripts` 纳入 `include`(此前这两个目录基本没被类型检查)。

### 又一次「静默失败」:探针的假成功

首次联调探针打印「云端上报成功」,但 `state.probe` 是 `null` —— 数据根本没进去。两个缺陷叠加:

1. 探针 POST 到**站点根地址**而非 `/api/probe`
2. 服务端 `/` 分支**不检查 method**,照常返回 index.html + **200**

探针只看 `res.ok` 就判定成功。**假成功比直接失败更糟**——它会让人以为黑盒已经在云端上了。双向加固:探针自动补全路径**并校验响应体**(`ack.ok === true` 才算成功),服务端 `/` 分支限定 GET。

### 新增判定:checker_error(检查器自身故障)

CLI 直跑立刻暴露:动态 import parser 失败(`Cannot find module`)被判成「上游漂移」——**检查器的 bug 伪装成上游问题,会白白触发一次适配发版**。新增 `checker_error` 判定与 🟣 标记,把「工具坏了」和「上游变了」彻底分开。

### 看板改浅色 + 信息密度重构

不再是深色主题的翻版。**看板是长时间盯的工具,浅底降低眩光;「有问题」的行用左侧色条和高对比 badge 直接跳出来。**

- 每张卡同时显示**白盒 + 黑盒两个判定**(本期新增的双栏)
- 顶部 6 个统计块(白盒高/中/无风险/无法评估 + 黑盒漂移/检查器故障)
- 筛选:全部 / 只看需处理 / 黑盒漂移 / 闭源 / 本机未装
- 左侧色条三档:红(需处理)、黄(留意)、无边框(正常);`unknown` 整卡降透明度
- changelog 用等宽字体 + 限高滚动,命中词以 chip 展示;响应式适配窄屏

### 验证

typecheck 0 / vitest **199:199**(26 文件)/ build 通过 / 零新增依赖。端到端实测:探针写盘 + 上报「已接收 12 条」,云端 `/api/state` 返回白盒 12 + 黑盒 12,双栏逐项对齐。

### 补做:LLM 评估(此前是未验证交付)

用户追问「LLM 评估没做吗」——**代码写了但从未实际跑过**(服务器没配 `LLM_API_KEY`),等于交付了一条没验证过的代码路径。补做:

- **9 个 mock 测试**覆盖全部分支:无 key 跳过 / low-none 不调用(省 token)/ 正常解析 / **只能加严不能放松** / HTTP 错误降级 / 网络异常降级 / 非 JSON 降级 / prompt 必带依赖摘要
- **mock 当场抓出真 bug**:响应解析硬编码 Anthropic 格式(`content[0].text`),换成 OpenAI 兼容端点直接解析失败。已修:端点非 `anthropic.com` 时自动改用 Bearer 认证 + `choices[].message.content`,**第三方 provider / 自建网关无需改代码**
- **`scripts/check-llm.mjs` 真调自检**:`node scripts/check-llm.mjs`。**mock 证明不了 key/端点/模型名真的能用**,真调一次才算数;失败会打印四步排查方向。本机无 key,该脚本已验证「无 key 优雅跳过、退出码 0」,**真实调用待用户在服务器上跑一次**

**LLM 的两个设计约束**(别改坏):只对规则判 medium/high 调用;**只能加严,不能放松** —— LLM 说「没事」不会把规则判的 high 降级,但它的理由仍保留在看板里给人看。

### MiMo 适配(用户指定 provider,按官方文档核对)

用户用**小米 MiMo**。查官方文档后发现**原实现有两个对 MiMo 不兼容的点**,均已修:

| 文档要求 | 原实现 | 后果 |
|---|---|---|
| 认证头 `api-key: $KEY` | 只发 `Authorization: Bearer` | **401** |
| `max_completion_tokens` | 只发 `max_tokens` | 可能被拒 |

修法:非 Anthropic 端点**默认同时发 `Authorization` 和 `api-key` 两个头**(同一 key 挂两个头无副作用,可同时兼容 OpenAI/MiMo/自建网关),并同时发两个 max_tokens 字段;另加 `LLM_AUTH_HEADER` 可显式指定。响应解析两种格式都吃。

**顺带发现时效信息**:`mimo-v2.5-pro` / `mimo-v2.5` **将于 2026-10-21 下线**,预置默认用 `mimo-v2.6-flash`(用户选定;判断力更强可切 `mimo-v2.6-pro`,本用途每天仅 2~5 次调用,两者差别有限)。Token Plan 订阅用户端点是 `token-plan-cn.xiaomimimo.com`、key 前缀 `tp-`/`ttp-` 而非 `sk-`。

`scripts/check-llm.mjs` 加了 **4 个 provider 预置**(`mimo` / `openai` / `anthropic` / `deepseek`),`node scripts/check-llm.mjs mimo` 一键套用端点+模型,**key 一律走环境变量不落文件**。

测试 5 → **14** 个。过程中还纠正了自己的一个错误假设:我最初以为「不设 BASE_URL 走通用分支」,实际**默认端点就是 Anthropic 官方**,走的是 `x-api-key` 分支——测试如实反映真实行为。

### 又一个只在真机暴露的 bug:`check-llm.mjs` 在服务器上跑不起来

用户在服务器(Node **20.20.2**)执行时报 `ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".ts"`。根因:该 `.mjs` 脚本 `import` 了 TS 台账却没加 `--experimental-strip-types`,**而 Node 20 根本不支持该 flag**(22.6+ 才有)——加 flag 也救不了。

修法:**改读 `upstream/ledger.json`**(云端本来就在用它),脚本变成纯 `.mjs` + `.json` 依赖,Node 20 可跑。台账一致性仍由 `upstream-contract.test.ts` 在 CI 保证。

**教训:云端/服务器侧脚本一律不许 import `.ts`。** 顺手给探针加了 Node ≥22.6 前置检查(它要执行 TS 检查器,只有本机 Node 24 才行),失败给中文提示而不是让人看一堆 ESM 栈。

---

## 2026-09-30 · 看板部署上线(阿里云)+ 四个部署坑

服务已在阿里云跑通并对公网提供:`https://watch.logic-yjb.top`(子域名 + certbot HTTPS + nginx 注入 token header)。**踩了四个坑,全是"静默失败"型,值得记档。**

### 坑 1 · 提交没推送 → 服务器上根本找不到文件

本地 `git push` 没做,服务器 clone 的远端 main 不含 `tools/upstream-watch/`,报 `MODULE_NOT_FOUND`。**部署任何东西之前先确认已推送。**

### 坑 2 · 前台进程没退 → pm2 崩溃循环

先前按文档"前台跑看效果"起的那份进程还占着 8788,`pm2 start` 每次都 `EADDRINUSE` 崩掉(↺ 15,status `errored`)。**迷惑点:服务其实是活的**——`curl` 拿得到响应,只是活的是那个游离进程而非 pm2 管的。看到 pm2 errored 但 curl 有响应,先查端口占用(`ss -lntp | grep <port>`),别急着删 pm2 实例。

### 坑 3 · `pm2 --env` 静默失败 → 鉴权形同虚设

`pm2 start ... --env AUTH_TOKEN=xxx` 没把变量传进进程,结果 **`curl` 不带 token 也返回 200**——看板裸奔。**这种"配置没生效"不会报错,只会让你以为配好了。** 改用环境变量前缀方式启动更可靠:

```bash
PORT=8788 AUTH_TOKEN=$(cat ~/.msql-watch-token) pm2 start server.mjs --name xxx
```

**验证必须同时看两条:`no-token: 401` + `with-token: 200`。只看后者会以为没事。**

### 坑 4 · nginx 注入 token 的取舍

`proxy_set_header Authorization "Bearer <token>"` 让 token 永不出现在 URL / 浏览器历史 / access log,代价是**明文存在 nginx 配置文件里**(已 chmod 收紧)。若改用 `?token=` 则相反——token 会进 access log。**自用小服务的取舍:nginx 注入 + 文件权限控制。**

### 部署要点(下次照抄)

- 服务只监听 `127.0.0.1`,公网只能经 nginx —— 天然不暴露
- 子域名独立 `server` 块,**不碰现有 qa 站点**(同机器还跑着 qa-server,80/443 已被占用)
- token 存 `~/.msql-watch-token`(600),nginx 配置用 `sed` 从该文件注入,避免两处硬编码不一致
- `pm2 save` 必做,否则服务器重启丢失
- 实测抓取结果与本机**逐项一致**:opencode low / claudecode·qwencode·gemini·hermes medium / codex·kimicli·cursor none / 4 家闭源 unknown,**零误报**

**下一步(待定):** 第 3 期(本机探针定时上报黑盒 + 结论双写)/ 发 v0.5.6(连接向导修复对存量用户重要)/ 原有宣传与渠道待办。

---

## 2026-09-30 · 第 2 期:云端上游监控看板(阿里云,零依赖)

前三期把「上游漂移」从**用户报障才知道**变成**主动可见**。本期是最初那块「小程序」:一个汇总 12 家 agent 更新日志并评估影响面的网页看板。

### 台账 JSON 中间层

云端实测是 **Node v20.20.2**(跑不了 `--experimental-strip-types`,而本地是 Node 24 能跑),而台账是 `.ts`。解法:加 `upstream/ledger.json` 导出件 + `scripts/export-ledger.ts`(本地导出)。**云端因此保持零依赖纯 JS**。同步由 `upstream-contract.test.ts` 断言「逐字段一致」——忘导出会直接 CI 变红,而不是让云端悄悄拿着一份过期台账做评估。

### 云端服务(零依赖)

`tools/upstream-watch/`:`server.mjs`(http+鉴权+定时+原子写 state.json)、`fetch.mjs`、`evaluate.mjs`、`web/index.html`。**只依赖 Node 18+ 内置 http/fetch/fs,部署时无需 `npm install`**。环境变量:`AUTH_TOKEN`(公网必填)、`GITHUB_TOKEN`(限流 60→5000/h)、`LLM_API_KEY`(可选)、`REFRESH_HOURS=24`。部署说明见 `tools/upstream-watch/DEPLOY.md`。

### 抓取:四种上游形态实测

| 形态 | 家数 | 处理 |
|---|---|---|
| github(release 有正文) | 5 | 直接取 body |
| commit(release 无正文/无 release) | 2 | codex 的 release **正文全空**;cursor **0 条 release** → 退化 commit |
| npm | 1 | kimicli `MoonshotAI/kimi-code` |
| none(闭源) | 4 | 不抓,标「仅黑盒」+ 看板给**手动粘贴 changelog** 入口 |

**踩坑:** npm registry 不接受 GitHub 的 `Accept: application/vnd.github+json`,照抄会返回 **HTTP 406**,kimicli 一开始就是 0 数据 —— 已在 `fetchNpm` 覆盖 Accept。

### 白盒分级:两次调优压掉全部误报

初版用**单词级**强信号,真实跑下来 **4 家同时报 high,而无一与存储结构有关**:

- claude-code 命中 UI 提示里的 "rename it"、"markdown table"(排版)
- hermes 命中 "two-column ticket modal"(UI 布局)
- qwen-code 命中 "## Breaking Changes / **No known** breaking changes"(Keep a Changelog 固定段落,每个版本都飘红)

两轮修复:①强信号改**短语级**(`rename table` / `drop column` / `database schema`),单词级通用词全降为 medium ②加**否定句式**(`no known breaking changes` / `backwards compatible`)抵消。**修复后 0 家误报**,四家从 high 降到 medium/low。两次误报都用真实 changelog 原文写成了回归测试。

另修一个设计缺陷:分级词表原先**依赖台账收录**,导致台账漏收某词就永远升不了级 —— 改为内置词表直接扫文本,台账只管展示口径。

### 手动粘贴入口救活

首次实现时 `evaluate` 对 `blackbox_only` 直接短路返回 `unknown`,导致**给闭源 zcode 粘了明确的 breaking change changelog 仍返回 unknown**,手动入口形同虚设。改为「闭源且**没拿到** notes 才走仅黑盒」;现在粘贴后正确判 **high**,并保留「人工提供、该 agent 无自动监控」的提醒。

### 验证

typecheck 0 / vitest **190:190**(24 文件,第 1 期 169)/ build 通过 / **零新增依赖**。端到端实测:服务起于 8788,12 家全部抓取成功、网页 200;鉴权无 token → 401、带 token → 200;手动粘贴 zcode → high。`state.json`(含 changelog 原文)已 gitignore。

**已知代价:** 白盒是关键词匹配,必然残留误报,靠短语化 + 否定句式 + LLM 压制。**黑盒才是确定答案**,两者冲突时以黑盒为准。

**下一步:** 第 3 期(本机探针定时上报黑盒结果 + 结论双写 Markdown/memories)→ 或先在阿里云把服务跑起来看看实际效果。

---

## 2026-09-30 · 第 1 期:捕获失效可见化 + MCP 连接写后回读校验

第 0 期建了台账与黑盒检查,但**检测到漂移之后,产品本身仍是瞎的**——本期补上这条链路。核心是把两类「静默失效」变成显式信号。

### 1. 捕获健康度(静默失效的总开关)

**根因**:`capture-factory.ts` 的增量 watcher 解析失败时**只写日志**,`lastStatus` 压根不更新。而 `lastStatus` 是 UI 的唯一数据源 —— 于是上游一改格式,每条新会话都解析失败,面板却始终显示「N 条会话 / M 扫描」。**这不是某个 adapter 的 bug,是整个捕获层的反馈缺失。**

`CaptureStatus` 新增 `health`(`unknown`/`healthy`/`suspect`/`failing`)、`consecutiveFailures`、`lastFailureAt`、`lastFailureDetail`、`lastSuccessAt`。判定阈值 **3**(`_lib/capture-health.ts`):1~2 次判 `suspect`(给偶发留空间:文件写入中、权限抖动),≥3 判 `failing`;任意一次成功立即归零。

**修掉的静默点(共 4 处,不止 factory 一处):**
- `capture-factory` 增量 watcher 失败 —— 只写日志
- `capture-codex` 增量失败 + **单文件解析失败**(独立实现,未并入 factory)
- `capture-zcode` 增量失败 + 单文件解析失败
- `capture-hermes` **库读取失败**(最隐蔽:它在 scan 内部,失败后 scan 仍返回「成功」,连 `lastError` 都不会有,UI 显示正常而实际零捕获)

后三者补了「全部失败 vs 部分失败」区分:全部失败才升级为连续失败,部分失败只作提示,避免个别坏文件造成误报。

### 2. MCP 连接写后回读校验

`connectAgent` 过去写完就报「已连接」。现在写完**回读校验**:按台账声明的 jsonpath 定位条目、检查必需键与取值,不过则 `configured=false` 并把原因摊给用户(`AgentConnectResult.verifyError`)。TOML(codex)/ YAML(hermes)不做 JSONPath 校验,故未挂。

`verify` 的期望值全部取自台账(不另写一份),并**把 URL 替换成 `<url>`** 再返回,避免把本机端口/配置路径泄进面向用户的报错(有测试守着)。

### 3. 顺手抓出并修正台账 7 处与代码不符

写「每个连接器写出的配置必须能通过台账校验」这条断言时,**当场抓到台账自己的错**:zcode 实为 `mcp.servers`(台账写 `mcpServers`)、cursor 实为 `mcpServers`(台账写 `servers`)、claudecode 实为 `type+url`(台账写 `command/args` 且 note 还停留在早已废弃的「仅支持 stdio 需桥接」)、kimicli 实为 `~/.kimi/mcp.json`+`{url}`、zcode/codebuddy/workbuddy 的必需键同理。**台账写错,校验就形同虚设** —— 已全部按代码(权威)修正。

### 4. UI 三态区分

设置页过去把「agent 没装」和「agent 装了但我们读不懂」渲染成同一个「未检测到」,**而这两者该采取的行动完全相反**(前者什么都不用做,后者要适配发版)。现在按 `level` 分档:`dim` 未安装 / `ok` 正常 / `warn` 偶发失败或扫到 0 条 / `bad` 连续失败(加粗+红)。新增 `.agent-state.warn/.bad` 样式,颜色走 token。

### 验证

typecheck 0 / vitest **169:169**(24 文件,第 0 期为 150)/ build 通过。零新增依赖。

新增测试 19 个:`capture-health.test.ts` 11(阈值/归零/截断)、`agent-connect.test.ts` +7(回读校验 6 条 + **台账↔连接器一致性**)、台账 jsonpath 统一为 `$.` 前缀。

**过程中的一次失误值得记:**我曾用 PowerShell 脚本批量改 `agent-connect.ts`,`Set-Content -Encoding utf8` **破坏了文件里的中文**(注释变乱码)且插入位置错误。`git checkout` 回滚后改用 edit 工具重做。**教训:改含中文的源文件不要用 PowerShell 批量写,一律用 edit 工具。**

**下一步:** 第 2 期云端看板(阿里云;纯 Node 无 native 依赖;每日抓一次;LLM key 走 env,失败降级纯规则;token 鉴权)。

---

## 2026-09-30 · 上游契约台账 + 黑盒漂移检查(第 0 期,为「上游监控看板」打地基)

用户提出真实痛点:各 agent 更新频繁,导致捕获/MCP 失效且**静默**,总等用户报障。规划四期(台账+黑盒 → 失效可见化 → 云端抓取+LLM → 探针上报+结论双写),本期落第 0 期。方案评审记录见 `.opencode/plan/upstream-watch.md`。

**关键前置发现(推翻了规划时的两个假设):**
1. **`test/fixtures/` 根本不存在** —— AGENTS.md 目录结构里写的「脱敏真实会话样本」是**文档失实**,现有 21 个测试的样本全部**内联在 .test.ts 里**。因此「可复用现有 fixture 基线」不成立。
2. **跑旧 fixture 价值有限** —— 它只能验证「我的代码没退化」,而这正是 vitest 已在做的事。**黑盒的真实价值在于探测真实数据的 schema 漂移**。据此重新设计:SQLite 源**只探测 schema**(快、稳、直击要害),JSONL 源才真调生产 parser 解析样本。前者正是被 opencode 2.x 咬过的那类问题(`no such table: session`)——schema 探测能在解析器崩之前就发现。

### 交付物

- **`upstream/agents.ts` 契约台账** —— 12 家 agent 的上游地址/changelog 类型/监控模式/本地源/依赖的表与列/MCP 必需键/风险词。**写成 .ts 而非 YAML**:项目零依赖风格,顺带获得类型检查与注释能力。新增 `${AGENT} 安装位置漂移` 的正确解法:`localRoots` 支持 `{ resolver }`,路径探测复用生产代码(如 hermes 调 `resolveHermesHome`),**台账不重复实现探测逻辑**。实测立刻见效:resolver 找到 hermes 在 **D 盘**,而 AGENTS.md 记的是 **G 盘**——硬编码路径果然已经过期。
- **`upstream/check.ts` 黑盒检查** —— 判定四态:🟢 匹配 / 🔴 漂移 / 🟡 源不存在 / ⚪ 仅黑盒(闭源)。支持 `tablesAnyOf` 多代布局并存(legacy 三表与 v2 双表同时算绿),漂移时**点名缺哪些表/哪些列**。
- **`test/upstream-contract.test.ts`** —— ①真实数据无漂移 ②台账自洽 6 项(id 唯一、tracked 必须有上游源、sqlite 必须声明表、jsonl parser 必须已注册、mcp 必须声明必需键、风险词非空),防台账腐化。
- **`test/upstream-selftest.test.ts`** —— **检查器自身的自测**:用合成库模拟上游改 schema(表改名/删列/空库/zcode 跟随迁 v2),断言**判红且指名缺什么**。没有这层,一个永远返回 ok 的检查器等于没有检查器。
- `npm run upstream:check` 看彩色表格;CI 已自动覆盖(见下)。

### 上游可得性实测(决定了双轨设计)

| 梯队 | 家数 | 情况 |
|---|---|---|
| API 直抓有正文 | 5 | opencode / claudecode / qwencode / gemini / hermes |
| 可抓但形态特殊 | 3 | codex(release 正文全空,需 commit)、kimicli(0 release)、cursor(0 release) |
| **闭源无任何公开日志** | **4** | qoder / codebuddy / workbuddy / zcode —— 官方仓库全 404 |

**修正一处错误记录**:`MoonshotAI/Kimi-Dev` 已归档失效,正确仓库是 **`MoonshotAI/kimi-code`**,台账已改并留注。

### CI 语义(重要,勿误读绿灯)

`npm test` 已含契约测试,CI 自动跑。但 **CI runner 上没有任何 agent 数据目录,漂移检测那一半会全部判 absent 而空跑** —— CI 真正守住的是「台账自洽性」,不是真实漂移。测试里已显式 `console.warn` 说明,不制造「全绿=检查过」的错觉。**真实漂移必须在开发机跑 `npm run upstream:check`**,或等第 3 期的本机探针定时上报。ci.yml 已加注释说明。

**验证:** typecheck 0 / vitest **150:150**(23 文件,原 21)/ build 通过。**零新增依赖** —— 曾试 `vite-node` 但它拖进 rolldown+lightningcss+数十个平台 binary(lock +724 行),已回滚,改用既有 vitest 承载(`package.json` 仅加一行 script)。

**下一步:** 第 1 期(捕获失效可见化:`capture-factory.ts:135-137` watcher 失败只写日志不更新 `lastStatus`,是「静默失效」的根因)→ 再议第 2 期云端看板。

---

## 2026-09-30 · 修 OpenCode MCP 连接器(v2 必填 `type`)+ 滚动条观感修复

用户报「opencode 识别不到 MCP」。根因不在服务端,在**本项目自己的连接向导写错了 opencode 配置格式**。

### 1. OpenCode MCP 连接器(v0.5.5 已发版,现修)

`~/.config/opencode/opencode.json` 里向导写的是 `{ url, enabled }`,**缺 `type`**。OpenCode ≥2.0 起 `type` 为必填(官方文档 Options 表 Required=Y),配置规范化阶段直接把这条判为 legacy 并**静默丢弃**——只留一行 WARN,用户侧完全无感:

```
level=WARN message="configuration normalization diagnostic"
  path=$.mcp.memorysql kind=unsupported
  action="omitted enabled-only legacy MCP entry"
```

日志实测**从 2026-09-25 起持续刷**(即坏了约 5 天,非今日新增)。症状:opencode 会话里 memorysql 的 7 个工具整个不出现,agent 查不到任何历史知识,只能像本次一样手搓 HTTP 兜底。

**修复(`src/main/core/agent-connect.ts` opencode 连接器):** `apply()` 与 `snippet()` 均补 `type: 'remote'`;snippet 追加一行注释说明缺失后果。**存量用户的 legacy 配置会被同一入口自动修复**(连接向导 `setNested` 整体覆盖 `mcp.memorysql`,重跑一次即补齐)。本机 `~/.config/opencode/opencode.json` 已手工修正并留备份 `opencode.json.bak-before-mcp-fix`。

**验证:** `opencode mcp list` → `memorysql  connected`;`memory_list_sessions` 实际调用返回会话 #233。新增 `test/agent-connect.test.ts` 4 用例(写入含 type / 修复 legacy 条目 / 保留无关键 / snippet 带 type)锁死回归。**typecheck 0 / vitest 134:134(21 文件,原 130)/ build 通过。**

### 2. 滚动条观感(用户截图反馈)

- **太细抓不住**:旧规则 9px 轨道 + 2px `border` + `background-clip: content-box`,净可见滑块只剩 **5px**。改为 12px 轨道 + `background-clip: padding-box`,净宽 **8px**。
- **hover 高亮**:旧 0.1→0.18 太弱。新增三态:常态 `rgba(255,255,255,.16)` → hover `.34` → **按下时用主题色 `--msql-accent`**,并加 `--msql-t-fast` 过渡。
- **底部白色方块**:Chromium 默认给竖向滚动条两端画 stepper 按钮、横竖交点画 corner,深色主题下渲染成突兀白块。新增 `::-webkit-scrollbar-button { display:none }`、`::-webkit-scrollbar-corner/resizer { background:transparent }` 抹除。

**验证边界:** typecheck/build/单测全绿,CSS 已确认编译进产物;**视觉验收由用户 2026-09-30 在 dev 模式确认「滚动条没问题」**(补记:dev 数据目录**不是**真库,见下条「dev 环境两个坑」)。

### 3. dev 环境两个坑(实跑 dev 日志后查清,均非故障)

- **dev 数据目录 ≠ 真库。** `src/main/core/env.ts:23-27` 走 `app.isPackaged` 分支:装机版用 `%APPDATA%\memorysql\data`,**dev 用仓库内 `F:\桌面\MemorySQL\data`**(故 dev 日志 `vault indexed: 13 notes`,而真库 36 个 md)。dev 完全隔离,不会污染 95MB 真库;`data/` 已 gitignore。
- **dev 下 MCP 是 8 个工具而非 7 个。** 多出的是 `data/plugins/hello`(2026-08-30 外部插件功能示例)注册的 `hello_greet`。**文档口径「MCP 工具 7 个」对装机版成立**,dev 下多此一项,看日志勿误判。

---

## 2026-09-30 · v0.5.5 装机验收 + 全量会话对账(无代码增量)

用户要求「读取 memorysql 相关会话更新当前项目情况」。走 MCP 拉会话时踩到两个坑,顺带查清并留档;**代码零改动**,`main` @ `4396ed6` 工作树干净,typecheck 0 / vitest **130:130**(20 文件)。

**坑 1:MCP 索引与真库不是同一个。** 仓库内 `data/memory.db`(62MB)是开发副本且**已过期**——里面 opencode/zcode 的 id 只到 #221,而 9/22 之后的新会话一条都没有。实跑的应用读的是 `%APPDATA%\memorysql\data\memory.db`(**95MB**,236 会话)。**教训:查历史会话一律走 MCP 或 `%APPDATA%` 真库,别信仓库里的 `data/`。**

**坑 2:`started_at` 是「秒」,`updated_at` 是「毫秒」。** 直查库按毫秒解读 `started_at` 会全部显示 1970-01-21,极易误判成时间戳损坏。实为**刻意设计且全链路自洽**:写入侧每个 parser 都 `Math.floor(t/1000)`(`claude-/codex-/qwencode-/zcode-parser` + `_lib/agent-db-parser.ts:47` 的 `epoch()`),读取侧 `App.tsx:42 fmtTime` 统一 `new Date(ts*1000)`,MCP 工具亦同。**但这个约定没写进 `docs/architecture.md`,是文档缺口**——新写查询的人一定会踩(本次即踩)。建议后续在数据模型章节补一行单位说明。

**v0.5.5 装机验收(对应上一条列的三个验收点):**
- ①**自动更新链路真实验收通过** —— `%LOCALAPPDATA%\memorysql-updater\pending\` 存有完整下载的 `MemorySQL-Setup-0.5.5.exe`(**177,318,979 字节**,与 `latest.yml` 声明 size 逐字节一致)+ `current.blockmap` + `update-info.json`(sha512 齐全)。装机时间线也对得上:应用 11:42 重启、更新包 11:56:53 下载、11:57:15 落盘。**0.5.4 → 0.5.5 走的是 electron-updater 自动收取,不是手动装**——这正是 v0.5.3 加的「进度条 + 立即重启安装/稍后」链路的首次真实闭环。
- ②**OpenCode 2.x 捕获在装机版确认可用** —— 当前这次会话(#233)正由 `D:\MemorySQL\MemorySQL.exe`(ProductVersion `0.5.5`)实时摄入,消息数随对话增长,cwd 识别为 `F:/桌面/MemorySQL`。v2 schema 适配在真实运行环境下无回归。
- ③WorkBuddy/Qoder 无法本地验收(本机未装,合成样本已覆盖,维持 0.5.4 原判)。

**捕获矩阵健康(以 `updated_at` 为准,真库 236 会话):** opencode 20(最新 09-30 02:59)/ codex 25(09-30 02:50)/ zcode 39(09-29 03:55)/ hermes 49(09-22)/ claudecode 103(09-11)。memories 38、notes 36。**claudecode 自 9/11 起 19 天无新会话**——需确认是 Claude Code 本机已停用,还是 Desktop 元数据源路径失效(下条待办)。

**对账结论:无未落地的代码增量。** 9/22–9/23 的 opencode 会话 #216/#213/#214(启动更新)已随 v0.5.3 落地、#217(capture 插件模式)已随 v0.5.4 落地,与 AGENTS.md 既有结论一致;本轮无新增结论需要改写。

**下一步(优先级重排):** ①查 claudecode 19 天无新会话的原因 ②用户过目真实库截图 02-07 → 按 `docs/promo/checklist.md` 发帖 ③winget 0.5.x 版 PR(盯 microsoft/winget-pkgs#426778)④mcp.so 催收录 ⑤评估 Comate Zulu 适配。

---

## 2026-09-29 · **v0.5.5 已发版**:OpenCode 2.x 适配 + 更新进度条/安装询问

内容 = 本日两条:OpenCode 2.x schema 适配 + 更新下载进度条/完成后询问安装。流程:bump → 本地 dist 烟测(unpacked `--hidden` 起活)→ tag 直连推送一次成功 → 双矩阵 CI 全绿(4 job)→ **本次 electron-builder 把 7 资产一次传齐**(0.4.x 时代只传上 blockmap 的坑未复发),latest.yml 声明 size 与 exe 实际一致(177318979 字节)→ `publish-release.mjs` 转正(单草稿无需删重)。https://github.com/Logic647/MemorySQL/releases/tag/v0.5.5 `latest.yml` 公网已指向 0.5.5。

**装机后的验收点(下一步):**①本版装好后,后续新版的「进度条 + 立即重启安装/稍后」全链路首验(即自动更新真实验收);②OpenCode 2.x 捕获在装机版确认;③WorkBuddy/Qoder 适配(0.5.4 遗留)。

---

## 2026-09-29 · 更新体验:下载进度条 + 完成后询问是否重启安装

用户需求:更新(自动+手动)加进度条;安装包下载完成后弹窗询问「立即重启安装 / 稍后手动重启」,替代静默处理。

**状态机(`update-check.ts`):**新增 `progress` 事件(percent/transferred/total,percent 截到 0-100)与 `UpdaterState.progress`;`downloaded`/`error`/`not-available`/`probe-not-available` 都清掉 progress(失败不留陈旧进度条)。

**main(`index.ts`):**`wireAutoUpdater` 挂 `download-progress` → setUpdater 广播(自动/手动两条路共用);`updateNow` 去掉 `downloadUpdate()+quitAndInstall()` 静默直装,只 checkForUpdates(autoDownload=true 自动开下),完成后由 `update-downloaded` 事件驱动 UI 询问;新通道 `updateInstallNow` = quitAndInstall(setImmediate 先答 IPC 再退出)。

**渲染层:**应用壳横幅——下载中显示进度条+百分比,"已下载"加「立即重启安装」按钮;新增**更新就绪弹窗**(modal,按版本号记「稍后」,新版本会重新询问;稍后 = 关闭弹窗,退出时 autoInstallOnAppQuit 仍自动安装);设置页关于区——进度条+MB 进度行、「立即重启安装 vX」按钮、手动按钮改为「下载更新包 vX」(语义不再是一键直装)。

**验证:**typecheck 0 / vitest **130:130**(progress 设置/截断、downloaded 清条、失败清条+保住 availability)/ build 通过。

---

## 2026-09-29 · OpenCode 2.x SQLite 新 schema 适配(修复 "no such table: session")

用户报:opencode 更新后 MCP 检测到但无法连接,报 `SqliteError: no such table: session`。真库(本机,更新后 13MB+8MB WAL)核实:opencode ≥2.0 把权威库从三表 **session/message/part** 迁到 **session_v2 + session_message**——parts 不再独立成表,内嵌进消息 JSON(assistant = `content[]` 数组,元素 `{type:'text'|'reasoning'|'tool'}`,tool 部分字段名从 `tool` 改为 `name`,输入在 `state.input`;user = 顶层 `.text`;`idle`/`synthetic` 行非真实轮次要跳过;另有 `project` 表 worktree 作项目根)。

**修复(`_lib/agent-db-parser.ts`,共享解析器):**打开库后按 `sqlite_master` 探测布局——legacy `session` 优先 → `session_v2` → 都没有返回 `[]`(未来再改 schema 也不再抛);v2 路径:session_v2 列名与旧 session 相同(id/directory/title/time_*)直接复用 SessionRow,角色取 `type` 列,消息按 `seq` 排序;`part` 预编译语句只在 legacy 分支创建(v2 无此表)。兼容矩阵:**zcode(旧三表)零影响**、opencode 新旧两代、storage/ JSON 树回退保留。

**验证:**typecheck 0 / vitest **128:128**(新增:v2 夹具全字段断言含 onlySessionId、未知 schema 返回 [] 不抛)/ 真库端到端:解析 3 会话(cwd= F:/桌面/temp、标题、user/assistant/tool 角色齐全)→ `npm run import:scan` capture-opencode `sessionsImported: 3, lastError: null`。

**下一步:**不变(见 AGENTS.md 2026-09-29 对账条:真机验收 v0.5.4 → 宣传发布 → winget 0.5.x → Comate Zulu)。

---

## 2026-09-23 · 新适配 + **v0.5.4 已发版**:WorkBuddy + Qoder CLI/CN 会话捕获与 MCP 连接

**v0.5.4** 含 WorkBuddy 与 Qoder 两条适配 + capture-factory `watchPaths(sourceRoot)` 微调;CI 双矩阵全绿,7 资产 https://github.com/Logic647/MemorySQL/releases/tag/v0.5.4(typecheck 0 / vitest **126:126**)。两家本机未装,合成样本单测覆盖,装机后 `MEMORYSQL_DATA_DIR` 隔离真机扫一次。

### Qoder CLI / Qoder CN(本条实现细节)

**本机未装** → 按官方文档(Claude 兼容 JSONL)实现。

**存储(国际版 `~/.qoder/`、中国版 `~/.qoder-cn/`,env `QODER_CONFIG_DIR` / `QODERCN_CONFIG_DIR` 可覆盖):**
- `projects/<flattened-path>/<session-id>.jsonl` — 会话日志(Claude Code 同构:type user/assistant、message.content string|parts)
- `projects/<flattened-path>/<session-id>/state.json` — 会话状态(title/name/custom_title、cwd)
- MCP:`settings.json` 的 `mcpServers.memorysql = { type:'http', url }`(或 `qoder mcp add`)

**调研结论(国内缺口清单):**
- **Qoder/Qoder CN**:高优先,已做本条
- **Comate Zulu CLI**(`@comate/zulu`,历史在 `~/.comate-engine/store/chat_session_*`):高优先,后续
- **iFlow CLI**:2026-04-17 已停服并迁 Qoder → **HANDOFF 待办 5 作废,不再适配**
- CodeGeeX / 商汤小浣熊:IDE/云端为主,未见本地会话格式,低优先

**实现:**
- `capture-qoder` 插件:复用 `parseClaudeJsonl(..., 'qoder')` + `readQoderState` 补 title/cwd;`qoderRoots()` 默认布局同时扫 `.qoder` 与 `.qoder-cn`(去重 externalId);`isQoderSessionFile` 只收 `projects/<slug>/*.jsonl`;watcher 增量 `.jsonl`
- **capture-factory 微调**:`watchPaths` 函数签名改为 `(sourceRoot) => string[]`(自定义根与孪生目录都能正确 watch,已有适配器零参数兼容)
- 注册:`types.AgentType 'qoder'`、BUILTIN_PLUGINS、App 侧栏、Settings(PLUGIN_DESC/CAPTURE_AGENTS/CONNECT_AGENTS)、badge
- MCP 连接器 `qoder`:detect `.qoder`/`.qoder-cn`,写 `settings.json` 的 `mcpServers.memorysql`

**验收:** typecheck 零错 / vitest **126:126**(新增 qoder state 合并与路径过滤 1 用例)。

### WorkBuddy(同版,见上一日实现记录)

`capture-workbuddy` 扫 `~/.workbuddy/projects/**/*.jsonl` + `workbuddy.db` 元数据;MCP 写 `mcp.json`。合成样本 5 用例。

**下一步:** ①装机后真机验收 WorkBuddy/Qoder 与 0.5.3→0.5.4 自动更新 ②评估 Comate Zulu 适配 ③用户过目截图 → 宣传发帖 ④winget 0.5.x 版 PR 跟进

---

## 2026-09-22 · 新适配:腾讯 WorkBuddy 会话捕获 + MCP 连接

**本机未装** → 按官方/社区公开存储架构调研实现,合成样本单测覆盖(格式来源:workbuddy-conversation-exporter、workbuddy-workspace-migration SKILL、mcp.json 文档)。

**存储(`~/.workbuddy/`):**
- `workbuddy.db` — SQLite `sessions(id,title,cwd,created_at ms,…)` + `workspaces`,元数据权威
- `projects/{slug}/{conversationId}.jsonl` — 消息日志:`{type:'message', role:'user'|'assistant', content:string|[{text}], timestamp:ms, cwd}`,用户侧常包 `<system-reminder>…<user_query>…</user_query>`
- MCP:`mcpServers.memorysql = { url, disabled:false }` → `~/.workbuddy/mcp.json`

**实现:**
- `capture-workbuddy` 插件(工厂模板):`collectWorkbuddy` 扫全部 JSONL + `openForeignDb` 快照读 db 补 title/cwd/created_at;watcher 同时匹配 `.jsonl` 与 `workbuddy.db(-wal|-shm)`(单文件变化:jsonl 增量解析、db 变更全量重读);`watchPaths` 函数化
- `parseWorkbuddyJsonl`:只收 `type=message` 的 user/assistant 文本轮,剥 system-reminder 取 `user_query`;tool/非 message 跳过
- 注册:`types.AgentType`、BUILTIN_PLUGINS、App 侧栏、Settings(PLUGIN_DESC/CAPTURE_AGENTS/CONNECT_AGENTS)、badge
- MCP 连接器:`detect ~/.workbuddy`、`mcp.json` mergeJson 写 `mcpServers.memorysql`

**验收:** typecheck 零错 / vitest **125:125**(新增 `workbuddy-parser` 5 用例)。真机验收待装 WorkBuddy 后 `MEMORYSQL_DATA_DIR` 隔离扫一次。

---

## 2026-09-22 · Bug 修复 + **v0.5.3 已发版**:启动自动检测更新 + 项目/会话重命名不同步

**用户报两个 bug:**①启动时自动检测更新没有正确实现;②项目文件夹及会话重命名后会话内不同步。**v0.5.3** 含本条全部修复与审查项;7 资产 https://github.com/Logic647/MemorySQL/releases/tag/v0.5.3

### ① 启动自动更新链路修复

**根因(三层):**
- 启动检查走 `checkForUpdatesAndNotify()`(github.com/…/latest.yml,代码自注"常被墙"),失败被 `.catch(() => {})` 静默吞掉;`loadUpdater` 抛错的外层 `catch` 也不写 `updaterState.error` → UI 完全无感
- 手动「检查更新」走 `api.github.com`(另一条通路,能通)→ 体感"启动没在检测"
- 错误状态机遮蔽:UI 条件 `error && available === undefined`,一旦同进程内先收到过 `update-available`,后续 error 永不显示;`update-not-available` 也不重置 `downloaded`

**修复:**
- 新纯函数模块 `src/main/core/update-check.ts`:`verParts`/`isNewer`/`probeGitHubRelease`(api.github.com 可用性探测)+ `applyUpdaterEvent` 状态机 reducer(probe/error/downloaded/not-available 事件,错误不吞已确认的可用性、冷检查失败必露出)
- 启动改为 `startupUpdateCheck()`:先 probe api.github.com → 写状态 + `push:update-status` 推 renderer;确认有新版再 `wireAutoUpdater` + `checkForUpdates()` 拉下载;probe 失败时以 electron-updater 兜底。全程失败进 `updaterState.error`,不再静默
- 手动 checkUpdate/updateNow 同样写状态机并推送
- Renderer:`api.onUpdateStatus` 订阅 `push:update-status`;**应用壳新增更新横幅**(有新版/已下载待装,顶栏下方);Settings 错误提示改为只要 `error` 就显示(去掉 `available === undefined` 遮蔽)
- 抽测:`test/update-check.test.ts` 14 用例(版本比较、状态机遮蔽回归、probe 成功/失败、probeConfirmed 权威性 2 例)

### ② 项目/会话重命名不同步

**根因(两层):**
- `ingest.ts` `content_hash` 只哈希消息、**不含 cwd/title**;hash 相同 → L155 直接 `skipped` → 外部 agent 改了 title 或文件夹改名后 cwd 变了,解析器读到的新值被闸门丢掉,UPDATE 永远执行不到
- `projects` 以 path 为自然键、**无 rename 路径**:文件夹改名 = path 变 → `ensureProject` 查不到就 INSERT 新行,旧行旧 name 永久残留 → UI 一半旧名一半新名

**修复:**
- **轻量元数据更新**:hash 相同但 title/cwd/project_id 有变 → 只 UPDATE 这三列(+ title 变时重建 `sessions_fts`),不重写消息;`title_locked` 本地改名保护保留
- **cwd 信任规则**:adapter 报的 cwd 仅在磁盘上真实存在时采纳(或本行尚无 cwd),防止改名后的陈旧路径把刚 re-home 的会话打回去
- **`ensureProject` 收养**:path 查不到时,扫同父目录下 path 已不存在的孤儿项目行——同 basename 优先,否则同父目录下唯一孤儿(文件夹改名典型形态)→ UPDATE 该行 path/name 并 **bulk re-point 仍挂旧 path 的会话**;同名但旧 path 仍活着(不同父目录的同名文件夹)则正常 INSERT 不收养
- `capture-opencode` 补 watcher:`CaptureSpec` 新增 `watchPaths` + `watch.rescan`,db 变更即全量重读权威库(此前只靠启动/手动扫描)
- 抽测:`test/ingest-sync.test.ts` 6 用例(不变跳过、外部改名同步、title_locked 保护、文件夹改名收养不叉分组、兄弟会话 re-home、同名活项目不误收养)

### ③ 审查修复(review-agent,3 findings)

- **P1 探测遮蔽回归**:`UpdaterState.probeConfirmed?: boolean`——`probe-available` 置 true、`probe-not-available` 与非探测 `not-available` 置 false;`not-available` 仅在 `probeConfirmed && available` 时只刷 `checkedAt`,不清已确认的可用性(electron-updater 滞后的 latest.yml 不再把已知新版盖掉)
- **P2 UI 状态互斥**:应用壳横幅三分支(downloaded → error → 下载中,`App.tsx`);Settings `upStatus` 四段互斥(downloaded / 下载中无 error / available+error 下载失败 / 无 available 的 error),不再出现横幅与设置页矛盾
- **P3 watcher 延迟解析**:`CaptureSpec.watchPaths` 支持 `string[] | (() => string[])`,start 时 resolve,空数组=显式 defer 不回落 sourceRoot;`capture-opencode` 删模块级 `opencodeDb`,db 路径改函数解析,match 放宽到 `opencode.db(-wal|-shm)?$/i`

**验收:** typecheck 零错 / vitest **120:120**(新增 20:update-check 14 + ingest-sync 6)。

**注意:** 本机 GUI 若为安装版,需等下版发布后吃到修复;开发库已验证。外部 agent 若自身不更新 session.directory(多数 opencode 系在创建时写死),旧会话要等 agent 侧改路径或新会话带新 cwd 才会触发收养。

---

## 2026-09-21 · v0.5.2 发版:SQLite 权威存储适配上线 + 发版脚本化

- **v0.5.2 已正式发布**: https://github.com/Logic647/MemorySQL/releases/tag/v0.5.2 —— CI 双矩阵 4 job 全绿,7 项资产(Windows 三件套 + Linux 四件套)本次由 electron-builder **合并在同一份草稿**内(0.5.1 时是 main/tag 各建一份),`scripts/publish-release.mjs` 校验后转正 + notes
- **内容**:ZCode/OpenCode SQLite 权威存储适配(项目识别修复)+ GUI 启动自动扫描;详见上一条 DEVLOG
- **发版流程沉淀**:`scripts/publish-release.mjs <tag> <title> <notes-file>` —— 找 tag 草稿 → 保留资产最多的一份、删重复 → 转正 + notes;token 取 git credential store,repo 从 origin 自动解析。此后发版收尾一条命令,替代此前每次手搓 API 调用
- **自动更新链路**:latest.yml / latest-linux.yml 均指向 0.5.2;0.5.1 装机启动即静默收取(Windows),Linux updater 走 latest-linux.yml

---

## 2026-09-20 · ZCode/OpenCode 权威存储迁移适配(SQLite)+ 启动自动扫描

**用户反馈两个问题:**①ZCode 新建 money 项目未被识别;②opencode 连接向导能检测到、会话捕获却"未检测到"且扫不出会话。

**根因(同源):**两家都是 opencode 系(ZCode 是 opencode 的 fork),已把权威会话存储迁到 **SQLite 三表结构**(`session[id,directory,title,time_*]` + `message[data JSON{role,time}]` + `part[data JSON{type:text|tool|reasoning|…}]`):
- ZCode:`~/.zcode/cli/db/db.sqlite` —— money 项目就躺在里面(`directory: H:\桌面\temp\money`);rollout 里的 model-io 只是 API 调用日志,**多数不带 cwd** → 项目分组失败;且应用没开时的会话只能等手动扫描
- OpenCode:`~/.local/share/opencode/opencode.db` —— 旧适配器找的 `storage/` JSON 三目录树已不存在 → "未检测到"实锤;本机实库 6 会话 44 消息(含"检查 MCP 状态"等真实对话)

**修复:**
- 新共享解析器 `_lib/agent-db-parser.ts`:`parseAgentSqliteSessions(dbPath, agentType, onlySessionId?)` —— openForeignDb 快照读锁库,text part 聚合为正文、tool part 转工具消息(toolName+input)、reasoning/step-finish 跳过、system 角色跳过;cwd/标题/时间全量携带;**externalId 用会话原生 id(sess_*/ses_*),与旧 model-io 导入同键 → 旧数据自动升级**(补上 cwd 与完整消息)
- capture-zcode v2:db.sqlite 存在则 db 为主;rollout watcher 保留作活动信号——事件文件名带会话 id,按 `onlySessionId` 从权威库增量重读单会话(不做全库重扫);db 缺失(旧版 ZCode)回落 rollout 直读
- capture-opencode:db 优先(`~/.local/share/opencode/opencode.db`、`%LOCALAPPDATA%\opencode\opencode.db` 双候选),旧 JSON 树兜底;sourceExists 同步
- **GUI 启动自动扫描**:main 启动后后台跑全部 capture-* 的 scanNow(此前只有 watcher 增量 + 手动扫描,应用离线期间的会话永远进不来)

**验证:**typecheck 零错 / vitest **100:100**(新增 3 用例:含 sequence 与不含两种 fixture、cwd/标题/时间戳/文本聚合/工具映射/空会话跳过/按 id 过滤/db 不存在返回空)/ 真机扫描:zcode 14 found(7 新 + 7 旧数据升级)、**opencode 6 会话入库**、**money 项目出现**(#41,4 会话:含 zcode 与 codex)
**注意:**用户 GUI 若为安装版,其库在 `%APPDATA%\MemorySQL\data` —— 需等下个版本发布更新后才能吃到本次修复;开发库(H:\...\data)已验证全通

---

## 2026-09-17 · 交接快照 docs/HANDOFF.md

v0.5.1 发版收尾后写 `docs/HANDOFF.md`:发布渠道现状(Release 7 资产/CI 双矩阵/winget #426778 人工审查队列/mcp.so 待催)、0.4.2→0.5.1 工作回顾、待办清单(用户:过目截图→发布宣传;agent:winget 跟进、iFlow、PTY tee)、遗留技术债、发版流程与网络工具知识、Antigravity MCP 接入结论(`~/.gemini/config/mcp_config.json`,stdio 桥优先)。AGENTS.md 必读文档表已挂链接。

---

## 2026-09-17 · v0.5.1 发版:Linux 跨平台双矩阵发布 + 对话导入插件

- **v0.5.1 已正式发布**: https://github.com/Logic647/MemorySQL/releases/tag/v0.5.1
- **CI 双平台全绿**: GitHub Actions 矩阵构建 (`windows-latest` + `ubuntu-latest`) 并行成功，一次性自动产出并上传 7 项发布资产：
  - Windows: `MemorySQL-Setup-0.5.1.exe` (169.1MB) + `.blockmap` + `latest.yml`
  - Linux: `MemorySQL-0.5.1.AppImage` (385.6MB) + `memorysql_0.5.1_amd64.deb` (274.5MB) + `memorysql-0.5.1.tar.gz` (377.1MB) + `latest-linux.yml`
- **核心更新包含**:
  1. Linux 原生版本支持（AppImage / deb / tar.gz 及原生 C++ 模块隔离编译）
  2. `import-chat` 插件（主界面粘贴/文件导入会话，覆盖 SQLCipher 加密的 Trae CN、云端不落盘的通义灵码及网页端聊天）
  3. 设置页应用内自动更新状态透出（已下载待装 / 下载中 / 错误提示，解决静默下载被漏掉问题）

---

## 2026-09-17 · Linux 跨平台构建与发布支持 (AppImage / deb / tar.gz)

- **electron-builder.yml**: 增加 `linux` 配置，发布目标涵盖 `AppImage`、`deb`、`tar.gz`，设置 `category: Development`、`icon: build/icon.png`
- **src/main/index.ts 窗口适配**: Linux 桌面环境（GNOME / KDE / XFCE）的窗口管理器普遍不支持 Windows/macOS 的 `titleBarOverlay`（WCO），若直接隐藏原生标题栏会导致窗口无边框、无最小化/最大化/关闭按钮且无法拖动。通过 `process.platform === 'linux'` 环境分支，在 Linux 下保留默认系统窗口装饰，仅在 Windows/macOS 启用隐藏标题栏及 `titleBarOverlay`
- **.github/workflows/ci.yml 矩阵构建**:
  - `ci` 与 `package` job 均引入 `matrix: [windows-latest, ubuntu-latest]` 矩阵
  - 原生 C++ 模块（`better-sqlite3` 等）在打包前通过 `npx electron-rebuild` 在各原生操作系统环境（Windows / Ubuntu glibc）下自动编译
  - 分平台构建命令与产物隔离：Windows 生成 `MemorySQL-Setup-*.exe`，Linux 生成 `*.AppImage` / `*.deb` / `*.tar.gz`
- **package.json**: 增加本地/WSL 快捷脚本 `"dist:linux": "electron-vite build && electron-builder --linux"`
- **验证**: `npm run typecheck` 零报错；`vitest` 97/97 单元测试全绿；main/preload/renderer 三 bundle 构建成功

---

## 2026-09-13 · 中文宣传物料包(docs/promo/)

- **新增 docs/promo/**:`v2ex.md`(分享创造首发帖,作者自述口吻,标题候选×3)/ `juejin.md`(技术向,含"各家会话存哪"干货表)/ `shaoshupai.md`(产品体验向)/ `jike.md`(短帖×2)/ `checklist.md`(发布顺序、渠道注意事项、评论区 Q&A 预案、winget 跟进)/ `screenshots.md`(8 张必截图清单,命名与 README 嵌图绑定,放 `design/screenshots/`)
- **README**:新增「界面一览」嵌图段(01/02 两张,图未截时挂链,截图放入即生效);特性「7 家 agent」更正为 10 家(v0.5.0 实际)
- **MCP_LISTING.md**:数据核对至 v0.5.0(`memory_log_progress` 补 `agent?` 参数,其余 6 工具签名与 `core-schema/mcp-tools.ts` 一致);新增目录提交状态与表单:**mcp.so 立即可提**(chatmcp/mcpso Issue,英文模板已备)/ **PulseMCP 暂停收录**(官网公告重构流程,盯重开)/ **Smithery 形态不匹配**(面向可分发 server,本地桌面应用暂缓)
- **口径注意**:宣传稿只写 v0.5.0 已发布内容;import-chat、updater 状态栏是 tag 之后提交、尚未发版,首发物料一律不提(screenshots.md 里 10 号图已标注)
- **截图实况(同日晚些)**:CDP(`--remote-debugging-port=9222` + `Page.captureScreenshot`)自动截取 01/02/03/04/06/07 共 6 张入 `design/screenshots/`;**01 用演示库**(`MEMORYSQL_DATA_DIR` 临时目录 + 合成 codex rollout×2 + MCP memory_write 种画像/记忆,项目 caffeine-tracker 全虚构,可公开);真实库续接包含学校/服务器 IP 等隐私,终端图严禁用真实库。**05 图谱放弃**(13 节点/1 链接 + 标题是 auto-devlog HTML 注释);08 待用户手动截。真实库 5 张 UI 图顶栏可见未发版的「导入对话」按钮(import-chat),发布前知悉。05 放弃后各渠道分配未受影响。待办:发布前用户过目真实库截图 → commit/push → 按 checklist 发布;细节与复现步骤(点击横幅/MoveWindow 取景)见 `docs/promo/screenshots.md` 顶部状态注记
- **提交推送实况(同日)**:`b61d529` 直推 main 成功(物料 + 6 截图 + 文档),GitHub raw 嵌图验证 200;**mcp.so 收录申请已提交**(chatmcp/mcpso Issue #1 评论 [issuecomment-5653232123](https://github.com/chatmcp/mcpso/issues/1#issuecomment-5653232123),token 走 credential store 走 API,无 gh CLI)。几天后没见收录去催一次。**剩余人工步骤**:用户过目真实库截图(02-07,预检已过)→ 按 checklist.md 发布(V2EX 周二~周四上午首发)→ 手动截 08 项目日志(可选)
- 下一步:**用户过目截图 → 按 checklist.md 发布(V2EX → 掘金/即刻 → 少数派)**、验收自动更新(0.4.2 装机启动即应静默收 0.5.0)、winget bot 跟进(0.5.0 版 PR)

---

## 2026-09-12 · 国内 agent 适配:Qwen Code + Kimi CLI + CodeBuddy Code

**调研先行**(本机三家均未安装,格式从官方文档/源码确认,2026-09 时点):
- **Qwen Code**(QwenLM/qwen-code,Gemini CLI fork,读源码):`~/.qwen/projects/<proj>/chats/<sid>.jsonl`(旧版 `tmp/<id>/chats/`),JSONL 树,`type: user/assistant/tool_result/system`,`message.parts` 为 GenAI 线格式({text}/{functionCall}/{functionResponse}),`isSidechain` 子代理
- **Kimi CLI**(MoonshotAI,官方文档+源码):`~/.kimi/sessions/<md5(cwd)>/<uuid>/context.jsonl`(旧版平铺 `<uuid>.jsonl`),kosong Message 行({role, content: string|parts, tool_calls?}),`_` 前缀角色=元数据,`state.json` 有 custom_title,**无逐条时间戳**(用文件 mtime);MCP 配置 `~/.kimi/mcp.json`
- **CodeBuddy Code**(腾讯,官方文档):`~/.codebuddy/projects/**/*.jsonl`,**与 Claude Code 同构**;MCP 配置 `~/.codebuddy/mcp.json`
- **不可行排除**:Trae CN(会话库 SQLCipher 加密,密钥只在进程内存)、通义灵码(会话云端不落盘);iFlow CLI 可行但版本差异大,留作后续

**实现(3 插件全走 capture-factory):**
- `capture-codebuddy`:`parseClaudeJsonl` 加可选 agentType 参数直接复用(含 CODEBUDDY_CONFIG_DIR 重定向)
- `capture-qwencode`:新解析器(parts→文本、functionCall→tool 消息、tool_result 的 functionResponse→tool 消息、跳 sidechain/system);发现逻辑只认**父目录为 chats 的 .jsonl**(新旧布局通吃,排除 checkpoints/shell_history/debug/plans)
- `capture-kimicli`:新解析器 + 新旧两版目录发现;state.json 的 custom_title 做 title;content 防御式(string/parts 兼容,ThinkPart 跳过)
- 接线:AgentType 字面量 ×3、BUILTIN_PLUGINS、设置页(PLUGIN_DESC/CAPTURE_AGENTS)、连接向导(AGENT_CONNECTORS ×3:qwen=stdio、kimi={url}、codebuddy=http;已查文档确认各配置路径)、badge 样式;**顺手修 App.tsx 侧栏 CAPTURE_PLUGINS 残缺问题**(原来只有 codex/zcode/hermes 三个,claudecode/gemini 等从不在侧栏过滤里)补全为 10 个

**验证:** typecheck 零错 / vitest **91:91**(新增 5 用例)/ **隔离端到端**(`MEMORYSQL_DATA_DIR` 临时目录 + 假数据源 + 真实 ingest 管线):5 会话全对入库——codebuddy 1(标题取首条 user)、kimi 2(custom_title 生效+legacy 布局)、qwen 2(新旧布局+functionCall/functionResponse→tool 消息,thinking 跳过)/ 真机全量扫描 10 插件共存零错,存量数据(103/13/44/16)不受影响
**注意:** 三家本机未装,格式置信度基于 2026-09 文档/源码;真实数据如有出入,补 fixture 修解析器即可(防御式解析,坏行不致命)。测试用例中 qwencode 标题落到 "(no user message)" 是摘要器"首行≥6字符"启发式的正常行为(测试字符串太短),非 bug

**同日发版 · v0.5.0:**`npm version 0.5.0` → tag v0.5.0 → **直推成功**(重要:新机器网络下 github.com:443 直连已恢复,`git push` 秒通,服务器 bundle 中转流程退役;与 08-31 记录的"直连全断"是不同网络环境)→ CI 双 job 绿(ci 4m;package 11m)。**发版坑(与 0.4.1/0.4.2 同源但形态不同):**package job 的 if 条件含 `refs/heads/main`,所以 main 推送与 tag 推送**各建了一个 0.5.0 草稿**(main 那个只有 2 件、tag 那个三件套齐);本机 gh CLI 缺失,改走 API(凭据取 git credential store):删重复草稿 → 齐全草稿 PATCH `draft=false` + notes 转正。**三件套公网验证齐**(exe 169MB→下载 177MB/blockmap/latest.yml→0.5.0),`releases/download/v0.5.0/latest.yml` 可达。**本版即自动更新验收版**:0.4.2 装机下次启动应静默收 0.5.0。顺手清理观察:历史 0.4.1/0.4.2 草稿仍在(未删,不影响公开页)

**自动更新验收实况(用户反馈"重启没收到提示"):**诊断反转——`%LOCALAPPDATA%\memorysql-updater\pending\` 里躺着 0.5.0 安装包(177MB,恰为用户重启时刻),**启动检查其实成功了**:checkForUpdatesAndNotify 静默下载完成,唯一通知是系统 toast(被错过);安装发生在**下次退出**(autoInstallOnAppQuit 默认开),即"退出一次应用=装上新版",手动检查走 api.github.com 所以显示正常。体验缺陷修掉:updaterState 跟踪(available/downloaded/error)+ 新通道 `memorysql:host:updateStatus` + 设置页「关于」15s 轮询常驻显示"已下载待安装/后台下载中/检查失败"——此修复随下个版本发出(0.5.0 的启动行为不变)

**对话导入插件(import-chat,加密/云端 agent 的通用正门):**讨论定调:加密存储(Trae SQLCipher)不走"撬锁"(内存抓密钥/TLS 中间人/UIA 抓屏——脆弱+杀软误报+ToS 风险),走正门 = 人能看到的就能进库。实现:`parseConversation` 启发式解析(角色行识别:中英文 token/Markdown 加粗/标题/方括号,**冒号后同行内容并入消息体**——首轮实现丢同行内容被单测当场抓掉;内容里的"注意:xxx"不会被误判,token 白名单过滤),支持平铺 `[{role,content}]` JSON、无标记文本整体作为用户侧单条;externalId = `imported:<sha256 前 16 位>`(同内容重复导入幂等);agentType `imported`,标题用户可填/缺省走摘要器。UI:顶栏「导入对话」按钮 + 弹窗(粘贴 textarea / 文件选择 md·txt·json·log / 标题),复用现有 modal 样式。**覆盖面:一切"人能看到的对话"——Trae、通义灵码、网页版聊天、ChatGPT 桌面版全部可用,代价是不自动(手动一次性导入)。**验证:typecheck 零错 / vitest 97:97(新增 6 用例)/ 三 bundle 构建绿 / 插件加载零错

---

## 2026-09-11 · 换机适配:Hermes/Codex 路径自愈 + Claude Desktop 会话捕获

**背景:** 用户换机(项目 `F:\桌面` → `H:\桌面`,用户目录 `C:\Users\18144` → `C:\Users\Logic`)后反馈:Hermes desktop 无法识别;Claude desktop 无法识别且开启会话捕获后记忆界面也无显示。

**根因与修复(4 项):**
- **Hermes 路径失效:** settings 里 `capture-hermes:profilesRoot` 还是旧机 `D:\…`,新机装在 `G:\Hermes Agent CN Desktop`(注册表 InstallLocation 实锤;0.7.0 新布局 state.db/memories 直接在 hermes-home 根,代码本就兼容)。修复:`resolveHermesHome` 探测链 = 已配置(存在则用)→ 注册表 InstallLocation → 全盘符 `X:\Hermes Agent CN Desktop\data\hermes-home` → 用户主目录,命中后回写配置;探测失败时 scan 返回 available=false + 明确 lastError
- **Claude Desktop 无对话正文(Anthropic 设计如此):** 桌面版(数据目录 `%LOCALAPPDATA%\Claude-3p`)通过 Agent SDK 驱动内置 claude.exe,**transcript 从不落盘**(`~/.claude/projects` 空、MSIX 包目录/IndexedDB/local-session 均无)。可捕获的只有两样:`claude-code-sessions/<acct>/<slot>/local_*.json` 会话元数据(sessionId/cliSessionId/cwd/title/createdAt/lastActivityAt)+ `~/.claude/history.jsonl` 每条交互提示(display/project/sessionId/timestamp)。修复:capture-claudecode 改三源合并——完整 transcript(存在时)> 桌面元数据(零消息会话,带标题,cwd 可归组项目)> history 按 sessionId 分组的提示会话;`cliSessionId` 命中 history 时合并去重,transcript 命中时跳过 history 行
- **codex 未走 capture-factory:** capture-factory 加了"配置 sourceRoot 失效自动回退默认路径"(治所有走 factory 的适配器),但 capture-codex 是独立实现漏掉了——单独补上同款回退(旧机 `C:\Users\18144\.codex\sessions` → 本机 `~/.codex/sessions`)
- **ingest LLM 浪费:** 自带标题或零消息的会话直接跳过 summarizer(否则本次 95 个 history 会话 = 95 次 LLM 调用)

**验证:** typecheck 零错 / vitest **86:86**(新增 8 用例:桌面元数据解析与无 sessionId 拒绝 / local_*.json 文件发现 / history 分组与 skipSessionIds / resolveHermesHome 三分支)/ 真实库 `import:scan`:**claudecode 103 入库**(8 桌面元数据 + 95 history 分组)、**codex +2**(本机 9 月会话)、**hermes +1**(G: 新实例)、**记忆候选 +7**(distill:claudecode×6 + zcode:70——记忆界面恢复显示)
**遗留:** 桌面版会话无对话正文是上游限制(元数据行点了进去是空的,标题/项目/搜索可用);history.jsonl 只有用户侧无回复;claudecode watcher 只盯 `~/.claude/projects`,桌面版新会话要等下次启动/手动扫描;`capture-codex` 后续可考虑并入 capture-factory 消除重复

---

## 2026-09-02 · 内存占用治理(7 项)+ 开机自启动

用户反馈"运行内存随使用越来越大"并要求设置页加开机自启动。探索代理全量排查后按影响落地 7 项优化 + 1 个新插件:

**内存优化(A1–A7):**
- **A1 GraphView cytoscape 泄漏(确定性):**每次"重新布局"新建实例而旧实例永不销毁(destroy 闭包被丢弃)→ 改 cyRef 持有,重建前先 destroy
- **A2 语义索引增量同步(启用语义时的主因):**旧 sync 在每次 30s 防抖后全量读所有记忆+会话文本重算 hash → 改 `semantic_meta` 水位(`wm_memory`/`wm_session`),只读 `updated_at ≥ 水位` 的候选;移除检测改 LEFT JOIN 源表( tombstone/retired/文本变空必删,与水位无关,顺带修了"状态改 retired 但文本没变漏删"的隐患);全量路径保留给 `--reindex`(hash 幂等,实测二次 embedded=0)。**旧库平滑升级:**无水位时 wm=0 全量候选 + hash 跳过,零迁移
- **A3 embedder 空闲释放:**ONNX arena 峰值不归还 OS → 每 5min 检查,空闲 15min 释放 InferenceSession(带 busy 计数防使用中释放),下次懒重建
- **A4 会话消息 tail 分页:**旧 sessions:get 无上限,大会话一次拉全部消息(单条上限 100KB)→ 默认尾页 200 条 + `hasMore/firstSeq/total`,`beforeSeq` 上翻;详情页加"加载更早的消息"按钮;**顺带修 P0 级存量 bug:privacy-export 传 `{sessionId}` 而 handler 读 `{id}`(会话导出一调即抛),且导出必须 `all:true` 全量**
- **A5 记忆列表分页:**memories:list 加 limit/offset(默认 500),MemoriesView 加"加载更多"
- **A6 memory_get_session O(n²)→线性:**循环内 join 判界改累计长度预算
- **A7 单实例锁:**GUI 路径 requestSingleInstanceLock,二实例聚焦已有窗口;headless(--scan/--sync 等)不受锁,可与 GUI 并行

**开机自启动(core-launcher 插件):**
- `app.setLoginItemSettings` 即时生效,Windows 落注册表 Run 键;`--hidden` 启动参数 = 开机只驻留托盘(托盘点击/秒搜热键唤起,MCP 照常);设置页「通用 · 启动」双开关(乐观更新);开发模式 supported=false(注册的是 electron.exe);`launchItems` 匹配自身可执行文件读回已注册参数
- 遵循"一切功能皆插件",BUILTIN_PLUGINS 注册,PLUGIN_DESC 补中文

**验证:**typecheck 零错 / vitest 78:78(新增:增量只 embed 新行、retired 免时间戳移除、sessions:get 四分页用例、memories:list 分页)/ import:scan 真实库无错 / --reindex 全量路径真库验收(rows=83 幂等)

**同日补丁 · 检查更新报错修复:**设置页「检查更新」报 `Cannot read properties of undefined (reading 'checkForUpdates')`。根因:electron-updater 的 CJS 入口用 `Object.defineProperty(exports, name, {get})` 定义全部导出,Node cjs-module-lexer 识别不了 → ESM `import('electron-updater')` 命名空间**没有命名导出**,updater 只在 `.default`(= module.exports)上,`const { autoUpdater } = import(...)` 解构出 undefined(node 实验实锤)。**且启动时静默自动更新和 updateNow 同坑,即自动更新链路自始未真正工作过。**修复:`loadUpdater()` 兼容取值;`checkUpdate` 改走 api.github.com releases 比对 semver(更新日志同款通道);`updateNow` 补 checkForUpdates 再 download;启动检查同步修。

**同日发版 · v0.4.2:**bump + 本地 dist 烟测(unpacked `--hidden` 后台起 → MCP 顺延 8643 响应正常 → **启动即见 `Checking for update` 拉到 latest.yml,证实互操作修复生效且下载域本机可达**)→ tag v0.4.2 bundle 推送 → CI 双 job 绿。**坑(与 0.4.1 同款):**electron-builder 在 CI 的 publish 只上传了 blockmap 就结束(job 仍绿)→ 从 artifact(run download,177MB 三件套)用 `gh release upload --clobber` 补齐 → 转正 + notes。**Release 三件套验证齐**(exe 177MB/blockmap/latest.yml→0.4.2),`releases/download/v0.4.2/latest.yml` 公网可达。装 0.4.0/0.4.1 的机器需手动装本版(旧版更新链路是坏的),本版之后可自动更新。
**遗留(记录):**列表虚拟化(react-window)、capture-* watcher 全目录 watch 与全文件重读、sync-folder 旧 bundle 无限累积(裁剪超 2000 后还会重放)、索引水位毫秒边界依赖 updated_at 单调;winget 新版本 PR(每版一个,等 0.4.0 PR 版主)+ scoop bucket autoupdate 自动跟
**下一步:**验收自动更新(0.4.2 手动装好后,下一版静默收)→ MCP 目录登记 → 推广首发帖(材料已备)

---

## 2026-08-31 · 全局代码审查:P0×2/P1×5 修复 + P2 清扫 + UI 走查三轮落地

**审查方法:**审查子代理全量过 src/plugins(44 文件)并交叉核对 main/core 调用链;主进程与渲染层由主 agent 结合当日全部 diff 自审;发现逐条在代码中验证后采信。

**P0×2(已修复):**
- **upsertMemory 绑定参数回归(本日引入):**v4 加 tags/project_id 时只改了 addMemory,upsertMemory 仍绑 7 参数(占位符 9)→ **Hermes 记忆导入/自定义 agent 导入/distill 提炼三条链路全灭**,且提炼失败中断事件链导致扫描重复报错。已补参数+接口同步+复现验证。**实库影响:**当日实库漏掉的记忆在重启+重扫后自动补回
- **归档导出泄漏 API Key(铁律 2):**.msqlv 原样打包 settings.json(含 LLM key)。导出时递归剔除 *Key 字段(导入端已容忍掩码值)

**P1×5(4 修复 + 1 需决策):**
- reindex 不再清空 similar_to(保护用户手工续接;自动标记只回填 NULL 位)
- Cursor 会话 startedAt 用 endedAt 兜底(修复 COALESCE 秒/毫秒混用导致的置顶与过滤失效)
- sync 合并尊重 title_locked(多机同步不再打回手动改名)
- 云同步脱敏 = **确认项方案(用户定)**:syncNow 被 `sync-folder:plaintextAck` 门控,设置页同步区块加确认 checkbox,「立即同步」未确认时禁用
- ~~sync-folder 云同步明文~~(即上条,方案落地)

**P2 清扫(已修 8 项):**capture-watcher remove 解绑 watcher(per-entry unwatch);MCP Host 精确匹配(127.0.0.1/localhost/[::1]:port 集合);sessions:get 滤 tombstone;summarizer-llm 与 memory-core refine/conflicts 发送前过 redactWithCount(铁律 2);sync 台账滚动 2000;zcode 去重键加行序(同文本新轮不再误伤);opencode legacy externalId(当前代码已不存在,不适用);阈值注释漂移(已随 P1-3 修正)

**UI 走查三轮(同日)落地:**①Agent 过滤去徽章留纯文字、白标题栏移除(titleBarStyle hidden + 深色 titleBarOverlay,顶栏可拖动);②精准拖入任意两会话之间(v6 sort_key 中点键,sessions:move IPC)+链式折叠双按钮(展开/收起)+选中特效强化+relay 整链移动(递归 CTE);③全部开关乐观更新(受控组件被 sessions:changed 重渲染拉回的通病,根因经渲染进程探针实证)+设置分类侧栏独列+字号间距+1+应用内品牌图标换用用户设计的 M+MCP 使用指引+MCP Host 精确匹配

**验证:**typecheck 零错 / vitest 71:71 / 构建三产物 / 真机走查(图标、拖拽、开关、设置布局)
**下一步:**发 v0.4.1(首个可验收自动更新的版本,含 P0 修复)→ winget bot 跟进 → demo 实拍(暂缓)

---


## 2026-08-31 · 用户需求批量落地:功能改进 + 重复会话治理 + UI 重构(Obsidian Glass Console)

用户提出一批需求(经可行性评估 + 四问确认后执行),三批完成:

**批1 功能:**CI tag 触发自动 Release(push v* 即发版);设置页六分类(通用/会话捕获/智能引擎/同步与备份/插件/关于);插件管理中文一句话说明;备份/分发/日志路径展示+一键打开;「关于」页(版本/手动检查更新+下载安装/GitHub+邮件双反馈通道/更新日志拉 GitHub API);会话列表按项目分组(all=项目→agent 二级,agent 筛选=项目);会话重命名(v5 加 title_locked,自动摘要永不覆盖,FTS 同步);会话归档开关(v5 加 archived,默认隐藏可切换)。迁移 v5 = title_locked + archived + similar_to。

**批2 重复会话三层治理:**核心在 semantic-search——sync 返回新嵌入会话 id;similarSessions() KNN 找近邻;插件标记 `similar_to`(两个信号:同标题精确匹配兜底 + cosine ≥ 0.85 且候选早于自身、同项目优先);手动 reindex 重置全量补标。UI 项目组内接力会话默认折叠为「↩ N 条接力会话」+ 行内「↩ 续 #id」徽标。**调参实录:**首跑 0.72 过标(58/63,小语料同项目全串+KNN 缺时间方向出互标)→ 0.85 + started_at 约束 → 35 标记逐一核验全为真接力(丢失占位串/transcript 注入/重复审查/明确续接)。

**批3 UI 重构「Obsidian Glass Console」:**ui-ux-pro-max design-system 定调(Developer Tool/IDE → Dark OLED + Swiss 极简 + 液态玻璃硬性要求)+ JetBrains Mono/IBM Plex 字阶。全部样式 token 化(styles/tokens.css `--msql-*`,换肤=覆盖 :root,保留其它设计方向);56px lucide 图标栏替代文字导航(emoji 图标清除);深色玻璃面板(blur 18-26px + 1px 亮边 + inset 高光)覆于漂移极光渐变上;紧凑 4px 间距阶;Ctrl+1..5 视图快捷键;入场 stagger/reduced-motion/焦点环/滚动条全按 checklist。真机截图验收:会话分组/接力折叠/设置分类/记忆视图全部正常。

**用户走查第二轮反馈落地(同日):**接力会话改为**紧跟被续接会话之后**的链式排序(多跳安全,替代折叠);支持拖拽会话到项目分组头(动态建项目/拖回未分配=清除);续接手动管理(行内「设为续接」弹出同项目选择器 / relay 行「取消续接」);重命名与归档操作改常显(此前悬停隐藏导致用户以为没做);导出备份成功后自动打开备份文件夹;备份目录/分发目录可自定义(sync-archive/mem-dispatch 各自 settings 键);记忆/笔记/图谱三视图统一改用侧边栏布局;字号整体+1、chips 间距加大;应用图标重绘为深色圆角+蓝菱形(纯 JS 生成 icon.png/ico 四尺寸,窗口/打包全部引用)。

**设计决策保留项(用户要求):**风格与导航均采用 skills 定夺版但保留其它三个方向(专业工具流/知识库文档流/控制台科技风;侧导航+项目一级/顶部Tab+项目树/命令面板优先),后续可能切换——token 架构即为支撑这点。

---


## 2026-08-31 · M8 收尾:CI 双绿 + scoop bucket 上线 + winget PR 已提

- **CI 首跑双绿**(4m47s/4m53s):ci + package 两 job 全过,GitHub 端每次 main 推送产出 167MB 免安装包 artifact
- **scoop bucket 上线**:https://github.com/Logic647/scoop-bucket(memorysql.json 带 SHA256 与 blockmap 自动哈希;README 使用说明)——`scoop bucket add logic647 https://github.com/Logic647/scoop-bucket && scoop install memorysql`。仓库创建与文件直传全走 Contents API(绕开本机 git 网络限制)
- **winget PR 已提**:microsoft/winget-pkgs#426778(`Logic647.MemorySQL` 0.4.0,NSIS x64,SHA256 与 Release 资产一致)。路径:fork → api 建分支 → Contents API 传三件 yaml → gh pr create。**坑:**gh pr body 里反引号会被 shell 命令替换执行(把 winget 帮助文本打进 body)——body 一律用 `--body-file`;validation pipeline 排队中,bot 反馈评论后按需改分支。**首轮验证失败已迭代:**三件 manifest 各缺 `# yaml-language-server: $schema=...` 头注释 → SchemaHeaderNotFound ×3;补上对应 version/installer/defaultLocale schema 头重传(PR 更新自动触发重跑)。**坑:**Contents API 更新已有文件必须带当前 blob 的 `sha`(GET 获取);管线已推进到 URL Domain/Installers Scan/Installation Validation 阶段
- **发布素材**:docs/DEMO.md(60 秒分镜脚本)+ docs/MCP_LISTING.md(目录登记全套),已推送
- 推送通道:github.com:443 直连仍被墙,继续走服务器 bundle 中转(其间服务器连接也抖动,scp/ssh 带 ConnectionAttempts=5 重试)

**M8 剩余:**winget bot 验证迭代(被动等评论)、demo 实拍(用户暂缓)、自动更新验收(等 0.4.1)。

---

## 2026-08-31 · M8 第一批:CI + 自动更新 + 发版清单(待推送发 Release)

**GitHub Actions CI**(`.github/workflows/ci.yml`,windows-latest):
- `ci` job:push/PR 必跑 `npm ci → typecheck → vitest → build`(测试跑 node-ABI better-sqlite3,在 electron-rebuild 之前)
- `package` job:main 推送时 `electron-rebuild → dist → 上传产物`(exe + blockmap + latest.yml)——每个 main 提交都有可下载构建

**自动更新接线:**
- `npm i electron-updater`;electron-builder.yml 加 `publish: { provider: github }` → 打包产出 `resources/app-update.yml`(已验)与 `dist/latest.yml`(已验)
- 主进程 packaged 态启动时 `checkForUpdatesAndNotify()`(autoDownload,离线静默失败;dev 模式不检查)
- 0.4.0 安装包已含 updater;**首次真实拉取验收要等 v0.4.0 Release 发出后**(旧版无 updater,从 0.4.0 起的后续版本才能被更新到)

**`docs/RELEASE.md` 发版清单:**标准流程(bump → 烟测 → tag → `gh release create` 三件套 exe/blockmap/latest.yml)+ winget 提交步骤(winget-pkgs PR,YamlCreate 三件套)+ scoop bucket manifest 模板 + MCP 目录/中文社区发布素材。

**坑:**electron-builder 重打包时残留的 MemorySQL.exe 占用 `win-unpacked` → EBUSY,先杀进程再 dist。

**待办(需用户确认):**push main(本地累计 M5.2→M8 共 16 个 commit)+ `gh release create v0.4.0` 三件套;之后验收自动更新、提交 winget/scoop。

**同日完成(推送与发版):**
- 直连 github.com:443 全断(reset/timeout,重试无效;api.github.com 与 22 端口 SSH 通)→ 走**服务器 bundle 中转**(用户 QA 项目同款流程):`git bundle`(main + tag)→ scp 阿里云 → 服务器 `git clone bundle` → `git push gh origin/main:main`。**坑:**bundle 无 HEAD,clone 不建本地分支,push 要用 `refs/remotes/origin/main` 显式 refspec
- 本机 gh 的 token 缺 `admin:public_key` scope,本机 SSH 密钥无法自动登记(设备授权端点也被墙)——后续想本机直推需人工补 scope 或在网页登记密钥
- **v0.4.0 Release 已发**:exe + blockmap + latest.yml 三件套上传成功(uploads.github.com 可达),CI 在 GitHub 端自动触发 ✓
- 自动更新真实拉取的验收要等下一个版本(0.4.0 是第一个带 updater 的版);winget/scoop 提交素材在 docs/RELEASE.md

---

## 2026-08-31 · M7 收尾:实库启用语义检索 + 设置页开关 + LLM 冲突检测(M7 完成)

**实库启用(用户委托):**settings 加 `semantic-search:enabled: true` + 拷贝 91MB 模型缓存 + `MEMORYSQL_DATA_DIR` 指向实库 headless `--reindex` 预建索引(**66 行向量**:10 记忆 + 56 会话)——下次启动应用即全量生效,无需再下载。

**语义检索设置页开关:**设置页新增「语义检索(本地向量)」区块 = 运行状态行(模型/维度/已索引进度)+ 启停 checkbox(`memorysql:host:pluginSetting` 写键,重启生效)+「重建语义索引」按钮(实时生效,反馈嵌入/移除/总数)。

**LLM 记忆冲突检测(M6 治理遗留,最后一项):**
- 纯函数 `memory-core/conflicts.ts`:`buildConflictPrompt`(编号记忆列表 + 严格判定说明:只找真矛盾,补充/细化/跨项目不算)+ `parseConflictResponse`(围栏剥离、无效 id/自反/缺 reason 过滤、镜像对去重)
- IPC `memory-core:detectConflicts`:LLM 可用性检查(未配置 → 明确降级提示)→ 取最近 60 条 active+candidate → LLM 判定 → 返回矛盾对 + 双方摘录;**只报告不自动处置**(治理铁律,人在 UI 裁决)
- 记忆页「冲突检测」按钮 → 结果面板:每组矛盾显示双方摘录 + 理由 + 一键「停用 #id」
- UI 点检说明:真机走查时应用正实时捕获本会话(列表秒级刷新),像素点击帧持续失效——两条新 IPC 通道逻辑已被单测与无头运行覆盖,**设置页/记忆页两处新 UI 留待用户打开即见**

**SQLCipher:⏸ 暂缓决策**(architecture.md §8):需换原生构建(破坏 ABI/归档/同步兼容)+ 密钥管理新攻击面;个人本地场景磁盘加密已覆盖主要威胁模型。触发再评估条件已写明。

**验证:**typecheck 零错 / vitest **70:70**(新增 conflicts×5)/ 构建 3 产物 / 实库 headless reindex 66 行成功。
**M7 完成**(自动 DEVLOG + 托盘秒搜 + 语义检索;SQLCipher 显式暂缓)。版本 **0.4.0**。**下一步:M8** 打包分发(安装包 + winget/scoop + electron-updater + GitHub Actions CI)、demo 与发布。

---

## 2026-08-31 · M7 第三块:语义检索基建完成(默认关闭,待用户确认启用)

- **新插件 `semantic-search`**(sqlite-vec 0.1.9 + fastembed 2.1,bge-small-zh-v1.5 / 512 维 / ~100MB 模型):向量化**活跃记忆 + 会话(标题+摘要)**,vec0 虚拟表 KNN;`semantic_refs` 用独立自增 id 做 rowid(memory 与 session 的 id 空间会撞号,踩过)
- **默认关闭,模型下载是显式动作**:`settings.json` 的 `semantic:enabled: true` 才启用;模型(~100MB)在**首次 sync/search 时才下载**(缓存到 `<dataDir>/fastembed-cache`),启动零开销;vec0/fastembed 任一失败 → 插件降级为不可用,`memory_search` 纯 FTS 照常(铁律 3)
- **memory_search 混合召回**:字面未命中时语义补足,命中行带 `·语义` 标注;agent/kind/project/since 过滤对语义命中同样生效;UI 搜索未接入(下轮)
- 索引同步:ingest/sessions:changed 后 **30s 防抖**增量 sync(content-hash 比较,只嵌变化行);IPC `status`/`reindex` 备 UI 用
- 验证:typecheck 零错 / vitest **66:66**(新增 core×4 假 embedder + 混合检索×1;vec0 需在测试里 loadExtension——与生产一致的加载路径)/ 真机冒烟:默认关闭日志正确、FTS 正常
- **坑:**vec0 的 rowid 不能用参数绑定(Only integers are allowed),只内联自家表的自增 id;better-sqlite3 的 `exec()` 不接受参数
- **启用验证(用户确认后同日完成):**模型实际 91MB,本机直连 HuggingFace 下载成功(无需代理);75 行向量(21 记忆 + 56 会话)入库;端到端实测:概念性查询「换电脑时知识库怎么迁移到另一台机器」字面零命中 → 语义补足 4 条高度相关(GitHub 同步布局记忆 + 3 个同步/迁移会话), 标注与过滤维度全部生效
- **启用方式(实测修正):**插件 ctx.settings 自动加 `${id}:` 前缀,实际键为 settings.json 的 `"semantic-search:enabled": true`(不是 semantic:enabled);headless `--reindex` 可手动重建索引(比防抖等待可靠)

---

## 2026-08-31 · M7 第二块:托盘常驻 + 全局热键秒搜(spotlight)

「每日打开的理由」核心件:应用退到托盘,MCP 服务端真正常驻;任意界面 Alt+Shift+M 一键秒搜。

- **主进程新 `spotlight.ts`**:托盘(build/icon.png,打包经 extraResources → resources/icon.png;菜单 = 打开主窗口/全局秒搜/退出,点击托盘=显示主窗口)+ 全局热键 Alt+Shift+M(`settings.json` 的 `spotlight:hotkey` 可改,注册失败降级为仅托盘菜单触发)+ 秒搜窗口(680×460 免框、置顶 screen-saver 级、skipTaskbar,出现在主窗口所在显示器上方,失焦自动隐藏)
- **关闭即隐藏**:主窗口 X = 隐藏(进程/MCP/托盘保持),真退出走托盘菜单或 before-quit 标记——托盘常驻的关键语义
- **秒搜渲染端复用主 bundle**:`?spotlight=1` 入口分支渲染 SpotlightView(避免 hooks 分支问题,main.tsx 分流);200ms 防抖实时搜四类资产(会话/消息/记忆/笔记),Enter/点击 → 新 host 通道 `memorysql:host:openSession` → 主窗口唤起 + `push:open-session` 推送打开对应会话详情;Esc/失焦隐藏
- **UI 走查(实机)**:热键唤起 ✓(免框置顶、输入自动聚焦)→ 输入"触发器"实时出结果 ✓ → Enter 秒搜隐藏 + 主窗口打开会话 #61 详情 ✓;关闭→隐藏留待用户一键复验(走查中焦点被前台应用接管,未强抢)
- 验证:typecheck 零错 / vitest 61:61(无新单测——窗口/热键属 Electron 集成面,纯逻辑无独立函数)/ 实机走查如上
- **M7 剩余:**语义检索(sqlite-vec+fastembed 本机可达)、SQLCipher、M6 遗留 LLM 冲突检测;托盘可加开机自启(app.setLoginItemSettings)后续补

---

## 2026-08-31 · M7 第一块:自动项目日志(project-devlog 插件)

M7 四块(语义检索/自动 DEVLOG/托盘秒搜/SQLCipher)里纯本地、零依赖的一块先落地:

- **新插件 `project-devlog`**:每个有会话的项目在 `vault/devlog/<项目名>.md` 生成开发日志,四段 = 概览(会话数/agent 分布/时间跨度/技术栈/路径)+ 时间线(**按日分组,日倒序、日内正序**,每条带 #id 与消息数)+ 决策与结论(活跃记忆)+ 未竟与待办(log_progress 候选);文件头 `memorysql:auto-devlog` 标记声明"重新生成整文件覆盖,手写内容请另建文件"
- **触发三路**:顶栏「生成项目日志」按钮(UI,带 4s 结果提示)+ headless `--devlog`(可与 --scan 组合)+ ingest 后 **20s 防抖自动更新**(仅 UI 常驻实例;headless 因立即退出不触发防抖,显式用 --devlog)
- **活同步第一环**:写进 vault/ 即被 core-vault watcher 索引 → 笔记检索与 MCP `memory_search`(kind=note)立即可查
- 验证:typecheck 零错 / vitest **61:61**(新增 generate×3)/ 真实数据生成 **7 个项目日志**(MemorySQL.md:5 会话 zcode、时间线分组正确、决策段含活跃记忆)
- 顺带 spike:`sqlite-vec@0.1.9` 与 `fastembed@2.1.0` 本机 npm 均可达 → M7-1 语义检索可行(实际装包 + 模型下载留下一轮)
- **M7 剩余:**语义检索、托盘常驻 + 全局热键秒搜、SQLCipher、M6 遗留的 LLM 冲突检测

---

## 2026-08-31 · M6 MCP 工具矩阵 v2 + 交接简报(回流闭环打通)

**矩阵 v2 全部落地(MCP 工具 4 → 7):**
- `memory_get_context` 增强:`agent?` 过滤(全局 NULL 记忆始终包含)+ `include_last_session=true` 内联最近会话 tail 作「上一棒交接摘要」;会话带 id(M5.2)
- `memory_list_sessions` 新增:project/agent/since(天数)/limit/offset,系统性枚举入口;项目关键词不匹配时明确报错
- `memory_get_session` 增强:`full=true` 单条 20000 字符(默认 2000),总量 120k 上限防失控
- `memory_search` 增强:`kind/agent/project/since` 过滤;search.ts 重写为**动态 SQL 单路径**(四源同构片段,SearchFilters 接口),渲染端零改动
- `memory_write` 增强:agent 归因 + project 关联 + tags(v4 迁移:memories 加 `tags`/`project_id` 两列)+ **完全重复内容拒写**(治理 MVP)
- `memory_log_progress` 新增:结构化收工汇报(完成/下一步/问题)→ candidate 进度条并关联项目——distill 自动候选(ingest 后触发,已有)+ UI confirmAll 确认流不变,agent 主动汇报接进同一条候选流

**交接简报 `memory_get_project_brief`(规则版,铁律 3 本地优先):**最近会话(带 id)+ 上一棒 tail + 活跃记忆 + 待确认进度 四段汇编;LLM 精炼版留待后续。
**治理 MVP:**exact-duplicate 拒写;agent_type 生效(get_context/search 过滤,Codex 的偏好可不再喂给 Hermes);新旧记忆冲突检测需 LLM,顺延 M7。

**验证:**typecheck 零错 / vitest **58:58**(新增 mcp-tools 工具级测试×10:过滤/归因/去重/full 模式/简报汇编)/ `import:scan` 真实数据 / 启动实例实调:tools/list 7 工具、brief 真实数据汇编正确、log_progress #26 → search(kind=memory)**即时可见**(FTS 触发器写入即索引)、双实例端口避让 8642/8643。
**版本 0.3.0。**
**下一步:M7** = 本地语义检索(sqlite-vec + 本地 embedding)/ 自动 DEVLOG / 托盘常驻 + 全局热键秒搜;或先做 M8 前置的打包 + CI。M6 遗留:LLM 冲突检测。

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
