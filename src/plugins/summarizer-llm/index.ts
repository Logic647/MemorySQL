import { LLM_PRESETS, presetById } from '../../shared/llm-presets'
import type { MemorySQLPlugin, SummarizerProvider } from '../../main/core/plugin-host'
import { redactWithCount } from '../../main/core/redact'
import type { RawMessage } from '../../shared/types'

const LLM_PRESET_IDS = LLM_PRESETS.map((p) => p.id)

/** LLM provider ids the settings UI offers. */
export type LlmProviderId = 'none' | 'openai' | 'anthropic' | 'ollama'

export interface LlmConfig {
  provider: LlmProviderId
  /** OpenAI 兼容预设 id('' = 未选);认证/token 策略跟随预设 */
  preset: string
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
  preset: '',
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

/**
 * OpenAI 兼容请求三件套(纯函数,兼容策略由单测锁定):
 *
 * 认证 —— 有 key 时同时发 `Authorization: Bearer` 与 `api-key` 双头:MiMo 只认
 * api-key,其他家认 Bearer,多余的头一律被忽略(双发已在 check-llm/看板链路长期
 * 验证)。免 key 预设(本地反代/自定义网关)两个头都不发。
 *
 * token 上限 —— 默认只发 `max_tokens`(OpenAI 严格模式对两字段同发会 400);
 * 需要 `max_completion_tokens` 的家(MiMo)由预设声明 tokens:'both'。
 */
export function openaiCompatRequest(
  cfg: Pick<LlmConfig, 'preset' | 'openaiBaseUrl' | 'openaiKey' | 'openaiModel'>,
  transcript: string,
  maxTokens: number,
  system: string = SYSTEM_PROMPT
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const key = cfg.openaiKey.trim()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (key) {
    headers.Authorization = `Bearer ${key}`
    headers['api-key'] = key
  }
  const body: Record<string, unknown> = {
    model: cfg.openaiModel,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: transcript }
    ],
    temperature: 0.2,
    max_tokens: maxTokens
  }
  if ((presetById(cfg.preset)?.tokens ?? 'max_tokens') === 'both') {
    body.max_completion_tokens = maxTokens
  }
  return {
    url: `${cfg.openaiBaseUrl.replace(/\/$/, '')}/chat/completions`,
    headers,
    body
  }
}

/** OpenAI 兼容端点是否就绪:Base URL 必填;key 仅对非免 key 预设必填。 */
export function isOpenaiReady(cfg: Pick<LlmConfig, 'preset' | 'openaiBaseUrl' | 'openaiKey'>): boolean {
  if (cfg.openaiBaseUrl.trim().length === 0) return false
  if (cfg.openaiKey.trim().length > 0) return true
  return presetById(cfg.preset)?.keyless === true
}

/**
 * 一份配置(无论来自 settings 还是 UI 草稿)当前是否可用。
 * provider.available() 只看已保存配置 —— 测试连接要用这份函数评 UI 传入的草稿,
 * 否则"没保存就点测试"永远报配置不完整(用户实测踩到)。
 */
export function isLlmReady(cfg: LlmConfig): boolean {
  if (cfg.provider === 'none') return false
  if (cfg.provider === 'openai') return isOpenaiReady(cfg)
  if (cfg.provider === 'anthropic') return cfg.anthropicKey.trim().length > 0
  return cfg.ollamaUrl.trim().length > 0
}

