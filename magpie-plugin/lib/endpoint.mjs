// MemorySQL 的本地 MCP 端点发现与调用。
//
// MemorySQL 的 MCP 服务只绑 127.0.0.1；端口被占用时会自动 +1（最多 10 次），
// 所以「配置的端口」不等于「实际端口」。/health 返回 server/port/version/tools，
// 用它做探活与端口扫描；发现结果缓存 30 秒，避免每个请求都扫一遍。
const DEFAULT_PORT = 8642
const SCAN_PORTS = 11

/** {value, at} —— 同一个 Bun 宿主里 tools / hooks / 页面服务共用 */
let cached = null

export function resetEndpointCache() {
  cached = null
}

function toPort(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 && n < 65536 ? Math.floor(n) : null
}

function parseEndpoint(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return toPort(url.port || (url.protocol === 'https:' ? 443 : 80))
  } catch {
    return null
  }
}

/** 一个带超时的 AbortSignal；父 signal 中止时一并中止。 */
function timeoutSignal(ms, parent) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(new Error('timeout')), Math.max(50, ms))
  timer.unref?.()
  const onAbort = () => ctl.abort(parent?.reason)
  const done = () => {
    clearTimeout(timer)
    parent?.removeEventListener?.('abort', onAbort)
  }
  if (parent) {
    if (parent.aborted) onAbort()
    else parent.addEventListener?.('abort', onAbort, { once: true })
  }
  ctl.signal.addEventListener('abort', done, { once: true })
  return ctl.signal
}

/**
 * 找到正在运行的 MemorySQL。
 *
 * scan=false 时只试「显式 endpoint / 配置端口 / 8642」—— 网关钩子有 1 秒
 * 预算，不能把 11 个端口全扫一遍；工具调用和页面可以 scan。
 */
export async function discoverEndpoint(options = {}, { scan = true, signal } = {}) {
  const candidates = []
  const explicit = parseEndpoint(options.endpoint)
  if (explicit) candidates.push(explicit)
  const configured = toPort(options.port)
  if (configured) candidates.push(configured)
  candidates.push(DEFAULT_PORT)
  if (scan) {
    for (let i = 0; i < SCAN_PORTS; i++) candidates.push(DEFAULT_PORT + i)
  }
  const seen = new Set()
  for (const port of candidates) {
    if (!port || seen.has(port)) continue
    seen.add(port)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: timeoutSignal(200, signal)
      })
      if (!res.ok) continue
      const body = await res.json()
      if (!body || body.server !== 'memorysql-mcp') continue
      return {
        baseUrl: `http://127.0.0.1:${port}`,
        port,
        version: String(body.version ?? ''),
        tools: Number(body.tools) || 0,
        stats: body.stats ?? null
      }
    } catch {
      /* 端口没开、或不是 MemorySQL —— 继续下一个 */
    }
  }
  return null
}

export async function getEndpoint(options = {}, opts = {}) {
  const now = Date.now()
  if (!opts.fresh && cached && now - cached.at < 30_000) return cached.value
  const found = await discoverEndpoint(options, opts)
  if (found) cached = { value: found, at: now }
  return found
}

async function rpc(baseUrl, name, args, signal) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args ?? {} }
    }),
    signal
  })
  if (!res.ok) {
    const err = new Error(`MemorySQL MCP HTTP ${res.status}`)
    err.httpStatus = res.status
    throw err
  }
  const body = await res.json()
  if (body?.error) {
    throw new Error(`MemorySQL 工具 ${name} 失败：${body.error.message ?? 'unknown'}`)
  }
  const content = Array.isArray(body?.result?.content) ? body.result.content : []
  const text = content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
  if (body?.result?.isError) throw new Error(text || `MemorySQL 工具 ${name} 返回错误`)
  return text
}

/**
 * 调一个 MemorySQL MCP 工具。
 *
 * 端点失效（应用重启/端口漂移）时重新发现一次；仍失败就把错误抛给调用方，
 * 由工具/hook 决定是回错误文本还是 fail open。
 */
export async function callTool(name, args, options = {}, { timeoutMs = 10_000, signal } = {}) {
  let endpoint = await getEndpoint(options, { scan: true, signal })
  if (!endpoint) {
    throw new Error(
      'MemorySQL 未运行（127.0.0.1 上找不到 /health）。请先启动 MemorySQL；若端口改过，在插件选项 port 里指定。'
    )
  }
  try {
    return await rpc(endpoint.baseUrl, name, args, timeoutSignal(timeoutMs, signal))
  } catch (err) {
    // 连接被拒：端口可能变了（MemorySQL 的冲突自增），重新发现一次。
    // 超时（AbortError）不重试 —— 重试只会把剩余的钩子预算也吃掉。
    if (err?.httpStatus === undefined && err?.cause?.code === 'ECONNREFUSED') {
      resetEndpointCache()
      endpoint = await getEndpoint(options, { scan: true, fresh: true, signal })
      if (!endpoint) throw new Error('MemorySQL 未运行（连接中断，重新发现失败）。')
      return await rpc(endpoint.baseUrl, name, args, timeoutSignal(timeoutMs, signal))
    }
    throw err
  }
}
