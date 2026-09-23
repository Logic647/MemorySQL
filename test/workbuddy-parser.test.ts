import { describe, expect, it } from 'vitest'
import {
  collectWorkbuddy,
  parseWorkbuddyJsonl,
  stripSystemReminder
} from '../src/plugins/capture-workbuddy/workbuddy-parser'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

describe('parseWorkbuddyJsonl', () => {
  const sample = [
    JSON.stringify({
      id: 'm1',
      type: 'message',
      role: 'user',
      content: '帮我写周报',
      timestamp: 1781088000000,
      cwd: 'D:\\work\\临时'
    }),
    JSON.stringify({
      id: 'm2',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text', text: '好的,先看本周任务' }
      ],
      timestamp: 1781088001000,
      cwd: 'D:\\work\\临时'
    }),
    JSON.stringify({
      id: 'm3',
      type: 'tool',
      role: 'tool',
      content: 'skip me',
      timestamp: 1781088002000
    }),
    JSON.stringify({
      id: 'm4',
      type: 'message',
      role: 'user',
      content: '<system-reminder>noise</system-reminder><user_query>查一下合同</user_query>',
      timestamp: 1781088003000
    })
  ].join('\n')

  it('parses user/assistant turns, skips non-message records, strips system-reminder', () => {
    const s = parseWorkbuddyJsonl('abc123.jsonl', sample)
    expect(s).not.toBeNull()
    expect(s!.externalId).toBe('abc123')
    expect(s!.agentType).toBe('workbuddy')
    expect(s!.cwd).toBe('D:\\work\\临时')
    expect(s!.startedAt).toBe(Math.floor(1781088000000 / 1000))
    expect(s!.endedAt).toBe(Math.floor(1781088003000 / 1000))
    expect(s!.messages).toHaveLength(3)
    expect(s!.messages[0]).toMatchObject({ role: 'user', content: '帮我写周报' })
    expect(s!.messages[1]).toMatchObject({
      role: 'assistant',
      content: '好的,先看本周任务'
    })
    expect(s!.messages[2]).toMatchObject({ role: 'user', content: '查一下合同' })
  })

  it('returns null when no parseable turns', () => {
    expect(parseWorkbuddyJsonl('x.jsonl', 'not-json\n{"type":"meta"}')).toBeNull()
  })
})

describe('stripSystemReminder', () => {
  it('returns plain text unchanged', () => {
    expect(stripSystemReminder('hello')).toBe('hello')
  })
  it('extracts user_query when present', () => {
    expect(
      stripSystemReminder('<system-reminder>x</system-reminder><user_query>Q</user_query>')
    ).toBe('Q')
  })
})

describe('collectWorkbuddy', () => {
  it('reads projects/*.jsonl under a synthetic root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbuddy-test-'))
    try {
      const slugDir = path.join(root, 'projects', 'd-work-demo')
      fs.mkdirSync(slugDir, { recursive: true })
      fs.writeFileSync(
        path.join(slugDir, 'sess-1.jsonl'),
        [
          JSON.stringify({
            type: 'message',
            role: 'user',
            content: 'hi',
            timestamp: 1700000000000,
            cwd: 'D:\\work\\demo'
          }),
          JSON.stringify({
            type: 'message',
            role: 'assistant',
            content: 'yo',
            timestamp: 1700000001000
          })
        ].join('\n'),
        'utf-8'
      )
      const sessions = collectWorkbuddy(root)
      expect(sessions).toHaveLength(1)
      expect(sessions[0].externalId).toBe('sess-1')
      expect(sessions[0].messages).toHaveLength(2)
      expect(sessions[0].cwd).toBe('D:\\work\\demo')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
