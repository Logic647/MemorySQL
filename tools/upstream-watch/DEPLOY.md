# 上游监控看板 · 部署说明

> 开发端自用工具,不是产品功能,不出现在 MemorySQL 装机版里。

## 它是什么

盯住 12 家已适配 agent 的上游更新,回答一个问题:**这次更新会不会打坏我的会话捕获或 MCP 连接?**

- **白盒**(云端):抓 changelog → 关键词分级 → 标出哪些要重点看
- **黑盒**(开发机):探测真实数据的 schema 漂移,给确定答案 —— `npm run upstream:check`

两者互补:云端告诉你「可能变了」,黑盒告诉你「真的变了」。**对 4 家闭源 agent(qoder/codebuddy/workbuddy/zcode)只有黑盒可用**,看板会给它们一个「仅黑盒」行 + 手动粘贴 changelog 的入口。

## 部署到阿里云(实测环境)

实测:Node v20.20.2 / linux-x64,`api.github.com` 直连可用(200,成功率 100%,均 310ms),**无需代理**。

```bash
# 1. 只取需要的两个目录(不 clone 整个仓库)
git clone --depth 1 https://github.com/Logic647/MemorySQL.git
cd MemorySQL

# 2. 起服务(零依赖,无需 npm install —— 不要装,那是给产品用的)
PORT=8788 AUTH_TOKEN='<换成你自己的长随机串>' \
  node tools/upstream-watch/server.mjs

# 3. 常驻
pm2 start tools/upstream-watch/server.mjs --name msql-upstream-watch \
  --env PORT=8788 --env AUTH_TOKEN='<同上>'
pm2 save
```

**不需要 `npm install`**:服务只用 Node 18+ 内置的 `http` / `fetch` / `fs`。

## 环境变量

| 变量 | 必需 | 说明 |
|---|---|---|
| `AUTH_TOKEN` | 公网必填 | 鉴权 token。`Authorization: Bearer <token>` 或 `?token=<token>`。**不设则任何人都能看** |
| `PORT` | 否 | 默认 8788 |
| `GITHUB_TOKEN` | 强烈建议 | 匿名 API 限流 60 次/小时,带 token 提到 5000。12 家一天一次其实够用,但建议配上 |
| `LLM_API_KEY` | 否 | 启用 LLM 增强。**不设就纯规则**(功能完备,只是少一层语义判断)。调用失败/超时/返回非 JSON 一律自动降级,绝不阻塞看板 |
| `LLM_BASE_URL` | 否 | 默认 `https://api.anthropic.com/v1/messages`。**填非 Anthropic 官方地址时自动改用 OpenAI 兼容格式**(Bearer 认证 + `choices[].message.content` 解析),所以第三方 provider / 自建网关也能直接用 |
| `LLM_MODEL` | 否 | 默认 `claude-sonnet-4-5` |
| `LLM_AUTH_HEADER` | 否 | 显式指定认证头名(如 `api-key`)。**默认不设时会同时发 `Authorization: Bearer` 和 `api-key` 两个头**,以兼容各家差异(OpenAI 要前者、小米 MiMo 要后者) |

### 已预置的 provider

`node scripts/check-llm.mjs <名字>` 可直接套用端点+模型(key 仍走环境变量,不落文件):

| 名字 | provider | 模型 |
|---|---|---|
| `mimo` | 小米 MiMo | `mimo-v2.6-pro` |
| `openai` | OpenAI 官方 | `gpt-4o-mini` |
| `anthropic` | Anthropic 官方 | `claude-sonnet-4-5` |
| `deepseek` | DeepSeek | `deepseek-chat` |

**MiMo 注意事项**(核对自官方文档 2026-09-30):
- 认证头是 `api-key`,不是 `Authorization: Bearer` —— 本工具已兼容(默认两个都发)
- 用 `max_completion_tokens` 而非 `max_tokens` —— 本工具也两个都发
- ⚠ **`mimo-v2.5-pro` / `mimo-v2.5` 将于 2026-10-21 下线**,请用 `mimo-v2.6-pro` 或 `mimo-v2.6-flash`
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

**LLM 的两个设计约束**(改代码前务必知道):
- 只对规则判为 `medium`/`high` 的条目调用,`low`/`none` 直接跳过(省钱省延迟)
- **只能加严,不能放松** —— LLM 说「没事」不会把规则判的 `high` 降级,但它的理由仍会保留在看板里给人看
| `LEDGER_PATH` | 否 | 台账 JSON 路径,默认 `upstream/ledger.json` |
| `REFRESH_HOURS` | 否 | 定时抓取间隔,默认 **24**(你定的「一天一次」足够) |

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
