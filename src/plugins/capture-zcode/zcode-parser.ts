import fs from 'node:fs'
import path from 'node:path'
import type { RawMessage, RawSession } from '../../shared/types'

/**
 * ZCode model-io rollout format (~/.zcode/cli/rollout/model-io-sess_*.jsonl):
 * each line = one LLM round-trip:
 *   { sessionId, startedAt, request: { messages: [{role, content}] },
 *     response: { text, toolCalls, ... } }
 * `request.messages` contains the FULL history each time, so we take the
 * newest user message per line and dedupe repeats across lines.
 */
interface ZcLine {
  sessionId?: string
  startedAt?: string
  completedAt?: string
  request?: { messages?: Array<{ role?: string; content?: unknown }> }
  response?: {
    text?: string
    toolCalls?: Array<{ toolName?: string; name?: string; input?: unknown; args?: unknown }>
  }
}

type MsgContent = string | Array<{ type?: string; text?: string }> | undefined

function flattenContent(content: MsgContent): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p?.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function isoToEpoch(iso?: string): number | undefined {
  if (!iso) return undefined
  const t = Date.parse(iso)
  return Number.isNaN(t) ? undefined : Math.floor(t / 1000)
}

/** Best-effort cwd extraction from the system prompt embedded in history. */
function extractCwd(messages: Array<{ role?: string; content?: unknown }>): string | undefined {
  for (const m of messages) {
    if (m.role !== 'system') continue
    const text = flattenContent(m.content as MsgContent)
    const match = text.match(/(?:Primary working directory|工作目录|working directory)[:：]\s*(.+?)\s*(?:\n|$)/i)
    if (match?.[1]) return match[1].trim()
  }
  return undefined
}

/** Parse one model-io dump into sessions grouped by sessionId. */
export function parseZcodeRollout(filePath: string, text: string): RawSession[] {
  const bySession = new Map<string, { lines: ZcLine[]; startedAt?: number; endedAt?: number }>()

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let entry: ZcLine
    try {
      entry = JSON.parse(trimmed) as ZcLine
    } catch {
      continue
    }
    if (!entry.sessionId) continue
    const bucket = bySession.get(entry.sessionId) ?? { lines: [] }
    bucket.lines.push(entry)
    const st = isoToEpoch(entry.startedAt)
    const ct = isoToEpoch(entry.completedAt)
    if (st && (!bucket.startedAt || st < bucket.startedAt)) bucket.startedAt = st
    if (ct && (!bucket.endedAt || ct > bucket.endedAt)) bucket.endedAt = ct
    bySession.set(entry.sessionId, bucket)
  }

  const sessions: RawSession[] = []
  for (const [externalId, bucket] of bySession) {
    const messages: RawMessage[] = []
    let lastUser = ''
    let lastAssistant = ''
    let lastUserLine = -1
    let lastAssistantLine = -1
    let cwd: string | undefined

    // lines are chronological within a session dump
    for (let lineIdx = 0; lineIdx < bucket.lines.length; lineIdx++) {
      const line = bucket.lines[lineIdx]
      const history = line.request?.messages ?? []
      if (!cwd) cwd = extractCwd(history)

      // newest user message in this request = the incremental user turn;
      // dedup key includes the line index so an identical text in a NEW
      // request (user deliberately repeating) is kept
      for (let i = history.length - 1; i >= 0; i--) {
        const m = history[i]
        if (m.role !== 'user') continue
        const text2 = flattenContent(m.content as MsgContent)
        if (text2.trim() && !(text2 === lastUser && lineIdx === lastUserLine)) {
          messages.push({ role: 'user', content: text2 })
          lastUser = text2
          lastUserLine = lineIdx
        }
        break
      }

      const resp = line.response
      if (resp?.text && resp.text.trim() && !(resp.text === lastAssistant && lineIdx === lastAssistantLine)) {
        messages.push({ role: 'assistant', content: resp.text })
        lastAssistant = resp.text
        lastAssistantLine = lineIdx
      }
      for (const tc of resp?.toolCalls ?? []) {
        const name = tc.toolName ?? tc.name ?? 'tool'
        const args = tc.input ?? tc.args
        messages.push({
          role: 'tool',
          toolName: name,
          content: typeof args === 'string' ? args : JSON.stringify(args ?? {})
        })
      }
    }

    if (messages.length === 0) continue
    sessions.push({
      externalId,
      agentType: 'zcode',
      cwd,
      startedAt: bucket.startedAt,
      endedAt: bucket.endedAt,
      messages,
      rawPath: filePath
    })
  }
  return sessions
}

export function findZcodeRollouts(root: string): string[] {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isFile() && /^model-io-sess_.*\.jsonl$/i.test(e.name))
      .map((e) => path.join(root, e.name))
  } catch {
    return []
  }
}
