import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { llmEnhance } from '../tools/upstream-watch/evaluate.mjs'

const agent = {
  id: 'demo',
  name: 'Demo',
  monitor: 'tracked',
  upstream: { kind: 'github', repo: 'x/y' },
  riskKeywords: ['schema', 'rename'],
  mcp: { file: 'a.json', jsonpath: '$.mcp.memorysql', requiredKeys: ['type', 'url'] },
  source: { kind: 'sqlite', sqlite: { tablesAnyOf: [['session']] } }
}

/**
 * LLM 增强 —— 这条路径此前从未被实际跑过(需要 LLM_API_KEY),属于未验证交付。
 * 用 mock fetch 覆盖全部分支:不花钱、不依赖网络,并锁住最重要的性质:
 * **任何失败都必须降级为规则结果,绝不抛异常、绝不吞掉原有结论。**
 */
describe('llmEnhance(LLM 增强,可选)', () => {
  const LLM_VARS = ['LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL', 'LLM_AUTH_HEADER']

  // 逐个清掉,避免上一个用例的设置泄漏到下一个
  // (给 process.env 整体赋值在 Node 里不可靠,实测会造成用例互相污染)
  beforeEach(() => {
    for (const v of LLM_VARS) delete process.env[v]
  })

  afterEach(() => {
    for (const v of LLM_VARS) delete process.env[v]
    vi.unstubAllGlobals()
  })

  const med = (over: Record<string, unknown> = {}) =>
    ({
      agentId: 'demo',
      risk: 'medium',
      riskLabel: '中',
      hits: ['schema'],
      notes: 'changelog body',
      version: null,
      publishedAt: null,
      url: null,
      fetchError: null,
      fallbackUsed: false,
      fallbackReason: null,
      reason: '命中 1 个风险词',
      llm: null,
      ...over
    }) as never

  const anthropicOk = (obj: unknown) => ({
    ok: true,
    json: async () => ({ content: [{ text: '分析如下:\n' + JSON.stringify(obj) }] })
  })

  it('没配 LLM_API_KEY 时原样返回(纯规则)', async () => {
    delete process.env.LLM_API_KEY
    const r = med()
    expect(await llmEnhance(r, agent)).toEqual(r)
  })

  it('risk 为 low/none 时不调用(省 token,也省延迟)', async () => {
    process.env.LLM_API_KEY = 'k'
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    for (const risk of ['low', 'none']) {
      expect((await llmEnhance(med({ risk }), agent)).llm).toBeNull()
    }
    expect(spy).not.toHaveBeenCalled()
  })

  it('正常返回时解析出结论', async () => {
    process.env.LLM_API_KEY = 'k'
    vi.stubGlobal(
      'fetch',
      async () =>
        anthropicOk({ affectsCapture: true, affectsMcp: false, severity: 'high', reason: '改了存储格式' })
    )
    const r = await llmEnhance(med(), agent)
    expect(r.llm?.affectsCapture).toBe(true)
    expect(r.risk).toBe('high')
  })

  it('LLM 只能加严,不能把规则判的 high 降级', async () => {
    process.env.LLM_API_KEY = 'k'
    vi.stubGlobal(
      'fetch',
      async () => anthropicOk({ affectsCapture: false, affectsMcp: false, severity: 'none', reason: '看着不像' })
    )
    const r = await llmEnhance(med({ risk: 'high', riskLabel: '高' }), agent)
    expect(r.risk, 'LLM 把规则判的 high 降级了').toBe('high')
    // 但 LLM 的意见仍要保留给人看
    expect(r.llm?.reason).toBe('看着不像')
  })

  it('HTTP 错误 → 降级为规则结果,不抛', async () => {
    process.env.LLM_API_KEY = 'k'
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 429 }))
    const r = await llmEnhance(med(), agent)
    expect(r.llmError).toContain('429')
    expect(r.risk).toBe('medium')
    expect(r.llm).toBeNull()
  })

  it('网络异常 → 降级,不抛', async () => {
    process.env.LLM_API_KEY = 'k'
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNRESET')
    })
    const r = await llmEnhance(med(), agent)
    expect(r.llmError).toContain('ECONNRESET')
    expect(r.risk).toBe('medium')
  })

  it('返回非 JSON → 降级并保留规则结论', async () => {
    process.env.LLM_API_KEY = 'k'
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({ content: [{ text: '我觉得没问题' }] })
    }))
    const r = await llmEnhance(med(), agent)
    expect(r.llmError).toContain('JSON')
    expect(r.risk).toBe('medium')
  })

  it('OpenAI 兼容端点也能解析(很多 provider 不是 Anthropic)', async () => {
    process.env.LLM_API_KEY = 'k'
    process.env.LLM_BASE_URL = 'https://example.com/v1/chat/completions'
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"affectsCapture":true,"affectsMcp":false,"severity":"high","reason":"x"}' } }]
      })
    }))
    const r = await llmEnhance(med(), agent)
    expect(r.llm?.affectsCapture).toBe(true)
    expect(r.risk).toBe('high')
  })

  /**
   * 认证头:各家不统一 —— 小米 MiMo 的 OpenAI 兼容端点要求 `api-key`,
   * OpenAI 官方要 `Authorization: Bearer`。
   *
   * 注意:不设 LLM_BASE_URL 时**默认端点就是 Anthropic 官方**,走 x-api-key 分支;
   * 要测 OpenAI 兼容分支必须显式给一个非 anthropic.com 的端点。
   */
  it('不设 BASE_URL 时走 Anthropic 分支(x-api-key)', async () => {
    process.env.LLM_API_KEY = 'sk-ant-x'
    delete process.env.LLM_BASE_URL
    let headers: Record<string, string> = {}
    vi.stubGlobal('fetch', async (_u: unknown, init: { headers: Record<string, string> }) => {
      headers = init.headers
      return anthropicOk({ affectsCapture: false, affectsMcp: false, severity: 'low', reason: 'r' })
    })
    await llmEnhance(med(), agent)
    expect(headers['x-api-key']).toBe('sk-ant-x')
    expect(headers['anthropic-version']).toBe('2023-06-01')
  })

  it('非 anthropic 端点(MiMo/OpenAI 兼容)默认同时发两个认证头', async () => {
    process.env.LLM_API_KEY = 'sk-x'
    process.env.LLM_BASE_URL = 'https://api.xiaomimimo.com/v1/chat/completions'
    let headers: Record<string, string> = {}
    vi.stubGlobal('fetch', async (_u: unknown, init: { headers: Record<string, string> }) => {
      headers = init.headers
      return anthropicOk({ affectsCapture: false, affectsMcp: false, severity: 'low', reason: 'r' })
    })
    await llmEnhance(med(), agent)
    expect(headers.Authorization).toBe('Bearer sk-x')
    expect(headers['api-key']).toBe('sk-x')
  })

  it('LLM_AUTH_HEADER 可显式指定认证头(MiMo 用 api-key)', async () => {
    process.env.LLM_API_KEY = 'sk-x'
    process.env.LLM_BASE_URL = 'https://api.xiaomimimo.com/v1/chat/completions'
    process.env.LLM_AUTH_HEADER = 'api-key'
    let headers: Record<string, string> = {}
    vi.stubGlobal('fetch', async (_u: unknown, init: { headers: Record<string, string> }) => {
      headers = init.headers
      return anthropicOk({ affectsCapture: false, affectsMcp: false, severity: 'low', reason: 'r' })
    })
    await llmEnhance(med(), agent)
    expect(headers['api-key']).toBe('sk-x')
    expect(headers.Authorization).toBeUndefined()
  })

  it('同时发 max_tokens 与 max_completion_tokens(MiMo 用后者)', async () => {
    process.env.LLM_API_KEY = 'k'
    process.env.LLM_BASE_URL = 'https://api.xiaomimimo.com/v1/chat/completions'
    let body = ''
    vi.stubGlobal('fetch', async (_u: unknown, init: { body: string }) => {
      body = init.body
      return anthropicOk({ affectsCapture: false, affectsMcp: false, severity: 'low', reason: 'r' })
    })
    await llmEnhance(med(), agent)
    const parsed = JSON.parse(body)
    expect(parsed.max_tokens).toBeGreaterThan(0)
    expect(parsed.max_completion_tokens).toBeGreaterThan(0)
  })

  it('401/403 时提示认证头可能不对', async () => {
    process.env.LLM_API_KEY = 'bad'
    process.env.LLM_BASE_URL = 'https://api.xiaomimimo.com/v1/chat/completions'
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 401 }))
    const r = await llmEnhance(med(), agent)
    expect(r.llmError).toContain('LLM_AUTH_HEADER')
  })

  it('prompt 里必须带「我们依赖什么」,否则模型无从判断', async () => {
    process.env.LLM_API_KEY = 'k'
    // 捕获请求体,验证 prompt 里带上了依赖摘要
    let captured = ''
    vi.stubGlobal('fetch', async (_url: unknown, init: { body: string }) => {
      captured = init.body
      return anthropicOk({ affectsCapture: false, affectsMcp: false, severity: 'low', reason: 'r' })
    })
    await llmEnhance(med(), agent)
    const prompt = JSON.parse(captured).messages[0].content as string
    expect(prompt).toContain('memorysql') // mcp 必需键
    expect(prompt).toContain('session') // 依赖的 SQLite 表
  })
})
