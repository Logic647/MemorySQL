import { describe, expect, it } from 'vitest'
import { parseCodexRollout } from '../src/plugins/capture-codex/codex-parser'

const SAMPLE = [
  JSON.stringify({
    timestamp: '2026-08-22T10:37:42.547Z',
    ordinal: 0,
    type: 'session_meta',
    payload: {
      session_id: '01a0290c-3844-7433-a8f4-f348ea1c770c',
      id: '01a0290c-3844-7433-a8f4-f348ea1c770c',
      timestamp: '2026-08-22T10:37:41.909Z',
      cwd: 'C:\\Users\\dev\\demo-project'
    }
  }),
  JSON.stringify({
    timestamp: '2026-08-22T10:37:42.599Z',
    ordinal: 2,
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: '<app-context>boilerplate</app-context>' }]
    }
  }),
  JSON.stringify({
    timestamp: '2026-08-22T10:38:00.000Z',
    ordinal: 3,
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '帮我修复登录 bug' }]
    }
  }),
  JSON.stringify({
    timestamp: '2026-08-22T10:38:10.000Z',
    ordinal: 4,
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'exec_command',
      arguments: '{"cmd":"npm test"}'
    }
  }),
  JSON.stringify({
    timestamp: '2026-08-22T10:38:20.000Z',
    ordinal: 5,
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: '已修复 auth.ts 并通过测试' }]
    }
  }),
  'this line is corrupted {{{',
  JSON.stringify({ timestamp: '2026-08-22T10:39:00.000Z', ordinal: 6, type: 'event_msg', payload: { type: 'task_started' } })
].join('\n')

describe('parseCodexRollout', () => {
  it('extracts session meta, user/assistant messages and tool calls', () => {
    const s = parseCodexRollout('C:/fake/rollout-x.jsonl', SAMPLE)
    expect(s).not.toBeNull()
    expect(s!.externalId).toBe('01a0290c-3844-7433-a8f4-f348ea1c770c')
    expect(s!.agentType).toBe('codex')
    expect(s!.cwd).toBe('C:\\Users\\dev\\demo-project')
    expect(s!.startedAt).toBe(Math.floor(Date.parse('2026-08-22T10:37:41.909Z') / 1000))
    expect(s!.endedAt).toBe(Math.floor(Date.parse('2026-08-22T10:39:00.000Z') / 1000))

    const roles = s!.messages.map((m) => m.role)
    expect(roles).toEqual(['user', 'tool', 'assistant'])
    expect(s!.messages[0].content).toBe('帮我修复登录 bug')
    expect(s!.messages[1].toolName).toBe('exec_command')
    expect(s!.messages[2].content).toContain('auth.ts')
  })

  it('returns null when there are no usable messages', () => {
    const empty = [
      JSON.stringify({ type: 'session_meta', payload: { session_id: 'x', cwd: 'C:\\w' } })
    ].join('\n')
    expect(parseCodexRollout('C:/fake/rollout-empty.jsonl', empty)).toBeNull()
  })

  it('falls back to filename as externalId when session_meta is missing', () => {
    const s = parseCodexRollout('C:/fake/rollout-fallback.jsonl', SAMPLE)
    // SAMPLE contains a session_meta, so id comes from it; test the no-meta path:
    const noMeta = SAMPLE.replace(/^.*session_meta.*\n/m, '')
    const s2 = parseCodexRollout('C:/fake/rollout-fallback.jsonl', noMeta)
    expect(s2!.externalId).toBe('rollout-fallback')
    expect(s).not.toBeNull()
  })
})
