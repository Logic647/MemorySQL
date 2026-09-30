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

const HERE = path.dirname(fileURLToPath(import.meta.url))
const STATE = path.join(HERE, 'state.json')
const LEDGER = process.env.LEDGER_PATH ?? path.join(HERE, '..', '..', 'upstream', 'ledger.json')
const PORT = Number(process.env.PORT ?? 8788)
const REFRESH_HOURS = Number(process.env.REFRESH_HOURS ?? 24)
const TOKEN = process.env.AUTH_TOKEN ?? ''

let state = { results: [], lastRunAt: null, running: false, error: null }

function loadLedger() {
  const raw = JSON.parse(fs.readFileSync(LEDGER, 'utf-8'))
  return { agents: raw.agents ?? [], riskKeywords: raw.riskKeywords ?? [] }
}

function loadState() {
  try {
    if (fs.existsSync(STATE)) state = { ...state, ...JSON.parse(fs.readFileSync(STATE, 'utf-8')) }
  } catch {
    /* 损坏则用默认值,下次刷新覆盖 */
  }
}

// 原子写:先写临时文件再 rename,避免进程被杀时留下半截 JSON
function saveState() {
  const tmp = `${STATE}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8')
  fs.renameSync(tmp, STATE)
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
    state.lastRunAt = new Date().toISOString()
  } catch (e) {
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

  if (url.pathname === '/api/refresh' && req.method === 'POST') {
    void runOnce().then(() => json(res, 200, state))
    return
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
        saveState()
        json(res, 200, state)
      } catch (e) {
        json(res, 400, { error: String(e?.message ?? e) })
      }
    })
    return
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const html = fs.readFileSync(path.join(HERE, 'web', 'index.html'), 'utf-8')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end(html)
  }

  res.writeHead(404)
  res.end('not found')
})

loadState()
server.listen(PORT, '127.0.0.1', () => {
  console.log(`上游监控看板 → http://127.0.0.1:${PORT}`)
  console.log(`台账: ${LEDGER}`)
  console.log(`鉴权: ${TOKEN ? '已启用(Bearer / ?token=)' : '未设 AUTH_TOKEN(仅本机可访问)'}`)
})

// 启动即抓一次,之后按 REFRESH_HOURS 定时(用户定的一天一次)
void runOnce()
setInterval(() => void runOnce(), REFRESH_HOURS * 3600 * 1000).unref()