async function callLlm(cfg: LlmConfig, transcript: string, maxTokens = 300, system?: string): Promise<string> {
  transcript = redactWithCount(transcript).text
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 45_000)
  try {
    let url: string
    let headers: Record<string, string>
    let body: unknown
    if (cfg.provider === 'openai') {
      const plan = openaiCompatRequest(cfg, transcript, maxTokens, system)
      url = plan.url
      headers = plan.headers
      body = plan.body
    } else if (cfg.provider === 'anthropic') {
      url = `${cfg.anthropicBaseUrl.replace(/\/$/, '')}/v1/messages`
      headers = {
        'Content-Type': 'application/json',
        'x-api-key': cfg.anthropicKey,
        'anthropic-version': '2023-06-01'
      }
      body = {
        model: cfg.anthropicModel,
        max_tokens: maxTokens,
        system: system ?? SYSTEM_PROMPT,
        messages: [{ role: 'user', content: transcript }]
      }
    } else {
      url = `${cfg.ollamaUrl.replace(/\/$/, '')}/api/chat`
      headers = { 'Content-Type': 'application/json' }
      body = {
        model: cfg.ollamaModel,
        stream: false,
        messages: [
          { role: 'system', content: system ?? SYSTEM_PROMPT },
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
    version: '0.2.0'
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
      available: () => isLlmReady(getConfig()),
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

    // raw completion access for other plugins (memory refinement, project
    // digest etc.). system/maxTokens 可覆盖 —— 会话摘要走默认 SYSTEM_PROMPT,
    // 其他用途传自己的系统提示词;describe() 给调用方标注产物来源模型。
    ctx.services.provide('llm-refine', {
      available: () => provider.available(),
      refine: async (prompt: string, opts?: { system?: string; maxTokens?: number }): Promise<string> =>
        callLlm(getConfig(), prompt, opts?.maxTokens ?? 2000, opts?.system),
      describe: (): string => {
        const cfg = getConfig()
        if (cfg.provider === 'openai') return cfg.openaiModel || 'openai-compat'
        if (cfg.provider === 'anthropic') return cfg.anthropicModel || 'anthropic'
        if (cfg.provider === 'ollama') return `ollama:${cfg.ollamaModel}`
        return 'llm'
      }
    })

    // 真发一次补全的连通性自检 —— listModels 只证明鉴权通过,不证明模型能用。
    // 接受可选的未保存配置(UI 直接测界面当前值,不落盘;掩码 Key 会被跳过)。
    ctx.ipc.handle('testConnection', async (payload) => {
      const cfg = getConfig()
      const patch = (payload ?? {}) as Partial<LlmConfig>
      const masked = (k: string): boolean => k.endsWith('Key')
      for (const key of Object.keys(LLM_DEFAULTS) as Array<keyof LlmConfig>) {
        const v = patch[key]
        if (typeof v !== 'string' || (masked(key) && v.startsWith('•'))) continue
        if (key === 'provider' && !['none', 'openai', 'anthropic', 'ollama'].includes(v)) continue
        if (key === 'preset' && !LLM_PRESET_IDS.includes(v) && v !== '') continue
        // 全部字段都是 string,经 Record 视图写入以通过 keyof 的索引赋值检查
        ;(cfg as unknown as Record<string, string>)[key] = v
      }
      if (cfg.provider === 'none') return { ok: false as const, message: '请先选择 LLM 引擎' }
      if (!isLlmReady(cfg)) return { ok: false as const, message: '配置不完整(缺 API Key 或 Base URL)' }
      const t0 = Date.now()
      try {
        // 512 上限给推理型模型留出思考 token(MiMo 实测一次推理就烧 ~136)
        const text = await callLlm(cfg, '连通性测试,请直接回复两个字符:ok', 512)
        const ms = Date.now() - t0
        if (!text.trim()) {
          return { ok: false as const, message: `服务有响应但内容为空(${ms}ms),可能是推理型模型被 token 上限截断`, ms }
        }
        return { ok: true as const, message: `连接成功(${ms}ms):${text.trim().slice(0, 40)}`, ms }
      } catch (e) {
        return { ok: false as const, message: `连接失败:${String(e instanceof Error ? e.message : e)}` }
      }
    })

    // fetch available models from the configured provider
    ctx.ipc.handle('listModels', async () => {
      const cfg = getConfig()
      try {
        if (cfg.provider === 'none') return { ok: false as const, message: '请先选择 LLM 引擎' }
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 15_000)
        let models: string[]
        try {
          if (cfg.provider === 'openai') {
            const res = await fetch(`${cfg.openaiBaseUrl.replace(/\/$/, '')}/models`, {
              headers: { Authorization: `Bearer ${cfg.openaiKey}` },
              signal: controller.signal
            })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const data = (await res.json()) as { data?: Array<{ id?: string }> }
            models = (data.data ?? []).map((m) => m.id ?? '').filter(Boolean)
          } else if (cfg.provider === 'anthropic') {
            const res = await fetch(`${cfg.anthropicBaseUrl.replace(/\/$/, '')}/v1/models`, {
              headers: { 'x-api-key': cfg.anthropicKey, 'anthropic-version': '2023-06-01' },
              signal: controller.signal
            })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const data = (await res.json()) as { data?: Array<{ id?: string }> }
            models = (data.data ?? []).map((m) => m.id ?? '').filter(Boolean)
          } else {
            const res = await fetch(`${cfg.ollamaUrl.replace(/\/$/, '')}/api/tags`, {
              signal: controller.signal
            })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const data = (await res.json()) as { models?: Array<{ name?: string }> }
            models = (data.models ?? []).map((m) => m.name ?? '').filter(Boolean)
          }
        } finally {
          clearTimeout(timer)
        }
        if (models.length === 0) return { ok: false as const, message: '提供商返回了空模型列表' }
        return { ok: true as const, models }
      } catch (e) {
        return { ok: false as const, message: `获取模型列表失败: ${String(e)}` }
      }
    })

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
      const VALID_PROVIDERS = new Set<string>(['none', 'openai', 'anthropic', 'ollama'])
      const VALID_PRESETS = new Set<string>(['', ...LLM_PRESET_IDS])
      for (const key of Object.keys(LLM_DEFAULTS) as Array<keyof LlmConfig>) {
        if (!(key in next)) continue
        const value = next[key]
        // every field is a string; anything else would poison available()/URL building
        if (typeof value !== 'string') continue
        if (key === 'provider' && !VALID_PROVIDERS.has(value)) continue
        if (key === 'preset' && !VALID_PRESETS.has(value)) continue
        // masked values from the UI never overwrite a stored key
        if ((key === 'openaiKey' || key === 'anthropicKey') && value.startsWith('•')) continue
        ctx.settings.set(key, value)
      }
      return { ok: true }
    })
  }
}

export default plugin
