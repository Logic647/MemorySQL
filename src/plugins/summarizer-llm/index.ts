import type { MemorySQLPlugin, SummarizerProvider } from '../../main/core/plugin-host'
import type { RawMessage } from '../../shared/types'

/** LLM provider ids the settings UI offers. */
export type LlmProviderId = 'none' | 'openai' | 'anthropic' | 'ollama'

export interface LlmConfig {
  provider: LlmProviderId
  openaiKey: string
  openaiBaseUrl: string
  openaiModel: string
  anthropicKey: string
  anthropicBaseUrl: string
  anthropicModel: string
  ollamaUrl: string
  ollamaModel: string
}

export const LLM_DEFAULTS: LlmConfig = {
  provider: 'none',
  openaiKey: '',
  openaiBaseUrl: 'https://api.openai.com/v1',
  openaiModel: 'gpt-4o-mini',
  anthropicKey: '',
  anthropicBaseUrl: 'https://api.anthropic.com',
  anthropicModel: 'claude-3-5-haiku-latest',
  ollamaUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'qwen2.5:7b'
}

const SYSTEM_PROMPT =
  '你是开发会话摘要器。阅读一次人机协作开发会话的片段,输出严格的 JSON(不要 markdown 代码块,不要多余文字):' +
  '{"title":"不超过40字的会话标题","summary":"三行以内,格式:目标: …\\n结果: …\\n规模: N条消息"}'

/** Deterministic transcript builder — keeps prompts small and testable. */
export function buildTranscript(messages: RawMessage[]): string {
  const users = messages.filter((m) => m.role === 'user')
  const assistants = messages.filter((m) => m.role === 'assistant')
  const tools = messages.filter((m) => m.role === 'tool')
  const clip = (s: string, n: number): string => {
    const t = s.replace(/\s+/g, ' ').trim()
    return t.length > n ? `${t.slice(0, n)}…` : t
  }
  const parts = [
    users[0] && `用户最初请求: ${clip(users[0].content, 800)}`,
    users[1] && `用户后续请求: ${clip(users[1].content, 300)}`,
    assistants.length > 0 && `助手最终回复: ${clip(assistants[assistants.length - 1].content, 600)}`,
    `统计: ${messages.length} 条消息, ${tools.length} 次工具调用`
  ].filter(Boolean)
  return parts.join('\n')
}

/** Tolerant parser: strict JSON preferred, line-heuristic fallback. */
export function parseLlmResponse(text: string): { title: string; summary: string } | null {
  const cleaned = text.replace(/```json|```/g, '').trim()
  try {
    const parsed = JSON.parse(cleaned) as { title?: unknown; summary?: unknown }
    if (typeof parsed.title === 'string' && parsed.title.trim()) {
      return { title: parsed.title.trim().slice(0, 80), summary: String(parsed.summary ?? '').slice(0, 600) }
    }
  } catch {
    // fall through to line parsing
  }
  const lines = cleaned.split('\n').map((l) => l.trim()).filter(Boolean)
  const title = lines.find((l) => l.length >= 4 && !l.startsWith('{'))
  if (!title) return null
  return { title: title.replace(/^["']|["']$/g, '').slice(0, 80), summary: lines.slice(1).join('\n').slice(0, 600) }
}

async function callLlm(cfg: LlmConfig, transcript: string): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 25_000)
  try {
    let url: string
    let headers: Record<string, string>
    let body: unknown
    if (cfg.provider === 'openai') {
      url = `${cfg.openaiBaseUrl.replace(/\/$/, '')}/chat/completions`
      headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.openaiKey}` }
      body = {
        model: cfg.openaiModel,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: transcript }
        ],
        temperature: 0.2,
        max_tokens: 300
      }
    } else if (cfg.provider === 'anthropic') {
      url = `${cfg.anthropicBaseUrl.replace(/\/$/, '')}/v1/messages`
      headers = {
        'Content-Type': 'application/json',
        'x-api-key': cfg.anthropicKey,
        'anthropic-version': '2023-06-01'
      }
      body = {
        model: cfg.anthropicModel,
        max_tokens: 300,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: transcript }]
      }
    } else {
      url = `${cfg.ollamaUrl.replace(/\/$/, '')}/api/chat`
      headers = { 'Content-Type': 'application/json' }
      body = {
        model: cfg.ollamaModel,
        stream: false,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: transcript }
        ],
        options: { temperature: 0.2 }
      }
    }
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    })
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const data = (await res.json()) as Record<string, unknown>
    if (cfg.provider === 'anthropic') {
      const content = data.content as Array<{ type: string; text?: string }> | undefined
      return content?.map((c) => c.text ?? '').join('') ?? ''
    }
    if (cfg.provider === 'ollama') {
      const message = data.message as { content?: string } | undefined
      return message?.content ?? ''
    }
    const choices = data.choices as Array<{ message?: { content?: string } }> | undefined
    return choices?.[0]?.message?.content ?? ''
  } finally {
    clearTimeout(timer)
  }
}

const plugin: MemorySQLPlugin = {
  manifest: {
    id: 'summarizer-llm',
    name: 'Summarizer: LLM (optional)',
    version: '0.1.0'
  },

  init(ctx) {
    const getConfig = (): LlmConfig => {
      const merged = { ...LLM_DEFAULTS }
      const rec = merged as unknown as Record<string, unknown>
      for (const key of Object.keys(LLM_DEFAULTS)) {
        rec[key] = ctx.settings.get(key, LLM_DEFAULTS[key as keyof LlmConfig])
      }
      return merged
    }

    const provider: SummarizerProvider = {
      id: 'llm',
      available: () => {
        const cfg = getConfig()
        if (cfg.provider === 'none') return false
        if (cfg.provider === 'openai') return cfg.openaiKey.trim().length > 0
        if (cfg.provider === 'anthropic') return cfg.anthropicKey.trim().length > 0
        return cfg.ollamaUrl.trim().length > 0
      },
      summarize: async (input) => {
        const cfg = getConfig()
        if (!provider.available()) return null
        const text = await callLlm(cfg, buildTranscript(input.messages))
        return parseLlmResponse(text)
      }
    }

    // registered BEFORE summarizer-rules (host picks the first available),
    // so a configured LLM wins and everything falls back to rules otherwise
    ctx.summarizer.registerProvider(provider)

    ctx.ipc.handle('getConfig', () => {
      const cfg = getConfig()
      // never leak the raw key to the renderer
      return {
        ...cfg,
        openaiKey: cfg.openaiKey ? '•'.repeat(8) : '',
        anthropicKey: cfg.anthropicKey ? '•'.repeat(8) : '',
        hasOpenaiKey: cfg.openaiKey.trim().length > 0,
        hasAnthropicKey: cfg.anthropicKey.trim().length > 0,
        available: provider.available()
      }
    })
    ctx.ipc.handle('setConfig', (payload) => {
      const next = (payload ?? {}) as Partial<LlmConfig>
      for (const key of Object.keys(LLM_DEFAULTS) as Array<keyof LlmConfig>) {
        if (key in next) {
          // masked values from the UI never overwrite a stored key
          if ((key === 'openaiKey' || key === 'anthropicKey') && String(next[key]).startsWith('•')) continue
          ctx.settings.set(key, next[key])
        }
      }
      return { ok: true }
    })
  }
}

export default plugin
