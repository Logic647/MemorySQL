import { describe, expect, it } from 'vitest'
import {
  findDesktopMetaFiles,
  parseClaudeJsonl,
  parseDesktopMeta,
  parseHistoryJsonl
} from '../src/plugins/capture-claudecode/claude-parser'
import { resolveHermesHome } from '../src/plugins/capture-hermes/index'
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

describe('parseDesktopMeta', () => {
  const meta = JSON.stringify({
    sessionId: 'local_2577',
    cliSessionId: '13ffe9d1',
    cwd: 'H:\\temp',
    title: '城乡融合论文',
    createdAt: 1781088296262,
    lastActivityAt: 1781088536468
  })

  it('turns a Claude Desktop metadata file into a titled zero-message session', () => {
    const out = parseDesktopMeta('local_2577.json', meta)
    expect(out).not.toBeNull()
    expect(out!.session.externalId).toBe('desktop:local_2577')
    expect(out!.session.agentType).toBe('claudecode')
    expect(out!.session.title).toBe('城乡融合论文')
    expect(out!.session.cwd).toBe('H:\\temp')
    expect(out!.session.messages).toHaveLength(0)
    expect(out!.session.startedAt).toBe(1781088296)
    expect(out!.cliSessionId).toBe('13ffe9d1')
  })

  it('rejects files without a sessionId', () => {
    expect(parseDesktopMeta('x.json', '{"cwd":"C:\\\\w"}')).toBeNull()
    expect(parseDesktopMeta('x.json', 'not json')).toBeNull()
  })
})

describe('findDesktopMetaFiles', () => {
  it('collects only local_*.json files under nested dirs', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccd-meta-'))
    fs.mkdirSync(path.join(tmp, 'acct', 'slot'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'acct', 'slot', 'local_a.json'), '{}')
    fs.writeFileSync(path.join(tmp, 'acct', 'slot', 'other.json'), '{}')
    fs.writeFileSync(path.join(tmp, 'acct', 'slot', 'local_b.jsonl'), '{}')
    const files = findDesktopMetaFiles(tmp)
    expect(files).toHaveLength(1)
    expect(files[0].endsWith('local_a.json')).toBe(true)
    fs.rmSync(tmp, { recursive: true, force: true })
  })
})

describe('parseHistoryJsonl', () => {
  const history = [
    JSON.stringify({ display: 'init', timestamp: 1778155168103, project: 'G:\\', sessionId: 's1' }),
    JSON.stringify({ display: '修复bug', timestamp: 1778155637203, project: 'D:\\a1', sessionId: 's2' }),
    JSON.stringify({ display: '再修一个', timestamp: 1778155640000, project: 'D:\\a1', sessionId: 's2' }),
    JSON.stringify({ display: '已有完整记录', timestamp: 1778155999999, project: 'D:\\a1', sessionId: 's9' })
  ].join('\n')

  it('groups prompts by sessionId with cwd and time range', () => {
    const out = parseHistoryJsonl(history, 'history.jsonl')
    expect(out).toHaveLength(3)
    const s2 = out.find((s) => s.externalId === 'history:s2')!
    expect(s2.messages).toHaveLength(2)
    expect(s2.cwd).toBe('D:\\a1')
    expect(s2.startedAt).toBe(1778155637)
    expect(s2.endedAt).toBe(1778155640)
  })

  it('skips session ids covered by real transcripts', () => {
    const out = parseHistoryJsonl(history, 'history.jsonl', new Set(['s9']))
    expect(out.find((s) => s.externalId === 'history:s9')).toBeUndefined()
    expect(out).toHaveLength(2)
  })
})

describe('resolveHermesHome', () => {
  it('keeps a configured root that still exists', () => {
    expect(resolveHermesHome('D:\\hermes-home', (p) => p === 'D:\\hermes-home', () => null)).toBe(
      'D:\\hermes-home'
    )
  })

  it('probes registry install dir and drive roots when the configured root vanished', () => {
    expect(
      resolveHermesHome('D:\\gone', (p) => p === 'G:\\Hermes Agent CN Desktop\\data\\hermes-home', () => 'G:\\Hermes Agent CN Desktop')
    ).toBe('G:\\Hermes Agent CN Desktop\\data\\hermes-home')
    expect(
      resolveHermesHome('D:\\gone', (p) => p === 'C:\\Hermes Agent CN Desktop\\data\\hermes-home', () => null)
    ).toBe('C:\\Hermes Agent CN Desktop\\data\\hermes-home')
  })

  it('falls back to the configured value when nothing is found', () => {
    expect(resolveHermesHome('D:\\gone', () => false, () => null)).toBe('D:\\gone')
    expect(resolveHermesHome(undefined, () => false, () => null)).toBeUndefined()
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
