# 上游监控看板 · 部署说明

> 开发端自用工具,不是产品功能,不出现在 MemorySQL 装机版里。

## 它是什么

盯住 12 家已适配 agent 的上游更新,回答一个问题:**这次更新会不会打坏我的会话捕获或 MCP 连接?**

- **白盒**(云端):抓 changelog → 关键词分级 → 标出哪些要重点看
- **黑盒**(开发机):探测真实数据的 schema 漂移,给确定答案 —— `npm run upstream:check`

两者互补:云端告诉你「可能变了」,黑盒告诉你「真的变了」。**对 4 家闭源 agent(qoder/codebuddy/workbuddy/zcode)只有黑盒可用**,看板会给它们一个「仅黑盒」行 + 手动粘贴 changelog 的入口。

## ⚠️ 这套东西跑在两台机器上

这是最容易搞混的地方,先记住这张表:

| | 在哪跑 | 入口 | 产出 |
|---|---|---|---|
| **白盒**(抓 changelog + LLM 评估) | **云端服务器** | 服务端的定时任务 / `POST /api/refresh` | `state.results` |
| **黑盒**(探真实数据) | **你的开发机** | `npm run upstream:check`(只看) / `npm run upstream:probe`(并上报) | POST 到云端 `/api/probe` → `state.probe` |

**黑盒只能在本机跑** —— 因为它要去读 `~/.claude`、`~/.local/share/opencode/*.db` 这些真实 agent 数据,云端上根本没有。`scripts/upstream-probe.mjs` 就是这条链路的接头:本机跑黑盒 → POST 给云端 → 云端合并进 `state.probe` → 看板显示双栏。

所以两台机器都要有这份代码,各自 `git pull`:

```bash
# 开发机(Windows)
npm run upstream:check        # 只想看结果,不写云端
npm run upstream:probe        # 跑黑盒 + 上报云端(需要云端 token)

# 云端服务器(Linux,零依赖)
pm2 start tools/upstream-watch/server.mjs --name msql-upstream-watch
```

**`npm run upstream:probe` 需要 Node ≥22.6** —— 它要执行 TS 检查器 `upstream/check.ts`(Node 20 不支持 `--experimental-strip-types`)。这是唯一必须在开发机跑、不能在云端跑的原因。

## 部署到阿里云(实测环境)

实测:Node v20.20.2 / linux-x64,`api.github.com` 直连可用(200,成功率 100%,均 310ms),**无需代理**。

> ⚠️ **两条 GitHub 链路的可靠性不一样,别混为一谈**(2026-09-30 实测):
> `api.github.com`(看板抓 changelog 用)稳定在 0.36 秒;而 **`github.com`(git 传输用)会间歇性连不上**,表现是 `git pull` 卡到超时、`curl` 直接 `Connection timed out`,同一次 `git fetch` 重试 7 次才成功过。
> **所以:抓取失败和拉不到代码是两种不同故障,不要互相归因。** `git pull` 失败时别怀疑 token 或网络配置 —— 先确认 `curl https://api.github.com/rate_limit` 是否正常,若正常就只是 git 链路抖动,重试即可。部署时建议:
> ```bash
> for i in $(seq 1 8); do
>   GIT_TERMINAL_PROMPT=0 timeout 90 git -c http.version=HTTP/1.1 fetch -q origin && break
>   echo "第 $i 次失败,重试"; sleep 6
> done
> ```
> 另外 `git -c http.version=HTTP/1.1` 能绕开偶发的 `curl 16 Error in the HTTP2 framing layer`。

```bash
# 1. 完整 clone —— 不要用 --depth 1!
#    后面「台账变了怎么办」要靠 git pull 拿新提交,浅克隆 pull 会直接报错,
#    只能 git fetch --unshallow 补救。
git clone https://github.com/Logic647/MemorySQL.git
cd MemorySQL

# 2. 起服务(零依赖,无需 npm install —— 不要装,那是给产品用的)
set -a; . /root/.msql-watch-env; set +a
node tools/upstream-watch/server.mjs

# 3. 常驻。**不要用 pm2 --env**,它会静默丢掉你传的变量(见下文)。
pm2 start tools/upstream-watch/server.mjs --name msql-upstream-watch
pm2 save
```

