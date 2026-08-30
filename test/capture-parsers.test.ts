import { describe, expect, it } from 'vitest'
import { parseClaudeJsonl } from '../src/plugins/capture-claudecode/claude-parser'
import { parseGeminiHistory } from '../src/plugins/capture-gemini/gemini-parser'
import { parseOpencodeStorage } from '../src/plugins/capture-opencode/opencode-parser'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

describe('parseClaudeJsonl', () => {
  const sample = [
    JSON.stringify({
      type: 'user',
      sessionId: 'sess-abc',
      cwd: 'C:\\work\\demo',
      timestamp: '2026-08-30T09:00:00Z',
      message: { role: 'user', content: '修复登录' }
    }),
    JSON.stringify({
      type: 'assistant',
      sessionId: 'sess-abc',
      timestamp: '2026-08-30T09:00:10Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '开始修复' },
          { type: 'tool_use', name: 'edit', input: { file: 'auth.ts' } }
        ]
      }
    }),
    JSON.stringify({
      type: 'user',
      sessionId: 'sess-abc',
      timestamp: '2026-08-30T09:00:20Z',
      isSidechain: true,
      message: { role: 'user', content: '子代理消息应被跳过' }
    })
  ].join('\n')

  it('tracks startedAt from the earliest timestamp and skips sidechains', () => {
    const s = parseClaudeJsonl('x.jsonl', sample)
    expect(s).not.toBeNull()
    expect(s!.externalId).toBe('sess-abc')
    expect(s!.cwd).toBe('C:\\work\\demo')
    expect(s!.startedAt).toBe(Math.floor(Date.parse('2026-08-30T09:00:00Z') / 1000))
    expect(s!.endedAt).toBe(Math.floor(Date.parse('2026-08-30T09:00:10Z') / 1000))
    const roles = s!.messages.map((m) => m.role)
    expect(roles).toEqual(['user', 'assistant', 'tool'])
    expect(s!.messages[1].toolName).toBeUndefined()
    expect(s!.messages[2].toolName).toBe('edit')
  })
})

describe('parseGeminiHistory', () => {
  it('namespaces externalId by relative path to avoid cross-project collisions', () => {
    const parsed = {
      messages: [
        { role: 'user', parts: [{ text: '列出功能' }] },
        { role: 'model', parts: [{ text: '功能如下' }] }
      ]
    }
    const a = parseGeminiHistory('tmp/hashA/checkpoint.json', parsed)
    const b = parseGeminiHistory('tmp/hashB/checkpoint.json', parsed)
    expect(a!.externalId).toBe('tmp/hashA/checkpoint')
    expect(b!.externalId).toBe('tmp/hashB/checkpoint')
    expect(a!.externalId).not.toBe(b!.externalId)
    expect(a!.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
  })
})

describe('parseOpencodeStorage', () => {
  it('assembles sessions from session/message/part json trees', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-test-'))
    const storage = path.join(tmp, 'storage')
    fs.mkdirSync(path.join(storage, 'session', 'proj'), { recursive: true })
    fs.mkdirSync(path.join(storage, 'message', 'ses_1'), { recursive: true })
    fs.mkdirSync(path.join(storage, 'part', 'msg_1'), { recursive: true })
    fs.mkdirSync(path.join(storage, 'part', 'msg_2'), { recursive: true })
    fs.writeFileSync(
      path.join(storage, 'session', 'proj', 'ses_1.json'),
      JSON.stringify({ id: 'ses_1', title: '调试会话', directory: 'F:\\demo', time: { created: 1788000000000, updated: 1788000600000 } })
    )
    fs.writeFileSync(path.join(storage, 'message', 'ses_1', 'msg_0001.json'), JSON.stringify({ id: 'msg_1', role: 'user' }))
    fs.writeFileSync(path.join(storage, 'message', 'ses_1', 'msg_0002.json'), JSON.stringify({ id: 'msg_2', role: 'assistant' }))
    fs.writeFileSync(path.join(storage, 'part', 'msg_1', 'part_1.json'), JSON.stringify({ type: 'text', text: '帮我看看日志' }))
    fs.writeFileSync(path.join(storage, 'part', 'msg_2', 'part_1.json'), JSON.stringify({ type: 'text', text: '日志显示超时' }))
    fs.writeFileSync(path.join(storage, 'part', 'msg_2', 'part_2.json'), JSON.stringify({ type: 'tool', tool: 'grep' }))

    const sessions = parseOpencodeStorage(storage)
    expect(sessions).toHaveLength(1)
    const s = sessions[0]
    expect(s.externalId).toBe('ses_1')
    expect(s.cwd).toBe('F:\\demo')
    expect(s.title).toBe('调试会话')
    expect(s.messages).toHaveLength(2)
    expect(s.messages[1].content).toContain('日志显示超时')
    expect(s.messages[1].content).toContain('tool call')
    fs.rmSync(tmp, { recursive: true, force: true })
  })
})
