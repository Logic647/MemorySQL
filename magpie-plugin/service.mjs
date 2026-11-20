// magpie 窗口里的 MemorySQL 页面所依赖的本地服务。
//
// magpie 的插件页面跑在 sandbox="allow-scripts" 的 iframe 里，connect-src
// 'none'，不能直接 fetch。社区做法是「带路页」：page/index.html 只负责把
// 框架导航到本服务（127.0.0.1:<pagePort>），真正的 UI 由这里提供，同源
// fetch 自己的 /api/*，再由服务走当前后端（内置 SQLite 或 MemorySQL 应用）。
import fs from 'node:fs'
import http from 'node:http'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getBackend } from './lib/backend/index.mjs'
import { mapAgent } from './lib/agent-map.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_PORT = 3488
// 每次宿主启动换一个 token，注入到页面 HTML 的 <meta>；API 必须带它。
// sandbox iframe 的 Origin 是 null，任何站点都能嵌一个 sandbox 去 fetch
// loopback——没有 token 的话本地记忆会被任意网页读走。
const TOKEN = crypto.randomBytes(32).toString('hex')
const TOKEN_HEADER = 'x-memorysql-token'

let instance = null
let starting = null

function clamp(value, fallback, min, max) {
  // Number(null) === 0：参数没传时必须用 fallback，否则会被夹到 min（搜索只剩 1 条）。
  if (value == null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(Math.floor(n), min), max)
}

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  })
  res.end(text)
}

function staticFile(name, type) {
  return { file: path.join(ROOT, name), type }
}

const STATIC = new Map([
  ['/', staticFile('ui/index.html', 'text/html; charset=utf-8')],
  ['/index.html', staticFile('ui/index.html', 'text/html; charset=utf-8')],
  ['/app.js', staticFile('ui/app.js', 'text/javascript; charset=utf-8')],
  ['/style.css', staticFile('ui/style.css', 'text/css; charset=utf-8')],
  ['/icon.png', staticFile('page/icon.png', 'image/png')]
])

function securityHeaders(res, port) {
  const origin = `http://127.0.0.1:${port}`
  res.setHeader('content-security-policy', [
    `default-src 'self' ${origin}`,
    `script-src 'self' ${origin}`,
    `style-src 'self' 'unsafe-inline' ${origin}`,
    `img-src 'self' data: ${origin}`,
    `connect-src 'self' ${origin}`,
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; '))
  res.setHeader('referrer-policy', 'no-referrer')
  res.setHeader('x-content-type-options', 'nosniff')
}

function parseUrl(req) {
  try {
    return new URL(req.url ?? '/', 'http://127.0.0.1')
  } catch {
    return null
  }
}

/** 只放行本服务自己的页面：sandbox 框架的 Origin 是 null，也允许。 */
function originAllowed(req, port) {
  const origin = req.headers.origin
  if (!origin || origin === 'null') return true
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`
}

/**
 * API 的 CORS：sandbox iframe 的 Origin 是 null，必须显式回 null 才能读到响应。
 * 静态 HTML 刻意不加 CORS——token 在 HTML 里，不能让跨源请求读走。
 */
function applyCors(req, res, port) {
  const origin = req.headers.origin
  const own = origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`
  res.setHeader('access-control-allow-origin', origin === 'null' ? 'null' : own ? origin : 'null')
  res.setHeader('access-control-allow-headers', `content-type, accept, ${TOKEN_HEADER}`)
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
  res.setHeader('vary', 'Origin')
}

function tokenOK(req) {
  const got = Buffer.from(String(req.headers[TOKEN_HEADER] ?? ''))
  const want = Buffer.from(TOKEN)
  return got.length === want.length && crypto.timingSafeEqual(got, want)
}

function readJson(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let bytes = 0
    const chunks = []
    req.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch {
        reject(new Error('请求体不是 JSON'))
      }
    })
    req.on('error', reject)
  })
}