**不需要 `npm install`**:服务只用 Node 18+ 内置的 `http` / `fetch` / `fs`。

**推荐直接用 `setup-watch.sh`**(见下文「一键配置脚本」),它把这套流程连同 `GITHUB_TOKEN` 持久化一起做掉,省得手工拼环境变量。

## HTTP 端点

全部端点都在鉴权之后(`server.mjs` 的 handler 第一行就是 `if (!auth(req, res)) return`),**包括 `/` 这个静态页**——所以浏览器直接访问裸 IP 会 401,必须靠 nginx 注入 header(见下文)。

| 端点 | 方法 | 干什么 | 谁调用 |
|---|---|---|---|
| `/` | GET | 返回看板 HTML | 浏览器 |
| `/api/state` | GET | 当前全量状态(白盒 results + 黑盒 probe) | 前端轮询 |
| `/api/refresh` | POST | **立刻**跑一轮抓取 + LLM 评估,同步返回结果 | 前端「立即刷新」按钮、`setup-watch.sh --refresh` |
| `/api/probe` | POST | 本机黑盒探针上报,合并进 `state.probe` | `scripts/upstream-probe.mjs` |
| `/api/manual` | POST | 手动粘贴 changelog(给 4 家闭源 agent 用) | 前端输入框 |

`/api/refresh` 一次要打 GitHub API 约 9~20 次,**实测耗时 107 秒**(同步阻塞返回),期间页面「立即刷新」按钮会置灰。

## 环境变量

| 变量 | 必需 | 说明 |
|---|---|---|
| `AUTH_TOKEN` | 公网必填 | 鉴权 token。`Authorization: Bearer <token>` 或 `?token=<token>`。**不设则任何人都能看** |
| `PORT` | 否 | 默认 8788 |
| `GITHUB_TOKEN` | **实际必需** | 匿名 API 限流 **60 次/小时**,一轮要打 9 个 GitHub 仓库,**超限的表现不是报错,而是全部退化为「无法评估」**(看起来像功能没实现)。带 token 提到 5000/小时。实测踩过:反复点「立即刷新」即超限,12 家里 11 家变 unknown、连带 LLM 也没被调用 |
| `LLM_API_KEY` | 否 | 启用 LLM 增强。**不设就纯规则**(功能完备,只是少一层语义判断)。调用失败/超时/返回非 JSON 一律自动降级,绝不阻塞看板 |
| `LLM_BASE_URL` | 否 | 默认 `https://api.anthropic.com/v1/messages`。**填非 Anthropic 官方地址时自动改用 OpenAI 兼容格式**(Bearer 认证 + `choices[].message.content` 解析),所以第三方 provider / 自建网关也能直接用 |
| `LLM_MODEL` | 否 | 默认 `claude-sonnet-4-5` |
| `LLM_AUTH_HEADER` | 否 | 显式指定认证头名(如 `api-key`)。**默认不设时会同时发 `Authorization: Bearer` 和 `api-key` 两个头**,以兼容各家差异(OpenAI 要前者、小米 MiMo 要后者) |
| `LEDGER_PATH` | 否 | 台账 JSON 路径,默认 `upstream/ledger.json` |
| `REFRESH_HOURS` | 否 | 定时抓取间隔,默认 **24**(你定的「一天一次」足够) |

### 已预置的 provider

`node scripts/check-llm.mjs <名字>` 可直接套用端点+模型(key 仍走环境变量,不落文件):

| 名字 | provider | 模型 |
|---|---|---|
| `mimo` | 小米 MiMo | `mimo-v2.6-flash`(判断力更强可改 `mimo-v2.6-pro`) |
| `openai` | OpenAI 官方 | `gpt-4o-mini` |
| `anthropic` | Anthropic 官方 | `claude-sonnet-4-5` |
| `deepseek` | DeepSeek | `deepseek-chat` |

