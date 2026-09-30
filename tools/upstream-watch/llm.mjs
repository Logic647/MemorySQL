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

    const text = extractText(await res.json())
    const m = String(text).match(/\{[\s\S]*\}/)
    if (!m) return { ok: false, error: 'LLM 未返回 JSON' }
    return { ok: true, data: JSON.parse(m[0]) }
  } catch (e) {
    return { ok: false, error: `LLM 调用失败:${e?.message ?? e}` }
  }
}
