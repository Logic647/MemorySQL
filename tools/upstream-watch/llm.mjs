/**
 * LLM 调用 —— provider 无关的一层,供 evaluate(逐 agent)与 summarize(总体)共用。
 *
 * 为什么不直接写在 evaluate.mjs 里:总体摘要与逐条评估是两种不同的 prompt 与
 * 输出形状,但「端点识别 / 认证头 / token 字段 / 响应解析 / 错误措辞」完全一样。
 * 复制一遍意味着 MiMo 那两处兼容(认证头 `api-key`、`max_completion_tokens`)
 * 以后只需要修两个地方 —— 而上次正是这类"只改了一处"造成静默降级。
 *
 * 设计约束(与项目铁律一致):
 *   - LLM 永远是可选项。未配置 / 调用失败 / 返回非 JSON,一律降级,**绝不抛给调用方**
 *   - 全部返回 { ok, data?, error? },由调用方决定怎么呈现
 */

/** 是否配了 LLM。没配时上层应显示「未启用」而不是「无影响」—— 两者含义完全不同 */
export function llmConfigured() {
  return Boolean(process.env.LLM_API_KEY)
}

/**
 * 各家 provider 的差异都收敛在这里(实测核对自各家官方文档):
 *   - 端点非 anthropic.com 时按 OpenAI 兼容格式发(Bearer + choices[].message.content)
 *   - 认证头并不统一:OpenAI 要 `Authorization: Bearer`,**小米 MiMo 要 `api-key`**。
 *     与其猜,不如两个都发(同一 key 挂两个头无副作用),也可用 LLM_AUTH_HEADER 显式指定
 *   - `max_tokens`(OpenAI 传统)与 `max_completion_tokens`(新标准,MiMo 用后者)一并发送
 */
function buildRequest(prompt, maxTokens) {
  const endpoint = process.env.LLM_BASE_URL ?? 'https://api.anthropic.com/v1/messages'
  const model = process.env.LLM_MODEL ?? 'claude-sonnet-4-5'
  const key = process.env.LLM_API_KEY

  const isAnthropic = /anthropic\.com/.test(endpoint)
  const headers = { 'Content-Type': 'application/json' }
  if (isAnthropic) {
    headers['x-api-key'] = key
    headers['anthropic-version'] = '2023-06-01'
  } else {
    const explicit = process.env.LLM_AUTH_HEADER
    if (explicit) headers[explicit] = key
    else {
      headers.Authorization = `Bearer ${key}`
      headers['api-key'] = key
    }
  }

  return {
    endpoint,
    model,
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        max_completion_tokens: maxTokens,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }]
      })
    }
  }
}

/** 从两种响应形态里取出文本:Anthropic content[].text / OpenAI choices[].message.content */
function extractText(data) {
  return data?.content?.[0]?.text ?? data?.choices?.[0]?.message?.content ?? ''
}

/**
 * 结构化输出有时不走 content 而走 tool_calls(实测 MiMo 的返回里就带着这个字段)。
 * 两条路都试,否则这类"content 是空的"会表现成"LLM 未返回 JSON",极难排查。
 */
function extractCandidates(data) {
  const out = []
  const msg = data?.choices?.[0]?.message
  if (msg) {
    if (typeof msg.content === 'string' && msg.content.trim()) out.push(msg.content)
    if (typeof msg.reasoning_content === 'string' && msg.reasoning_content.trim()) {
      out.push(msg.reasoning_content)
    }
    const args = msg.tool_calls?.[0]?.function?.arguments
    if (typeof args === 'string' && args.trim()) out.push(args)
  }
  const text = extractText(data)
  if (typeof text === 'string' && text.trim()) out.push(text)
  return out
}

/**
 * 从一段文本里抠出 JSON 对象。
 *
 * **不要用 `/\{[\s\S]*\}/` 这种贪婪正则** —— 它从第一个 `{` 吃到最后一个 `}`,
 * 一旦文本里出现两段 JSON、或字符串里含花括号(比如举例说明 schema),
 * 抠出来的就是垃圾。实测踩过:摘要返回偶发解析失败,position 329 落在 actions 数组里。
 * 正确做法是**做括号配平扫描**,并跳过字符串字面量内部的花括号。
 */
export function extractJson(candidates) {
  let lastErr = null
  for (const text of candidates) {
    const s = String(text).trim()
    // 整段就是 JSON(最快的路径,也最常见)
    try {
      return { ok: true, data: JSON.parse(s) }
    } catch (e) {
      lastErr = e
    }
    // 括号配平扫描
    const start = s.indexOf('{')
    if (start < 0) continue
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = start; i < s.length; i++) {
      const c = s[i]
      if (inStr) {
        if (esc) esc = false
        else if (c === '\\') esc = true
        else if (c === '"') inStr = false
        continue
      }
      if (c === '"') inStr = true
      else if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) {
          const slice = s.slice(start, i + 1)
          try {
            return { ok: true, data: JSON.parse(slice) }
          } catch (e) {
            lastErr = e
            // 配平了但解析不了 —— 换下一个候选,别放弃
            break
          }
        }
      }
    }
    // 没配平 = 响应被截断,maxTokens 不够。这是最常见的失败原因,单独报。
    if (depth > 0) lastErr = new Error('JSON 未闭合,响应很可能被 maxTokens 截断')
  }
  return { ok: false, error: lastErr?.message ?? '未找到可解析的 JSON' }
}

/**
 * 调一次 LLM 并要求返回 JSON。
 * @returns {Promise<{ok:true,data:any}|{ok:false,error:string}>} 永不抛异常
 */
export async function callLlmJson(prompt, { maxTokens = 300, timeoutMs = 20000 } = {}) {
  if (!llmConfigured()) return { ok: false, error: '未配置 LLM_API_KEY' }

  const { endpoint, init } = buildRequest(prompt, maxTokens)
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    const res = await fetch(endpoint, { ...init, signal: ctl.signal })
    clearTimeout(timer)

    if (!res.ok) {
      const hint =
        res.status === 401 || res.status === 403
          ? ' —— 认证头可能不对,可用 LLM_AUTH_HEADER 显式指定(如 api-key / Authorization)'
          : ''
      return { ok: false, error: `LLM HTTP ${res.status}${hint}` }
    }

    const data = await res.json()
    // 解析不出 JSON 时把 finish_reason 带出来 —— 'length' 意味着该调大 maxTokens,
    // 这条线索不报出来就只能靠猜(实测因此浪费了一轮排查)。
    const finish = data?.choices?.[0]?.finish_reason
    const parsed = extractJson(extractCandidates(data))
    if (!parsed.ok) {
      const tail = finish === 'length' ? '(响应被 maxTokens 截断,请调大 maxTokens)' : ''
      return { ok: false, error: `LLM 未返回可解析的 JSON: ${parsed.error}${tail}` }
    }
    return { ok: true, data: parsed.data }
  } catch (e) {
    return { ok: false, error: `LLM 调用失败:${e?.message ?? e}` }
  }
}
