/**
 * 上游监控看板服务 —— 零依赖,Node 18+。
 *
 * 部署:阿里云 Linux,只需 node,无需编译、无 native 依赖。
 *   node server.mjs
 *
 * 环境变量:
 *   PORT          端口,默认 8788
 *   AUTH_TOKEN    必填(设了才开鉴权;未设时仅监听 127.0.0.1 供本地反代)
 *   GITHUB_TOKEN  可选,提高 API 限流额度
 *   LLM_API_KEY   可选,启用 LLM 增强(失败自动降级)
 *   LEDGER_PATH   台账 JSON 路径,默认 ../upstream/ledger.json
 *   REFRESH_HOURS 定时抓取间隔,默认 24(用户定的「一天一次」)
 *
 * 状态持久化到 state.json(零依赖,原子写)。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchUpstream } from './fetch.mjs'
import { evaluate, llmEnhance } from './evaluate.mjs'
import { summarize } from './summarize.mjs'
import { ledgerFingerprint, compareFingerprints } from './fingerprint.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// STATE 可用环境变量覆盖,默认仍在 service 目录里。
// 可覆盖不是为了部署方便(生产一直用默认),而是**为了能被测试**:
// 冒烟测试要真起一个服务,若状态文件写死在仓库里,跑一次测试就会污染
// 开发机上的 state.json —— 而那正是"测试动了真实数据"最容易被忽略的一种。
const STATE = process.env.STATE_PATH ?? path.join(HERE, 'state.json')
const LEDGER = process.env.LEDGER_PATH ?? path.join(HERE, '..', '..', 'upstream', 'ledger.json')
const PORT = Number(process.env.PORT ?? 8788)
const REFRESH_HOURS = Number(process.env.REFRESH_HOURS ?? 24)
const TOKEN = process.env.AUTH_TOKEN ?? ''

let state = { results: [], probe: null, summary: null, lastRunAt: null, running: false, error: null }

/**
 * 本机(云端)这份台账的契约指纹。
 *
 * 白盒在这里算,黑盒在开发机算,两边指纹一比就知道**是否在用同一套适配契约**。
 * 不一致的后果不是"数据脏了",而是「漂移」结论可能只是台账版本差 —— 而这个
 * 判断会直接触发一次发版,是整个工具最不该出错的一处。
 * 每次现算而不是缓存:台账可能被 `git pull` 换掉,缓存会让指纹变成谎言。
 */
function currentLedgerHash() {
  try {
    return ledgerFingerprint(JSON.parse(fs.readFileSync(LEDGER, 'utf-8')))
  } catch {
    return null
  }
}

/** 探针上报的指纹 vs 本机指纹。三态,见 compareFingerprints 的说明。 */
function ledgerAgreement() {
  return compareFingerprints(currentLedgerHash(), state.probe?.ledgerHash ?? null)
}

function loadLedger() {
  const raw = JSON.parse(fs.readFileSync(LEDGER, 'utf-8'))
  return { agents: raw.agents ?? [], riskKeywords: raw.riskKeywords ?? [] }
}

/**
 * 只把**需要跨重启保留**的字段写盘。
 *
 * `running` 是纯内存的瞬时标志,绝不能落盘 —— 它一旦被写进 state.json,
 * 就会在下次启动时被 loadState() 读回来,于是启动那轮 runOnce() 判定
 * "已经在跑了" 直接返回,此后**永远不会再抓一次**。
 * 症状极其隐蔽:服务 online、接口返 200、页面照常显示,只是数据永远停在那一刻。
 * 实测踩过:模拟"抓取途中进程被杀"(即每次部署都会发生)→ 重启后刷新 9ms 秒回旧数据,
 * 且再也刷不动。写盘与读盘两侧都做了防护,任何一侧被改动也不至于锁死。
 */
const TRANSIENT = new Set(['running'])

function loadState() {
  try {
    if (fs.existsSync(STATE)) {
      const saved = JSON.parse(fs.readFileSync(STATE, 'utf-8'))
      state = { ...state, ...saved }
    }
  } catch {
    /* 损坏则用默认值,下次刷新覆盖 */
  }
  // 读盘侧兜底:无论文件里写了什么,running 一律从 false 起步
  state.running = false
}