**MiMo 注意事项**(核对自官方文档 2026-09-30):
- 认证头是 `api-key`,不是 `Authorization: Bearer` —— 本工具已兼容(默认两个都发)
- 用 `max_completion_tokens` 而非 `max_tokens` —— 本工具也两个都发
- ⚠ **`mimo-v2.5-pro` / `mimo-v2.5` 将于 2026-10-21 下线**,请用 `mimo-v2.6-flash`(本项目默认)或 `mimo-v2.6-pro`
- Token Plan 订阅用户端点是 `https://token-plan-cn.xiaomimimo.com/v1`,key 前缀 `tp-`/`ttp-`(不是 `sk-`)

### 启用 LLM 后请先自检

`llmEnhance` 的单元测试全是 mock(离线、不花钱),但 **mock 证明不了你的 key/端点/模型名真的能用**。真调一次才算数:

```bash
export LLM_API_KEY=sk-xxxx
node scripts/check-llm.mjs mimo
```

它会打印规则判定 → LLM 判定 → 合并结果,并在失败时给出排查方向(退出码 1)。

**LLM 的两个设计约束**(改代码前务必知道):
- 只对规则判为 `medium`/`high` 的条目调用,`low`/`none` 直接跳过(省钱省延迟)
- **只能加严,不能放松** —— LLM 说「没事」不会把规则判的 `high` 降级,但它的理由仍会保留在看板里给人看

### 环境变量务必用前缀传,别用 `pm2 --env`

```bash
# ✅ 对:pm2 --env 传参会静默失败(曾导致 AUTH_TOKEN 没进进程,服务裸奔)
AUTH_TOKEN=$(cat ~/.msql-watch-token) GITHUB_TOKEN=... LLM_API_KEY=... \
  pm2 start tools/upstream-watch/server.mjs --name msql-upstream-watch

# 改环境变量后同理
AUTH_TOKEN=$(cat ~/.msql-watch-token) pm2 restart msql-upstream-watch --update-env
```

**验证必须同时看两个结果**:`no-token:401` 和 `with-token:200`。只看后者会以为配好了。

## 一键配置脚本 `setup-watch.sh`

上面那些坑(GitHub 限流静默降级、`pm2 --env` 静默失效、重启丢配置)手工操作容易漏,这个脚本把它们固化了:

```bash
scp tools/upstream-watch/setup-watch.sh root@<server>:/root/
ssh root@<server> 'chmod +x /root/setup-watch.sh'

/root/setup-watch.sh <github_token>            # 应用
/root/setup-watch.sh <github_token> --refresh  # 应用并触发一次抓取
/root/setup-watch.sh --verify                  # 只体检,不改任何东西
/root/setup-watch.sh --show                    # 打印当前配置(密钥自动掩码)
/root/setup-watch.sh --reset                   # 摘掉 GITHUB_TOKEN,保留其余
```

**它的几条硬设计(改脚本前先知道)**:

- **先验证 token 再动手** —— 打 `api.github.com/rate_limit`,`core.limit < 100` 直接中止。实测用假 token 会在这一步退出,**不碰 pm2、不写 env 文件**
- **从活进程 env 快照出配置再叠加新变量** —— 原来只在 pm2 命令行里给的 `LLM_*` 不会因为这次配置而丢失
- **落盘到 `~/.msql-watch-env`(600)并 `pm2 save`** —— 否则重启后 `LLM_API_KEY` 直接消失,页面只显示「LLM 未启用」,**全程无任何报错**
- **只动 `msql-upstream-watch`** —— `qa-server` 不是我们的,不能碰
- **每次写入前自动备份** `~/.msql-watch-env.bak.<时间戳>`,verify 失败会打印回滚命令
- **体检同时看 401 和 200**,缺一即判失败
- 脚本是**纯 ASCII**,因为它要经 PowerShell 管道送到 Linux 执行(中文/多字节字符会让远端 `sed` 引号失配)

## 本机探针(`npm run upstream:probe`)

黑盒这条腿在开发机上跑,跑完把结果送到云端:

```bash
# 先看一眼,不碰云端
npm run upstream:check

# 跑完顺便上报云端
PROBE_ENDPOINT=https://watch.logic-yjb.top \
PROBE_TOKEN=$(cat ~/.msql-watch-token) \
  npm run upstream:probe

# 只在本地试跑、不上报
PROBE_ENDPOINT=https://watch.logic-yjb.top PROBE_TOKEN=xxx npm run upstream:probe -- --dry-run
```

