import { describe, expect, it } from 'vitest'
import { parseConversation } from '../src/plugins/import-chat/index'

describe('parseConversation', () => {
  it('splits on plain, bold, header and bracket role markers (中英文)', () => {
    const text = [
      '用户:帮我看看这个报错',
      '**Assistant:** 这是配置问题,',
      '看下面的修改。',
      '### user',
      '改好了还是不行',
      '[assistant]',
      '需要重启服务'
    ].join('\n')
    const messages = parseConversation(text)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(messages[0].content).toBe('帮我看看这个报错')
    expect(messages[1].content).toBe('这是配置问题,\n看下面的修改。')
    expect(messages[2].content).toBe('改好了还是不行')
    expect(messages[3].content).toBe('需要重启服务')
  })

  it('maps english tokens and treats pre-marker content as user side', () => {
    const messages = parseConversation('why is it slow?\nUser: check the logs\nAI: here you go')
    expect(messages.map((m) => m.role)).toEqual(['user', 'user', 'assistant'])
    expect(messages[0].content).toBe('why is it slow?')
  })

  it('does not misread colons inside ordinary content', () => {
    const messages = parseConversation('用户:注意:这里有个坑\n助手:好的')
    expect(messages).toHaveLength(2)
    expect(messages[0].content).toBe('注意:这里有个坑')
  })

  it('accepts a flat [{role, content}] JSON array', () => {
    const text = JSON.stringify([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好!' },
      { role: 'system', content: '应被跳过' }
    ])
    const messages = parseConversation(text)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('falls back to a single user message when no markers exist', () => {
    const messages = parseConversation('一段没有任何角色标记的文字\n第二行')
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('user')
    expect(messages[0].content).toContain('第二行')
  })

  it('returns empty for blank input', () => {
    expect(parseConversation('   \n  ')).toEqual([])
  })
})
