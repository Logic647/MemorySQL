import { describe, expect, it } from 'vitest'
import { LLM_PRESETS, presetById } from '../src/shared/llm-presets'
import {
  isOpenaiReady,
  LLM_DEFAULTS,
  openaiCompatRequest
} from '../src/plugins/summarizer-llm/index'

describe('LLM_PRESETS 完整性', () => {
  it('id 唯一且非空', () => {
    const ids = LLM_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id.length).toBeGreaterThan(0)
  })

  it('除 custom/localproxy 外预设都自带 baseUrl 与推荐模型', () => {
    for (const p of LLM_PRESETS) {
      if (p.id === 'custom' || p.id === 'localproxy') continue
      expect(p.baseUrl, `${p.id} 缺 baseUrl`).toMatch(/^https?:\/\//)
      expect(p.model.length, `${p.id} 缺推荐模型`).toBeGreaterThan(0)
    }
  })

  it('presetById 未知 id 返回 undefined', () => {
    expect(presetById('nope')).toBeUndefined()
    expect(presetById('')).toBeUndefined()
  })

  it('MiMo 预设声明双 token 字段策略', () => {
    expect(presetById('mimo')?.tokens).toBe('both')
  })

  it('本地反代/自定义为免 Key 预设', () => {
    expect(presetById('localproxy')?.keyless).toBe(true)
    expect(presetById('custom')?.keyless).toBe(true)
  })
})

describe('openaiCompatRequest 兼容策略', () => {
  const base = { preset: 'zhipu', openaiBaseUrl: 'https://open.bigmodel.cn/api/paas/v4/', openaiKey: 'sk-test', openaiModel: 'glm-4.7-flash' }

  it('有 key 时双认证头(Bearer + api-key)', () => {
    const r = openaiCompatRequest(base, 'hi', 300)
    expect(r.headers.Authorization).toBe('Bearer sk-test')
    expect(r.headers['api-key']).toBe('sk-test')
  })

  it('免 Key 端点一个认证头都不发', () => {
    const r = openaiCompatRequest({ ...base, preset: 'localproxy', openaiKey: '' }, 'hi', 300)
    expect(r.headers.Authorization).toBeUndefined()
    expect(r.headers['api-key']).toBeUndefined()
  })

  it('URL 去尾斜杠后拼 /chat/completions', () => {
    const r = openaiCompatRequest(base, 'hi', 300)
    expect(r.url).toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions')
  })

  it('默认只发 max_tokens(OpenAI 严格模式对双字段会 400)', () => {
    const r = openaiCompatRequest(base, 'hi', 300)
    expect(r.body.max_tokens).toBe(300)
    expect(r.body).not.toHaveProperty('max_completion_tokens')
  })

  it("MiMo 预设双发 max_tokens + max_completion_tokens", () => {
    const r = openaiCompatRequest({ ...base, preset: 'mimo' }, 'hi', 300)
    expect(r.body.max_tokens).toBe(300)
    expect(r.body.max_completion_tokens).toBe(300)
  })

  it('body 携带模型与 system/user 消息', () => {
    const r = openaiCompatRequest(base, '转写内容', 300)
    expect(r.body.model).toBe('glm-4.7-flash')
    const msgs = r.body.messages as Array<{ role: string; content: string }>
    expect(msgs).toHaveLength(2)
    expect(msgs[1].content).toBe('转写内容')
  })
})

describe('isOpenaiReady', () => {
  it('Base URL 为空一律不就绪', () => {
    expect(isOpenaiReady({ preset: 'zhipu', openaiBaseUrl: '  ', openaiKey: 'sk' })).toBe(false)
  })

  it('常规预设缺 Key 不就绪', () => {
    expect(isOpenaiReady({ preset: 'zhipu', openaiBaseUrl: 'https://x', openaiKey: '' })).toBe(false)
    // 未选预设(老配置/手填)同样要求 Key
    expect(isOpenaiReady({ preset: '', openaiBaseUrl: 'https://x', openaiKey: '' })).toBe(false)
  })

  it('免 Key 预设只需 Base URL', () => {
    expect(isOpenaiReady({ preset: 'localproxy', openaiBaseUrl: 'http://127.0.0.1:8787/v1', openaiKey: '' })).toBe(true)
    expect(isOpenaiReady({ preset: 'custom', openaiBaseUrl: 'http://192.168.1.5:9000/v1', openaiKey: '' })).toBe(true)
  })

  it('有 Key 的任何预设都就绪', () => {
    expect(isOpenaiReady({ preset: 'zhipu', openaiBaseUrl: 'https://x', openaiKey: 'sk-1' })).toBe(true)
  })
})

describe('LLM_DEFAULTS 向后兼容', () => {
  it('默认无 LLM、无预设 —— 升级用户的现有行为不变', () => {
    expect(LLM_DEFAULTS.provider).toBe('none')
    expect(LLM_DEFAULTS.preset).toBe('')
    expect(LLM_DEFAULTS.openaiBaseUrl).toBe('https://api.openai.com/v1')
  })
})