**`PROBE_ENDPOINT` 不用带 `/api/probe`**,脚本会自动补全(L132-134)。`PROBE_ENDPOINT` 不设时脚本只打印提示、不上报。

上报是**双向确认**的:`res.ok` 之后还要 `ack.ok === true` 才算成功(`L145` + `L151`)。这层校验是有来历的——早期版本只查 `res.ok`,而服务端 `/` 分支对 POST 也照返 `index.html` + **200**,于是打印「上报成功」而 `state.probe` 始终是 `null`。**假成功比直接失败更糟**,改这块前先读 `docs/DEVLOG.md` 2026-09-30「第 3 期」。

会额外生成一份 Markdown 报告到 `docs/upstream-reports/<日期>.md`,进 git 可 review。

**探针刻意不直接写 `memories` 表** —— 那是应用的数据目录,CLI 直写有并发风险;结论落库仍由 agent 收工时用 `memory_log_progress` 做。

探针的失败模式都当心过(它们都属于本项目的"静默失败"家族):POST 到站点根地址而非 `/api/probe`、服务端 `/` 分支不检查 method 导致返回 HTML+200 造成**假成功**、检查器自身 import 失败被误判成**上游漂移**(已单列为 `checker_error` 判定)。改这块前先读 `docs/DEVLOG.md` 2026-09-30「第 3 期」。

## 线上现状(2026-09-30 实测)

| 项 | 值 |
|---|---|
| 地址 | `https://watch.logic-yjb.top` |
| 服务器 | 阿里云,Node v20.20.2,pm2 7.0.3 |
| 监听 | `127.0.0.1:8788`(公网只经 nginx) |
| pm2 应用名 | `msql-upstream-watch`(**不要动 `qa-server`,不是我们的**) |
| 配置 | `/root/.msql-watch-env`(600,由 `setup-watch.sh` 维护) |
| 看板 token | `/root/.msql-watch-token`(600) |
| GitHub token | 同上文件,`github_pat_` 开头(fine-grained,读公开仓库) |

体检一句就够:

```bash
/root/setup-watch.sh --verify
```

## 反向代理与 HTTPS

服务默认只监听 `127.0.0.1`,公网访问走 nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:8788;
    proxy_set_header Host $host;
}
```

**注意:query-string 里的 `?token=` 会留在 nginx access log 里**。更稳妥的做法是让 nginx 注入 header:

```nginx
location / {
    proxy_pass http://127.0.0.1:8788;
    proxy_set_header Authorization "Bearer <你的token>";
}
```

## 台账变了怎么办

云端读的是 `upstream/ledger.json`(导出件,不是 TS 源 —— 因为云端是 Node 20,跑不了 TS)。改完台账后:

```bash
# 本地(Node ≥22)重新导出
node --experimental-strip-types scripts/export-ledger.ts
git commit -am "chore(upstream): refresh ledger" && git push
# 云端
git pull && pm2 restart msql-upstream-watch
```

`test/upstream-contract.test.ts` 会断言 JSON 与 TS 源逐字段一致,**忘了导出会直接让 CI 变红**。

## 日常怎么用

1. 打开看板,看**风险等级**:`高` 必须看,`中` 扫一眼,`无信号` 不用管,`仅黑盒/无法评估` 知道就行
2. 看到「高」→ 本机跑 `npm run upstream:check`,确认**黑盒**是否真的漂移
3. 两者结论不一致时以黑盒为准(它探测的是真实数据)
4. 确认漂移 → 更新台账 + 改适配器 + 发版

## 误报是设计上的已知代价

白盒是关键词匹配,**必然有误报**。已实测并修掉两类最恶劣的:

- 单词级关键词撞上 UI 文案(claude-code 的 "rename it"、hermes 的 "two-column ticket modal")→ 改成**短语级**强信号
- qwen-code 的 Keep a Changelog 固定输出「## Breaking Changes / No known breaking changes」→ 加**否定句式**抵消

剩余误报由「强信号必须命中短语」+ LLM 二次判断共同压制。**若你发现某个 agent 长期误报,往 `evaluate.mjs` 的 NEGATION 加一句即可。**
