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
import { parseQwenJsonl } from '../src/plugins/capture-qwencode/qwencode-parser'
import {
  buildKimiSession,
  findKimiSessions,
  parseKimiContext
} from '../src/plugins/capture-kimicli/kimicli-parser'
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

describe('parseClaudeJsonl (codebuddy reuse)', () => {
  it('emits the requested agentType instead of claudecode', () => {
    const s = parseClaudeJsonl(
      'x.jsonl',
      JSON.stringify({
        type: 'user',
        sessionId: 'cb-1',
        cwd: 'C:\w',
        timestamp: '2026-09-01T09:00:00Z',
        message: { role: 'user', content: 'hi' }
      }),
      'codebuddy'
    )
    expect(s!.agentType).toBe('codebuddy')
    expect(s!.externalId).toBe('cb-1')
  })
})

describe('parseQwenJsonl', () => {
  const sample = [
    JSON.stringify({
      uuid: 'u1',
      parentUuid: null,
      sessionId: 'qs-1',
      timestamp: '2026-09-01T10:00:00Z',
      cwd: 'D:\proj',
      type: 'user',
      message: { role: 'user', parts: [{ text: '帮我写个爬虫' }] }
    }),
    JSON.stringify({
      uuid: 'u2',
      parentUuid: 'u1',
      timestamp: '2026-09-01T10:00:05Z',
      type: 'assistant',
      message: {
        role: 'assistant',
        parts: [{ text: '好的' }, { functionCall: { name: 'write_file', args: { path: 'a.py' } } }]
      }
    }),
    JSON.stringify({
      uuid: 'u3',
      parentUuid: 'u2',
      timestamp: '2026-09-01T10:00:09Z',
      type: 'tool_result',
      message: { role: 'user', parts: [{ functionResponse: { name: 'write_file', response: { output: 'ok' } } }] },
      toolCallResult: { displayName: 'write_file' }
    }),
    JSON.stringify({
      uuid: 'u4',
      timestamp: '2026-09-01T10:00:10Z',
      type: 'user',
      isSidechain: true,
      message: { role: 'user', parts: [{ text: 'sidechain 应跳过' }] }
    }),
    JSON.stringify({ uuid: 'u5', timestamp: '2026-09-01T10:00:11Z', type: 'system', subtype: 'chat_compression' }),
    'not json at all'
  ].join('\n')

  it('maps parts, functionCalls and tool_results, skipping sidechains', () => {
    const s = parseQwenJsonl('chats/qs-1.jsonl', sample)
    expect(s).not.toBeNull()
    expect(s!.externalId).toBe('qs-1')
    expect(s!.agentType).toBe('qwencode')
    expect(s!.cwd).toBe('D:\proj')
    expect(s!.startedAt).toBe(Math.floor(Date.parse('2026-09-01T10:00:00Z') / 1000))
    // system records carry timestamps too — they extend the session window
    expect(s!.endedAt).toBe(Math.floor(Date.parse('2026-09-01T10:00:11Z') / 1000))
    const roles = s!.messages.map((m) => m.role)
    expect(roles).toEqual(['user', 'assistant', 'tool', 'tool'])
    expect(s!.messages[1].content).toBe('好的')
    expect(s!.messages[2].toolName).toBe('write_file')
    expect(s!.messages[2].content).toContain('a.py')
    expect(s!.messages[3].toolName).toBe('write_file')
    expect(s!.messages[3].content).toContain('ok')
  })

  it('returns null for a transcript without parseable turns', () => {
    expect(parseQwenJsonl('x.jsonl', 'garbage\nlines')).toBeNull()
  })
})

describe('parseKimiContext', () => {
  const sample = [
    JSON.stringify({ role: '_system_prompt', content: '系统提示不算对话' }),
    JSON.stringify({ role: 'user', content: '你好' }),
    JSON.stringify({ role: 'assistant', content: [{ text: '你好!' }, { thinking: '内心独白' }] }),
    JSON.stringify({ role: 'assistant', content: [], tool_calls: [{ id: 't1', name: 'run_cmd', arguments: { cmd: 'ls' } }] }),
    'broken line'
  ].join('\n')

  it('extracts user/assistant text and tool calls, skipping metadata roles', () => {
    const messages = parseKimiContext(sample)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
    expect(messages[0].content).toBe('你好')
    expect(messages[1].content).toBe('你好!')
    expect(messages[2].toolName).toBe('run_cmd')
    expect(messages[2].content).toContain('ls')
  })
})

describe('kimi session discovery', () => {
  it('finds current per-dir sessions and legacy flat files', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-test-'))
    const sessions = path.join(tmp, 'sessions', 'hashabc')
    fs.mkdirSync(path.join(sessions, 'uuid-1'), { recursive: true })
    fs.writeFileSync(path.join(sessions, 'uuid-1', 'context.jsonl'), JSON.stringify({ role: 'user', content: 'hi' }))
    fs.writeFileSync(path.join(sessions, 'uuid-1', 'state.json'), JSON.stringify({ custom_title: '调试会话' }))
    fs.writeFileSync(path.join(sessions, 'uuid-2.jsonl'), JSON.stringify({ role: 'user', content: 'legacy' }))
    fs.writeFileSync(path.join(sessions, 'notes.txt'), 'ignore')

    const refs = findKimiSessions(path.join(tmp, 'sessions'))
    expect(refs).toHaveLength(2)
    const current = refs.find((r) => r.id === 'uuid-1')!
    expect(current.legacy).toBe(false)
    expect(current.stateFile).toBeDefined()
    const legacy = refs.find((r) => r.id === 'uuid-2')!
    expect(legacy.legacy).toBe(true)

    const s = buildKimiSession(current, fs.readFileSync(current.contextFile, 'utf-8'), '调试会话')
    expect(s).not.toBeNull()
    expect(s!.agentType).toBe('kimicli')
    expect(s!.title).toBe('调试会话')
    expect(s!.externalId).toBe('uuid-1')
    expect(s!.messages).toHaveLength(1)
    expect(s!.endedAt).toBeDefined()
    fs.rmSync(tmp, { recursive: true, force: true })
  })
})
