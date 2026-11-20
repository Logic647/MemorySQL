// 复用 magpie 网关上已经配置好的模型：插件跑在 magpie 的 Bun 宿主里，
// 直接请求本机 gateway（loopback 不需要 key）。
//
// 模型优先级：插件设置里选的 > magpie 记忆蒸馏上次用的模型（distill.json
// 的 lastModel）> 网关 /v1/models 的第一个。全部失败就退回规则，不阻塞。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_GATEWAY = 'http://127.0.0.1:3425'
let cachedModels = null

export function magpieConfigDir() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(base, 'magpie')
}

/** gateway.json 的 addr 形如 "[::]:3425" / "127.0.0.1:3425" */
export function gatewayBase(options = {}) {
  if (typeof options.gateway === 'string' && /^https?:\/\//i.test(options.gateway.trim())) {
    return options.gateway.trim().replace(/\/+$/, '')
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(magpieConfigDir(), 'gateway.json'), 'utf8'))
    const match = String(cfg?.addr ?? '').match(/:(\d+)\s*$/)
    if (match) return `http://127.0.0.1:${match[1]}`
  } catch {
    /* 网关没起来/文件不在 —— 用默认端口 */
  }
  return DEFAULT_GATEWAY
}

/** magpie 记忆蒸馏上次使用的模型，作为本插件的默认模型。 */
export function magpieMemoryModel() {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(magpieConfigDir(), 'distill.json'), 'utf8'))
    return typeof state?.lastModel === 'string' && state.lastModel ? state.lastModel : ''
  } catch {
    return ''
  }
}

export async function listModels(options = {}, { timeoutMs = 4000 } = {}) {
  const now = Date.now()
  const base = gatewayBase(options)
  if (cachedModels && cachedModels.base === base && now - cachedModels.at < 60_000) {
    return cachedModels.models
  }
  try {
    const res = await fetch(`${base}/v1/models`, {
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!res.ok) return []
    const body = await res.json()
    const models = (Array.isArray(body?.data) ? body.data : [])
      .filter((m) => m && typeof m.id === 'string')
      .map((m) => ({
        id: m.id,
        name: m.display_name || m.name || m.id,
        provider: m.owned_by || m.provider || '',
        reasoning: m.reasoning === true
      }))
    cachedModels = { base, at: now, models }
    return models
  } catch {
    return []
  }
}

/** 选模型：state.model > 插件选项 model > magpie 记忆上次的模型 > 第一个 */
export async function resolveModel(options = {}, preferred = '') {
  if (preferred) return preferred
  if (typeof options.model === 'string' && options.model.trim()) return options.model.trim()
  const fromMagpie = magpieMemoryModel()
  if (fromMagpie) return fromMagpie
  const models = await listModels(options)
  return models[0]?.id ?? ''
}

export async function chat(options = {}, messages, { model, maxTokens = 1600, timeoutMs = 180_000 } = {}) {
  const chosen = await resolveModel(options, model)
  if (!chosen) throw new Error('没有可用模型：请先在 magpie 里配置模型，或在 MemorySQL 页面选择一个')
  const base = gatewayBase(options)
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: chosen,
      messages,
      stream: false,
      max_tokens: maxTokens
    }),
    signal: AbortSignal.timeout(timeoutMs)
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`模型 ${chosen} 请求失败（HTTP ${res.status}）：${text.slice(0, 300)}`)
  }
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`模型 ${chosen} 返回的不是 JSON：${text.slice(0, 200)}`)
  }
  const message = body?.choices?.[0]?.message
  const content =
    typeof message?.content === 'string'
      ? message.content
      : Array.isArray(message?.content)
        ? message.content
            .filter((p) => p && typeof p.text === 'string')
            .map((p) => p.text)
            .join('\n')
        : ''
  if (!content.trim()) {
    throw new Error(`模型 ${chosen} 返回了空内容（finish_reason=${body?.choices?.[0]?.finish_reason ?? '?'}）`)
  }
  return { model: chosen, content, usage: body?.usage ?? null }
}

/** 从回复里抠出第一个 JSON 数组/对象：支持 ```json 围栏和前后废话。 */
export function jsonFrom(text, kind = 'array') {
  const s = String(text ?? '')
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const source = fence ? fence[1] : s
  const open = kind === 'array' ? '[' : '{'
  const close = kind === 'array' ? ']' : '}'
  const start = source.indexOf(open)
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === open) depth += 1
    else if (ch === close) {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}
