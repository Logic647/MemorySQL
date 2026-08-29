import { describe, expect, it } from 'vitest'
import { parseLlmResponse, buildTranscript } from '../src/plugins/summarizer-llm/index'
import type { RawMessage } from '../src/shared/types'

describe('parseLlmResponse', () => {
  it('parses strict JSON', () => {
    const r = parseLlmResponse('{"title":"清理C盘","summary":"目标: 清理\\n结果: 释放2GB"}')
    expect(r?.title).toBe('清理C盘')
    expect(r?.summary).toContain('释放2GB')
  })

  it('parses JSON wrapped in markdown fences', () => {
    const r = parseLlmResponse('```json\n{"title":"修复登录","summary":"ok"}\n```')
    expect(r?.title).toBe('修复登录')
  })

  it('falls back to line heuristics on non-JSON output', () => {
    const r = parseLlmResponse('远程控制方案调研\n目标: 点对点连接\n结果: 可行')
    expect(r?.title).toBe('远程控制方案调研')
    expect(r?.summary).toContain('可行')
  })

  it('returns null when nothing usable', () => {
    expect(parseLlmResponse('{"summary":"no title"}')).toBeNull()
    expect(parseLlmResponse('')).toBeNull()
  })
})

describe('buildTranscript', () => {
  it('keeps prompts small: first user, second user, last assistant, stats', () => {
    const long = 'x'.repeat(5000)
    const messages: RawMessage[] = [
      { role: 'user', content: long },
      { role: 'assistant', content: 'answer1' },
      { role: 'tool', content: 'toolout' },
      { role: 'user', content: 'second question' },
      { role: 'assistant', content: 'final answer' }
    ]
    const t = buildTranscript(messages)
    expect(t).toContain('用户最初请求')
    expect(t).toContain('second question')
    expect(t).toContain('final answer')
    expect(t).toContain('5 条消息, 1 次工具调用')
    expect(t.length).toBeLessThan(2500) // clipped, not the full 5000-char message
  })
})