// 原子写:先写临时文件再 rename,避免进程被杀时留下半截 JSON
function saveState() {
  const persist = {}
  for (const [k, v] of Object.entries(state)) if (!TRANSIENT.has(k)) persist[k] = v
  const tmp = `${STATE}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(persist, null, 2), 'utf-8')
  fs.renameSync(tmp, STATE)
}

/**
 * 重算总体摘要。任何改变了 results / probe 的路径都必须走这里,否则置顶面板会
 * 停在上一次计算的结果上,和它正下方的新数据自相矛盾。
 * 永远不抛 —— 摘要坏了也不能影响上报本身的成功与否。
 */
async function recomputeSummary() {
  try {
    state.summary = await summarize(state.results, state.probe, ledgerAgreement())
  } catch (e) {
    state.summary = {
      ...(state.summary ?? {}),
      error: `摘要重算失败:${e?.message ?? e}`
    }
  }
}

/**
 * 排队重算摘要并落盘,**不阻塞调用方**。
 *
 * 为什么要排队而不是直接 `void recomputeSummary()`:
 * recomputeSummary 与 saveState 都会写同一个 state.json。两个请求同时到达
 * (比如探针上报撞上「立即刷新」)就会各自算一次,然后各写一次盘 —— 后写的
 * 可能带着**上一轮**的 summary 覆盖掉新数据。那种丢失不会报错,只会让面板
 * 停在旧结论上,而探针明明刚报上来。串行化把这种丢失变成不可能。
 */
let summaryQueue = Promise.resolve()
function refreshSummarySoon() {
  // `.catch` 不是可选的:summaryQueue 一旦 reject,后续所有 `.then` 都挂在
  // 一个已 reject 的 promise 上,**再也不会执行** —— 摘要就此永久冻结,
  // 而面板看起来只是"数据有点旧",不报任何错。
  // 这与之前 `running` 被写进 state.json 导致服务永久锁死是同一族:
  // 一个瞬时故障变成永久失效,而且症状不像故障。
  summaryQueue = summaryQueue
    .then(async () => {
      await recomputeSummary()
      saveState()
    })
    .catch((e) => {
      console.error('摘要重算落盘失败(后续重算仍会继续):', e?.message ?? e)
    })
  return summaryQueue
}

async function runOnce() {
  if (state.running) return
  state.running = true
  state.error = null
  try {
    const { agents } = loadLedger()
    const out = []
    for (const agent of agents) {
      const upstream = await fetchUpstream(agent)
      let r = evaluate(agent, upstream)
      r = await llmEnhance(r, agent)
      out.push(r)
    }
    state.results = out
    // 总体情况:brief 由代码算(永远可信),LLM 只负责把 brief 组织成人话。
    // 放在 for 循环之后 —— 它要看完全部 12 家才有意义。
    // 失败只记进 summary.error,绝不让整轮刷新失败(否则这功能一挂看板就空白)。
    state.summary = await summarize(out, state.probe, ledgerAgreement())
    state.lastRunAt = new Date().toISOString()  } catch (e) {
    state.error = String(e?.message ?? e)
  } finally {
    state.running = false
    saveState()
  }
}

function auth(req, res) {
  if (!TOKEN) return true
  const h = req.headers.authorization ?? ''
  const q = req.url.includes('token=') ? new URL(req.url, 'http://x').searchParams.get('token') : ''
  if (h === `Bearer ${TOKEN}` || q === TOKEN) return true
  res.writeHead(401, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'unauthorized' }))
  return false
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  if (!auth(req, res)) return

  if (url.pathname === '/api/state') return json(res, 200, state)

  /**
   * 本机黑盒探针上报。云端只有白盒(关键词粗筛,必然有误报),黑盒探测真实
   * 数据才是确定答案 —— 但它只能在有 agent 数据的机器上跑,所以由探针送上来。
   * 合并进 state.probe,看板据此显示双栏(白盒 / 黑盒)。
   */
  if (url.pathname === '/api/probe' && req.method === 'POST') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}')
        if (!Array.isArray(data.results)) return json(res, 400, { error: 'bad payload' })
        state.probe = {
          checkedAt: data.checkedAt ?? new Date().toISOString(),
          // 探针带上的是**开发机**那份台账的指纹;没有这个字段(旧版探针)时为 null,
          // 面板会显示"未知"而不是"冲突" —— 见 compareFingerprints
          ledgerHash: typeof data.ledgerHash === 'string' ? data.ledgerHash : null,
          results: data.results.slice(0, 64) // 防御:别让人往 state 里灌垃圾
        }
        // 探针到达后必须重算摘要 —— 但**回执不等它**。
        //
        // 原实现在 `recomputeSummary().finally()` 里回 200,于是每次上报都要等
        // summarizer 跑完一次 LLM。实测空 results 也要 26 秒,带 12 条更久;
        // nginx 的 proxy_read_timeout 是 30 秒,于是探针稳定吃到 **504**。
        // 而数据其实**已经存好了** —— 调用方只看到一个超时,合理地以为失败、
        // 于是重试、再超时。「失败要看起来像失败」在这里反过来了:
        // **成功看起来像失败**,而且从面板上看不出数据其实是好的。
        //
        // 所以顺序改成:先落盘、先回执,摘要随后自己追上。
        // 代价是那 26 秒内面板显示的是上一轮的结论,所以回执里明说
        // summary:'pending',不假装已经一致。
        saveState()
        json(res, 200, { ok: true, accepted: state.probe.results.length, summary: 'pending' })
        // 刻意不 await:探针方要的是「收下了」,不是「顺便帮我算完摘要」。
        // 串行化在 refreshSummarySoon 里,这里不阻塞响应。
        void refreshSummarySoon()
      } catch (e) {
        json(res, 400, { error: String(e?.message ?? e) })
      }
    })
    return
  }

  /**
   * 手动触发一轮抓取。
   *
   * 已在跑时必须回 **409** 而不是 200 + 旧状态 —— 旧实现直接 `return`,
   * 客户端拿到 200 和一份陈旧数据,页面看起来一切正常,用户以为自己刚刷新过。
   * 这正是本项目反复吃的"静默失败":**失败要看起来像失败。**
   */
  if (url.pathname === '/api/refresh' && req.method === 'POST') {
    if (state.running) {
      return json(res, 409, { error: '正在抓取中,请稍候再试', running: true, state })
    }
    // **立刻回执,抓取在后台跑。**
    //
    // 旧实现在 `runOnce().then(...)` 里回 200,而 runOnce 是**串行**遍历 12 家、
    // 每家都可能调一次 LLM —— 实测这一轮要几十秒到几分钟,稳稳超过 nginx 的
    // proxy_read_timeout。于是页面等来一个网关超时,显示「刷新失败」,
    // 而抓取其实完成了:又是一次**成功看起来像失败**,而且用户没有任何办法
    // 判断该不该再点一次(再点会撞上 409「已有抓取在进行」,更像坏了)。
    //
    // 改回 202 + 页面轮询 `running` 之后,这个请求的时长与抓取时长解耦,
    // 中间层掐断连接也不会让一次成功的抓取变成"失败"。
    // running 由 runOnce 自己维护(进入 true、finally 里 false),页面据此判断结束。
    void runOnce()
    return json(res, 202, { started: true })
  }

  // 闭源 agent:手动粘贴 changelog,让「无法评估」变成「可评估」
  if (url.pathname === '/api/manual' && req.method === 'POST') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      try {
        const { agentId, notes } = JSON.parse(body || '{}')
        const { agents } = loadLedger()
        const agent = agents.find((a) => a.id === agentId)
        if (!agent) return json(res, 400, { error: 'unknown agent' })
        const r = evaluate(agent, { notes, version: '手动提供', notesProvided: true })
        state.results = state.results.filter((x) => x.agentId !== agentId).concat(r)
        // 手动补的 changelog 会改变该 agent 的判定 → 摘要同样要重算,理由同 /api/probe
        void recomputeSummary().finally(() => {
          saveState()
          json(res, 200, state)
        })
      } catch (e) {
        json(res, 400, { error: String(e?.message ?? e) })
      }
    })
    return
  }

  // 只允许 GET —— 曾因不检查 method,探针误 POST 到根路径时被当作正常请求
  // 返回 index.html + 200,探针据此误判「上报成功」。假成功比直接失败更糟。
  if ((url.pathname === '/' || url.pathname === '/index.html') && req.method === 'GET') {
    const html = fs.readFileSync(path.join(HERE, 'web', 'index.html'), 'utf-8')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end(html)
  }

  res.writeHead(404)
  res.end('not found')
})

loadState()
server.listen(PORT, '127.0.0.1', () => {
  // 打**实际绑定的端口**,不是 PORT 变量。PORT=0(让系统分配)或将来做端口顺延时,
  // 打变量会输出一个谁也连不上的地址 —— 而日志看起来完全正常。
  const actual = server.address()?.port ?? PORT
  console.log(`上游监控看板 → http://127.0.0.1:${actual}`)
  console.log(`台账: ${LEDGER}`)
  console.log(`鉴权: ${TOKEN ? '已启用(Bearer / ?token=)' : '未设 AUTH_TOKEN(仅本机可访问)'}`)
})

// 启动即抓一次,之后按 REFRESH_HOURS 定时(用户定的一天一次)
void runOnce()
// setInterval 的延时是 32 位有符号毫秒,超过 2147483647 会被**静默截断成 1ms**
// (Node 只打一条 TimeoutOverflowWarning)—— 实测 REFRESH_HOURS=9999 会变成
// 每毫秒抓一次,把 GitHub 配额和自己的 CPU 一起烧光。夹到上限即可:
// 反正是"约等于永不",语义没丢。
const MAX_INTERVAL_MS = 2147483647
const intervalMs = Math.min(REFRESH_HOURS * 3600 * 1000, MAX_INTERVAL_MS)
if (REFRESH_HOURS * 3600 * 1000 > MAX_INTERVAL_MS) {
  console.warn(
    `REFRESH_HOURS=${REFRESH_HOURS} 超过 setInterval 上限,已夹到 ${Math.round(MAX_INTERVAL_MS / 3600000)} 小时`
  )
}
setInterval(() => void runOnce(), intervalMs).unref()