async function api(req, res, url, options, backendPromise) {
  const q = url.searchParams
  const method = req.method
  const project = (q.get('project') ?? '').trim()
  const cwd = (q.get('cwd') ?? '').trim()
  const rawAgent = (q.get('agent') ?? '').trim()
  const agent = rawAgent ? (mapAgent(rawAgent) ?? rawAgent) : ''
  try {
    const backend = await (backendPromise ?? getBackend(options))
    const body = method === 'POST' ? await readJson(req) : {}
    const ui = backend.ui
    const requireUi = () => {
      if (ui) return true
      json(res, 200, {
        ok: false,
        error: '记忆管理仅在内置存储后端可用（app 后端请在 MemorySQL 应用里操作）'
      })
      return false
    }

    if (url.pathname === '/api/status') {
      return json(res, 200, await backend.status())
    }
    if (url.pathname === '/api/memories') {
      if (!requireUi()) return
      if (method === 'GET') {
        return json(res, 200, {
          ok: true,
          ...ui.listMemories({
            status: q.get('status'),
            scope: q.get('scope'),
            q: q.get('q'),
            limit: q.get('limit')
          })
        })
      }
      return json(res, 200, ui.saveMemory(body))
    }
    if (url.pathname === '/api/memories/status' && method === 'POST') {
      if (!requireUi()) return
      return json(res, 200, ui.setMemoryStatus(body))
    }
    if (url.pathname === '/api/memories/remove' && method === 'POST') {
      if (!requireUi()) return
      return json(res, 200, ui.removeMemories(body))
    }
    if (url.pathname === '/api/memories/pin' && method === 'POST') {
      if (!requireUi()) return
      return json(res, 200, ui.pinMemory(body))
    }
    if (url.pathname === '/api/distill') {
      if (!requireUi()) return
      if (method === 'GET') return json(res, 200, { ok: true, ...(await ui.distillState()) })
      return json(res, 200, { ok: true, ...(await ui.setDistill(body)) })
    }
    if (url.pathname === '/api/distill/run' && method === 'POST') {
      if (!requireUi()) return
      return json(res, 200, ui.runDistill())
    }
    if (url.pathname === '/api/dream/run' && method === 'POST') {
      if (!requireUi()) return
      return json(res, 200, ui.runDream())
    }
    if (url.pathname === '/api/digest/run' && method === 'POST') {
      if (!requireUi()) return
      return json(res, 200, ui.runDigest())
    }
    if (url.pathname === '/api/sessions/remove' && method === 'POST') {
      if (!requireUi()) return
      return json(res, 200, ui.deleteSessions(body))
    }
    if (url.pathname === '/api/digest/generate' && method === 'POST') {
      if (!requireUi()) return
      return json(res, 200, await ui.generateDigest(body))
    }
    if (method !== 'GET') {
      return json(res, 405, { ok: false, error: 'method not allowed' })
    }

    if (url.pathname === '/api/projects') {
      const body = await backend.call(
        'memory_list_projects',
        { limit: clamp(q.get('limit'), 30, 1, 100), includeEmpty: false, format: 'json' },
        { timeoutMs: 8000 }
      )
      return json(res, 200, { ok: true, projects: JSON.parse(body || '[]') })
    }
    if (url.pathname === '/api/sessions') {
      const args = {
        limit: clamp(q.get('limit'), 20, 1, 100),
        offset: clamp(q.get('offset'), 0, 0, 100000),
        format: 'json'
      }
      if (project) args.project = project
      if (cwd) args.cwd = cwd
      if (agent) args.agent = agent
      if (q.get('since')) args.since = clamp(q.get('since'), 0, 0, 3650)
      const body = await backend.call('memory_list_sessions', args, { timeoutMs: 8000 })
      return json(res, 200, { ok: true, sessions: JSON.parse(body || '[]') })
    }
    if (url.pathname === '/api/search') {
      const query = (q.get('q') ?? '').trim()
      if (!query) return json(res, 400, { ok: false, error: '缺少 q' })
      const args = { query, limit: clamp(q.get('limit'), 20, 1, 100) }
      if (project) args.project = project
      if (cwd) args.cwd = cwd
      if (agent) args.agent = agent
      if (backend.kind === 'embedded') {
        // 页面要结构化命中（会话 id / 命中片段），agent 工具仍用文本输出。
        const text = await backend.call('memory_search', { ...args, format: 'json' }, { timeoutMs: 12_000 })
        let hits = []
        try {
          hits = JSON.parse(text || '[]')
        } catch {
          hits = []
        }
        return json(res, 200, { ok: true, hits })
      }
      const text = await backend.call('memory_search', args, { timeoutMs: 12_000 })
      return json(res, 200, { ok: true, text })
    }
    if (url.pathname === '/api/context') {
      const args = { include_last_session: false }
      if (project) args.project = project
      if (cwd) args.cwd = cwd
      if (agent) args.agent = agent
      const text = await backend.call('memory_get_context', args, { timeoutMs: 12_000 })
      return json(res, 200, { ok: true, text })
    }
    if (url.pathname === '/api/digest') {
      const text = await backend.call(
        'memory_get_project_digest',
        project ? { project } : {},
        { timeoutMs: 8000 }
      )
      return json(res, 200, { ok: true, text })
    }
    if (url.pathname === '/api/session') {
      const id = Number(q.get('id'))
      if (!Number.isFinite(id) || id <= 0) return json(res, 400, { ok: false, error: '缺少 id' })
      const args = { id }
      if (q.get('tail')) args.tail = clamp(q.get('tail'), 0, 0, 2000)
      if (q.get('full') === '1') args.full = true
      const text = await backend.call('memory_get_session', args, { timeoutMs: 12_000 })
      return json(res, 200, { ok: true, text })
    }
    return json(res, 404, { ok: false, error: 'not found' })
  } catch (err) {
    return json(res, 200, { ok: false, error: String(err?.message ?? err) })
  }
}

