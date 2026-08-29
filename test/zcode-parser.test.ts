import { describe, expect, it } from 'vitest'
import { parseZcodeRollout } from '../src/plugins/capture-zcode/zcode-parser'

// Two request rounds; round 2 repeats round-1 history and adds a new user turn.
const SAMPLE = [
  JSON.stringify({
    sessionId: 'sess_abc',
    startedAt: '2026-08-29T11:27:16.205Z',
    completedAt: '2026-08-29T11:27:51.617Z',
    request: {
      messages: [
        { role: 'system', content: 'You are ZCode... Primary working directory: F:\\demo\\app' },
        { role: 'user', content: '列出项目功能' }
      ]
    },
    response: { text: '这个项目有这些功能…', toolCalls: [] }
  }),
  JSON.stringify({
    sessionId: 'sess_abc',
    startedAt: '2026-08-29T11:28:14.089Z',
    completedAt: '2026-08-29T11:28:36.000Z',
    request: {
      messages: [
        { role: 'system', content: 'You are ZCode... Primary working directory: F:\\demo\\app' },
        { role: 'user', content: '列出项目功能' },
        { role: 'assistant', content: '这个项目有这些功能…' },
        { role: 'user', content: [{ type: 'text', text: '继续,补充技术架构' }] }
      ]
    },
    response: {
      text: '技术架构如下…',
      toolCalls: [{ toolName: 'exec_command', input: { cmd: 'ls' } }]
    }
  }),
  JSON.stringify({
    sessionId: 'sess_other',
    startedAt: '2026-08-29T12:00:00.000Z',
    request: { messages: [{ role: 'user', content: '另一个会话' }] },
    response: { text: '好的' }
  })
].join('\n')

describe('parseZcodeRollout', () => {
  it('groups by sessionId and dedupes repeated history', () => {
    const sessions = parseZcodeRollout('C:/fake/model-io-sess_abc.jsonl', SAMPLE)
    expect(sessions).toHaveLength(2)

    const main = sessions.find((s) => s.externalId === 'sess_abc')!
    expect(main.agentType).toBe('zcode')
    expect(main.cwd).toBe('F:\\demo\\app')
    expect(main.startedAt).toBe(Math.floor(Date.parse('2026-08-29T11:27:16.205Z') / 1000))
    expect(main.endedAt).toBe(Math.floor(Date.parse('2026-08-29T11:28:36.000Z') / 1000))

    // user, assistant, user (from array content), assistant, tool — history repeat removed
    expect(main.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'tool'])
    expect(main.messages[0].content).toBe('列出项目功能')
    expect(main.messages[2].content).toBe('继续,补充技术架构')
    expect(main.messages[4].toolName).toBe('exec_command')
  })
})
