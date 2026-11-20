// magpie 的四种协议（chat / responses / anthropic / gemini）的读写适配。
//
// 注入：把续接包追加到**第一条用户消息**。这样后续请求里客户端带回的
// 历史前缀不变，provider 的 prompt cache 不会被每一轮新内容打碎。
// 捕获：把请求里的 user/assistant 文本 + 本轮回复还原成一场对话。
export const CONTEXT_TAG = '<memorysql-context>'
export const CONTEXT_END = '</memorysql-context>'

const TEXT_TYPES = new Set(['text', 'input_text', 'output_text'])

function partText(part, protocol, role) {
  if (!part || typeof part !== 'object') return ''
  if (typeof part.text !== 'string') return ''
  if (protocol === 'gemini' && part.thought === true) return ''
  if (protocol === 'gemini' || protocol === 'anthropic') return part.text
  // Responses: 只认文本类；Chat: type 缺省也当文本（部分客户端会省）
  if (part.type === undefined || TEXT_TYPES.has(part.type)) return part.text
  return ''
}

function listText(value, protocol, role) {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map((p) => partText(p, protocol, role))
    .filter((t) => t.length > 0)
    .join('\n')
}

function pushPart(message, key, protocol, role, text) {
  if (protocol === 'gemini') {
    if (!Array.isArray(message.parts)) return false
    message.parts.push({ text })
    return true
  }
  if (typeof message[key] === 'string') {
    message[key] = `${message[key]}\n\n${text}`
    return true
  }
  if (!Array.isArray(message[key])) return false
  message[key].push({
    type: protocol === 'responses' ? (role === 'assistant' ? 'output_text' : 'input_text') : 'text',
    text
  })
  return true
}

/**
 * 请求里每个 user/assistant 文本轮次，附带追加文本的方法。
 * 工具调用、图片、思考、system 提示原样保留，不参与注入/捕获。
 */
export function conversationTurns(body, protocol) {
  if (!body || typeof body !== 'object') return []
  if (protocol === 'responses' && typeof body.input === 'string') {
    return [
      {
        index: 0,
        role: 'user',
        text: body.input,
        append: (text) => {
          body.input = `${body.input}\n\n${text}`
          return true
        }
      }
    ]
  }
  const list =
    protocol === 'gemini'
      ? body.contents
      : protocol === 'responses'
        ? body.input
        : protocol === 'anthropic'
          ? body.messages
          : body.messages
  if (!Array.isArray(list)) return []
  const out = []
  list.forEach((message, index) => {
    if (!message || typeof message !== 'object') return
    if (protocol === 'responses' && message.type !== undefined && message.type !== 'message') return
    const role =
      message.role === 'user'
        ? 'user'
        : message.role === 'assistant' || (protocol === 'gemini' && message.role === 'model')
          ? 'assistant'
          : undefined
    if (!role) return
    const key = protocol === 'gemini' ? 'parts' : 'content'
    const text = listText(message[key], protocol, role)
    if (!text) return
    out.push({
      index,
      role,
      text,
      append: (extra) => pushPart(message, key, protocol, role, extra)
    })
  })
  return out
}

export function firstUserTurn(body, protocol) {
  return conversationTurns(body, protocol).find((t) => t.role === 'user')
}

/** 请求里是否已经有 MemorySQL 注入块（防止同一段上下文被塞两遍）。 */
export function hasInjectedContext(body, protocol) {
  const turn = firstUserTurn(body, protocol)
  return Boolean(turn && turn.text.includes(CONTEXT_TAG))
}

/**
 * 把续接包注入第一条用户消息。返回注入的字节数；没有用户消息/已注入时 0。
 * 注意：调用方应先保存原始历史（capture），再注入。
 */
export function injectContext(body, protocol, block, { maxBytes = 6000 } = {}) {
  if (!block || hasInjectedContext(body, protocol)) return 0
  const turn = firstUserTurn(body, protocol)
  if (!turn) return 0
  const clipped = block.length > maxBytes ? `${block.slice(0, maxBytes)}\n…[MemorySQL 上下文已截断]` : block
  const wrapped = `${CONTEXT_TAG}\n${clipped}\n${CONTEXT_END}`
  if (!turn.append(`\n\n${wrapped}`)) return 0
  return typeof Buffer !== 'undefined' ? Buffer.byteLength(wrapped, 'utf8') : wrapped.length
}

/** 本轮回复里的 assistant 文本；取不到时返回空串。 */
export function replyText(reply, protocol) {
  if (!reply || typeof reply !== 'object') return ''
  if (protocol === 'chat') {
    const message = reply.choices?.[0]?.message
    if (!message) return ''
    return listText(message.content, protocol, 'assistant')
  }
  if (protocol === 'responses') {
    if (typeof reply.output_text === 'string' && reply.output_text) return reply.output_text
    if (Array.isArray(reply.output)) {
      const texts = []
      for (const item of reply.output) {
        if (!item || typeof item !== 'object') continue
        if (item.type !== 'message' && item.role !== 'assistant') continue
        const text = listText(item.content, protocol, 'assistant')
        if (text) texts.push(text)
      }
      if (texts.length > 0) return texts.join('\n')
    }
    const message = reply.choices?.[0]?.message
    return message ? listText(message.content, protocol, 'assistant') : ''
  }
  if (protocol === 'anthropic') {
    if (!Array.isArray(reply.content)) return ''
    return reply.content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
  }
  if (protocol === 'gemini') {
    const parts = reply.candidates?.[0]?.content?.parts
    if (!Array.isArray(parts)) return ''
    return parts
      .filter((p) => p && typeof p.text === 'string' && p.thought !== true)
      .map((p) => p.text)
      .join('\n')
  }
  return ''
}
