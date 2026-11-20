// magpie 的异步网关钩子。
//
// onRequest：会话第一次经过网关时向知识库要一份「续接包」，追加到
//   第一条用户消息；之后每条请求复用同一份缓存块（prompt cache 友好）。
// onResponse：把本轮对话回写成会话（内置存储默认开；app 后端默认关，
// 避免和 MemorySQL 自己的文件捕获双写）。
//
// 任何失败都 fail open：请求原样放行，绝不因为知识库不可用而挡住 agent。
import crypto from 'node:crypto'
import { getBackend } from './lib/backend/index.mjs'
import { agentTypeOf, mapAgent } from './lib/agent-map.mjs'
import { conversationTurns, injectContext, replyText } from './lib/protocol.mjs'

const BLOCK_TTL = 6 * 3600_000
const MAX_CAPTURE_MESSAGES = 4000
const DEFAULT_MAX_BYTES = 6000
// magpie 的默认钩子预算是 1s；package.json 里的 gatewayTimeoutMs 只是
// 给 UI/plugins.json 的默认值，不保证一定会传到插件。内部 fetch 再留余量。
const DEFAULT_GATEWAY_TIMEOUT = 1000

// magpie 自己的内部请求（记忆蒸馏、标题、分类）不注入，避免自我污染
const ALWAYS_SKIP = new Set(['memory', 'magpie memory', 'title', 'classifier', 'category'])

/** session → {text, at}；宿主重启即清空，下一轮重新取 */
const blocks = new Map()

export function reset() {
  blocks.clear()
}

function clamp(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(Math.floor(n), min), max)
}

function normalize(options = {}, defaultCapture = false) {
  const gatewayTimeoutMs = clamp(options.gatewayTimeoutMs, DEFAULT_GATEWAY_TIMEOUT, 300, 30_000)
  return {
    backend: options.backend === 'app' ? 'app' : 'embedded',
    port: clamp(options.port, 8642, 1, 65535),
    endpoint: typeof options.endpoint === 'string' ? options.endpoint : undefined,
    dataDir: typeof options.dataDir === 'string' ? options.dataDir : undefined,
    recall: options.recall === true,
    capture: options.capture === undefined ? defaultCapture : options.capture === true,
    maxBytes: clamp(options.maxBytes, DEFAULT_MAX_BYTES, 512, 16_000),
    gatewayTimeoutMs,
    // 没显式配置时按 magpie 的 1s 默认预算留 250ms；显式配置时按配置算。
    // 本地 MCP 查询通常几十毫秒，超时就 fail open。
    timeoutMs:
      options.gatewayTimeoutMs === undefined
        ? Math.min(750, gatewayTimeoutMs - 250)
        : Math.max(200, gatewayTimeoutMs - 250),
    skipAgents: skipSet(options.skipAgents),
    skipSubagents: options.skipSubagents !== false,
    recallRemote: options.recallRemote === true,
    captureRemote: options.captureRemote === true
  }
}

function skipSet(value) {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : []
  return new Set(list.map((v) => agentKey(v)).filter(Boolean))
}

function agentKey(name) {
  return typeof name === 'string'
    ? name.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')
    : ''
}

function isSkipped(ctx, options) {
  const key = agentKey(ctx.agent)
  if (key && ALWAYS_SKIP.has(key)) return true
  if (key && options.skipAgents.has(key)) return true
  if (options.skipSubagents && ctx.kind === 'subagent') return true
  return false
}

/** 只有本机请求默认参与；远程/网关密钥要显式打开对应开关。 */
function allowedOrigin(ctx, options, kind) {
  if (ctx.origin === 'local' || ctx.origin === 'magpie-key') return true
  if (kind === 'recall') return options.recallRemote === true
  return options.captureRemote === true
}