function createServer(port, options, backendPromise) {
  return http.createServer((req, res) => {
    const host = String(req.headers.host ?? '')
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`])
    if (!allowedHosts.has(host) || !originAllowed(req, port)) {
      res.writeHead(403).end()
      return
    }
    const url = parseUrl(req)
    if (!url) {
      res.writeHead(400).end()
      return
    }
    if (url.pathname.startsWith('/api/')) {
      applyCors(req, res, port)
      // 带自定义 token 头的 GET 会先发一个不带 token 的 OPTIONS 预检
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'access-control-max-age': '600' }).end()
        return
      }
      if (req.method !== 'GET' && req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }
      if (!tokenOK(req)) {
        json(res, 401, { ok: false, error: 'unauthorized — reload the MemorySQL page' })
        return
      }
      securityHeaders(res, port)
      void api(req, res, url, options, backendPromise)
      return
    }
    const file = STATIC.get(url.pathname)
    if (!file) {
      res.writeHead(404).end()
      return
    }
    try {
      let body = fs.readFileSync(file.file)
      if (file.type.startsWith('text/html')) {
        // token 只进页面 HTML；静态资源不带 CORS，跨源读不到它
        body = Buffer.from(
          body
            .toString('utf8')
            .replace('<head>', `<head>\n    <meta name="memorysql-token" content="${TOKEN}">`),
          'utf8'
        )
      }
      securityHeaders(res, port)
      res.writeHead(200, {
        'content-type': file.type,
        'cache-control': 'no-store'
      })
      res.end(body)
    } catch {
      res.writeHead(500).end()
    }
  })
}

/**
 * 启动页面服务。端口被上一个宿主占用时后台重试，不阻塞插件加载。
 * 返回 {port, ready}：ready 在真正 listen 成功后 resolve 实际端口。
 */
export function startService(options = {}, backendPromise = null) {
  if (instance) return instance
  if (starting) return starting
  const port = clamp(options.pagePort, DEFAULT_PORT, 1, 65535)
  const backend = backendPromise ?? getBackend(options)
  const server = createServer(port, options, backend)
  let attempts = 0
  let settle
  const ready = new Promise((resolve, reject) => {
    settle = { resolve, reject }
  })
  starting = { port, ready, server }
  const listen = () => {
    server.once('error', (err) => {
      if (err?.code === 'EADDRINUSE' && attempts < 20) {
        attempts++
        setTimeout(listen, 500)
        return
      }
      console.error('[memorysql] page service failed:', err?.message ?? err)
      starting = null
      settle.reject(err)
    })
    server.listen(port, '127.0.0.1', () => {
      instance = { port, server, ready }
      starting = null
      settle.resolve(port)
      console.log(`[memorysql] page service on http://127.0.0.1:${port}`)
    })
  }
  listen()
  return starting
}

export function stopService() {
  if (instance?.server) {
    try {
      instance.server.close()
    } catch {
      /* already closed */
    }
  }
  instance = null
}
