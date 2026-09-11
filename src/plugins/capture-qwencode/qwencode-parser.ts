import path from 'node:path'
import type { RawMessage, RawSession } from '../../shared/types'

/**
 * Qwen Code (Apache QwenLM/qwen-code, Gemini CLI fork) session transcript:
 *   ~/.qwen/projects/<proj>/chats/<sessionId>.jsonl   (current)
 *   ~/.qwen/tmp/<project_id>/chats/<sessionId>.jsonl  (older builds)
 * Append-only JSONL tree (uuid/parentUuid). Each record:
 *   { uuid, parentUuid, sessionId, timestamp: ISO 8601, cwd, version,
 *     type: 'user'|'assistant'|'tool_result'|'system', subtype?,
 *     message?: { role, parts }, toolCallResult?, isSidechain? }
 * message.parts is the GenAI wire format: {text} | {functionCall:{name,args}} |
 * {functionResponse:{name,response}} | thought parts.
 */
interface QwenPart {
  text?: unknown
  thought?: unknown
  thinking?: unknown
  functionCall?: { name?: unknown; args?: unknown }
  functionResponse?: { name?: unknown; response?: unknown }
}

interface QwenLine {
  type?: string
  timestamp?: string
  sessionId?: string
  cwd?: string
  isSidechain?: boolean
  message?: { parts?: unknown }
  toolCallResult?: { displayName?: unknown; result?: unknown }
}

function isoToEpoch(iso?: string): number | undefined {
  if (!iso) return undefined
  const t = Date.parse(iso)
  return Number.isNaN(t) ? undefined : Math.floor(t / 1000)
}

function partToMessages(
  role: 'user' | 'assistant',
  parts: unknown,
  ts?: number
): RawMessage[] {
  const out: RawMessage[] = []
  if (!Array.isArray(parts)) return out
  const texts: string[] = []
  for (const part of parts as QwenPart[]) {
    if (!part || typeof part !== 'object') continue
    if (typeof part.text === 'string' && part.text.trim()) {
      texts.push(part.text)
    } else if (part.functionCall && typeof part.functionCall === 'object') {
      const name = typeof part.functionCall.name === 'string' ? part.functionCall.name : 'tool'
      out.push({
        role: 'tool',
        toolName: name,
        content: JSON.stringify(part.functionCall.args ?? {}),
        ts
      })
    }
    // thought/thinking and functionResponse parts carry no displayable turn text
  }
  if (texts.length > 0) out.unshift({ role, content: texts.join(''), ts })
  return out
}

export function parseQwenJsonl(filePath: string, text: string): RawSession | null {
  let externalId: string | undefined
  let cwd: string | undefined
  let startedAt: number | undefined
  let endedAt: number | undefined
  const messages: RawMessage[] = []

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let entry: QwenLine
    try {
      entry = JSON.parse(trimmed) as QwenLine
    } catch {
      continue
    }
    // sidechain (subagent) records belong to the subagent's own transcript
    if (entry.isSidechain) continue

    const ts = isoToEpoch(entry.timestamp)
    if (ts && (!endedAt || ts > endedAt)) endedAt = ts
    if (ts && (!startedAt || ts < startedAt)) startedAt = ts
    if (entry.sessionId && !externalId) externalId = entry.sessionId
    if (entry.cwd && !cwd) cwd = entry.cwd

    if (entry.type === 'user' || entry.type === 'assistant') {
      messages.push(...partToMessages(entry.type, entry.message?.parts, ts))
    } else if (entry.type === 'tool_result') {
      const parts = Array.isArray(entry.message?.parts)
        ? (entry.message.parts as QwenPart[])
        : []
      const fnResp = parts.find((p) => p && typeof p === 'object' && p.functionResponse)
        ?.functionResponse
      const displayName =
        fnResp && typeof fnResp.name === 'string'
          ? fnResp.name
          : typeof entry.toolCallResult?.displayName === 'string'
            ? entry.toolCallResult.displayName
            : 'tool'
      const result = fnResp && fnResp.response !== undefined ? fnResp.response : entry.toolCallResult?.result
      messages.push({
        role: 'tool',
        toolName: displayName,
        content: result === undefined ? '' : JSON.stringify(result),
        ts
      })
    }
    // 'system' records are CLI bookkeeping (compression, rewind, …) — skipped
  }

  if (messages.length === 0) return null
  return {
    externalId: externalId ?? path.basename(filePath, '.jsonl'),
    agentType: 'qwencode',
    cwd,
    startedAt: startedAt ?? endedAt,
    endedAt,
    messages,
    rawPath: filePath
  }
}