function firstLine(text) {
  const line = String(text ?? '')
    .split('\n')
    .find((l) => l.trim().length > 0)
  return (line ?? '').trim().slice(0, 80)
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function sessionKey(ctx, body) {
  if (ctx.session) return `s:${agentKey(ctx.agent)}\0${ctx.session}`
  const turns = conversationTurns(body, ctx.protocol)
  const firstUser = turns.find((t) => t.role === 'user')?.text ?? ''
  const seed = `${ctx.cwd ?? ''}\0${firstUser.slice(0, 2000)}`
  return seed.trim() ? `h:${digest(seed)}` : 'default'
}

function externalIdOf(ctx, body) {
  if (ctx.session) return ctx.session
  if (!ctx.cwd) return undefined
  const turns = conversationTurns(body, ctx.protocol)
  const firstUser = turns.find((t) => t.role === 'user')?.text ?? ''
  if (!firstUser.trim()) return undefined
  return `magpie:${digest(`${ctx.cwd}\0${firstUser.slice(0, 2000)}`)}`
}

/** 保存客户端自己的历史（注入前），供 onResponse 回写。 */
function bindCapture(body, ctx, options) {
  if (!options.capture || !allowedOrigin(ctx, options, 'capture') || isSkipped(ctx, options)) return
  const messages = conversationTurns(body, ctx.protocol)
    .filter((t) => t.role === 'user' || t.role === 'assistant')
    .map((t) => ({ role: t.role, content: t.text }))
  if (messages.length === 0) return
  const externalId = externalIdOf(ctx, body)
  if (!externalId) return
  const firstUser = messages.find((m) => m.role === 'user')?.content ?? ''
  ctx.state ??= {}
  ctx.state.memorysql = {
    messages,
    agent: agentTypeOf(ctx.agent),
    externalId,
    cwd: typeof ctx.cwd === 'string' && ctx.cwd ? ctx.cwd : undefined,
    title: firstLine(firstUser)
  }
}

async function contextBlock(ctx, options, key, backend) {
  const hit = blocks.get(key)
  if (hit && Date.now() - hit.at < BLOCK_TTL) return { text: hit.text }
  const text = await backend.call(
    'memory_get_context',
    {
      ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
      ...(mapAgent(ctx.agent) ? { agent: mapAgent(ctx.agent) } : {}),
      include_last_session: false
    },
    { timeoutMs: options.timeoutMs, signal: ctx.signal }
  )
  if (!text || !text.trim()) return { empty: true }
  blocks.set(key, { text, at: Date.now() })
  return { text }
}

export async function onRequest(body, ctx) {
  try {
    const backend = await getBackend(ctx.options)
    const options = normalize(ctx.options, backend.kind === 'embedded')
    // 内置存储的「记忆注入」开关在页面上（distill.json）：默认关；
    // 开了可以全部注入，也可以只注入选中的 agent（存的是 agent_type）。
    const rule = typeof backend.recallConfig === 'function' ? backend.recallConfig() : null
    const recallOn = rule ? rule.inject === true : options.recall
    const targets = rule && Array.isArray(rule.agents) ? rule.agents : []
    const allAgents = rule
      ? rule.all === undefined
        ? targets.length === 0
        : rule.all === true
      : true
    // 先按**客户端原始历史**绑定捕获，再注入 —— 回写里不能带续接包
    bindCapture(body, ctx, options)

    if (!recallOn || !allowedOrigin(ctx, options, 'recall') || isSkipped(ctx, options)) {
      ctx.report?.('skipped')
      return undefined
    }
    if (!allAgents && !targets.includes(agentTypeOf(ctx.agent))) {
      ctx.report?.('skipped')
      return undefined
    }
    const key = sessionKey(ctx, body)
    const got = await contextBlock(ctx, options, key, backend)
    if (!got.text) {
      ctx.report?.('empty')
      return undefined
    }
    const bytes = injectContext(body, ctx.protocol, got.text, { maxBytes: options.maxBytes })
    if (bytes === 0) {
      ctx.report?.('skipped')
      return undefined
    }
    ctx.report?.('ready', bytes)
    // 钩子拿到的是请求副本；必须把改动后的 body 返回去，否则原地修改会被丢弃
    return body
  } catch (err) {
    const message = String(err?.message ?? '')
    const unavailable =
      err?.name === 'AbortError' || /未运行|连接中断|ECONNREFUSED|unavailable/i.test(message)
    ctx.report?.(unavailable ? 'unavailable' : 'invalid')
    return undefined
  }
}

export async function onResponse(reply, ctx) {
  try {
    const backend = await getBackend(ctx.options)
    const options = normalize(ctx.options, backend.kind === 'embedded')
    const saved = ctx.state?.memorysql
    if (!saved || !options.capture) return
    if (!allowedOrigin(ctx, options, 'capture') || isSkipped(ctx, options)) return
    const text = replyText(reply, ctx.protocol)
    if (!text || !text.trim()) return
    const messages = [...saved.messages, { role: 'assistant', content: text }]
    if (messages.length > MAX_CAPTURE_MESSAGES) {
      messages.splice(0, messages.length - MAX_CAPTURE_MESSAGES)
    }
    await backend.call(
      'memory_import_session',
      {
        agent: saved.agent,
        externalId: saved.externalId,
        ...(saved.cwd ? { cwd: saved.cwd } : {}),
        ...(saved.title ? { title: saved.title } : {}),
        endedAt: Math.floor(Date.now() / 1000),
        messages
      },
      { timeoutMs: 5000 }
    )
  } catch {
    /* capture is best-effort; the reply is already on its way */
  }
}
