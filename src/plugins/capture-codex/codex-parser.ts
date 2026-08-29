import fs from 'node:fs'
import path from 'node:path'
import type { RawMessage, RawSession } from '../../shared/types'

/**
 * Codex CLI rollout format (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl):
 * each line is JSON with { timestamp, ordinal, type, payload }.
 *   session_meta  → payload.session_id / payload.cwd / payload.timestamp
 *   response_item → payload.type === 'message'   (roles: user/assistant/developer)
 *                   payload.type === 'function_call' (name + arguments JSON)
 *   event_msg / world_state / turn_context → ignored for MVP
 */
interface RolloutLine {
  timestamp?: string
  type?: string
  payload?: {
    type?: string
    role?: string
    content?: Array<{ type?: string; text?: string }>
    session_id?: string
    id?: string
    cwd?: string
    name?: string
    arguments?: string
    [k: string]: unknown
  }
}

function contentText(content: RolloutLine['payload'] extends undefined ? never : NonNullable<RolloutLine['payload']>['content']): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .filter((t) => t.length > 0)
    .join('\n')
}

function isoToEpoch(iso?: string): number | undefined {
  if (!iso) return undefined
  const t = Date.parse(iso)
  return Number.isNaN(t) ? undefined : Math.floor(t / 1000)
}

/** Parse one rollout file into a normalized session; null if not usable. */
export function parseCodexRollout(filePath: string, text: string): RawSession | null {
  let externalId: string | undefined
  let cwd: string | undefined
  let startedAt: number | undefined
  let endedAt: number | undefined
  const messages: RawMessage[] = []

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let entry: RolloutLine
    try {
      entry = JSON.parse(trimmed) as RolloutLine
    } catch {
      continue // tolerate corrupted lines
    }
    const ts = isoToEpoch(entry.timestamp)
    if (ts && (!endedAt || ts > endedAt)) endedAt = ts

    switch (entry.type) {
      case 'session_meta': {
        const p = entry.payload ?? {}
        externalId = p.session_id ?? p.id
        cwd = typeof p.cwd === 'string' ? p.cwd : undefined
        startedAt = isoToEpoch(p.timestamp as string | undefined) ?? ts
        break
      }
      case 'response_item': {
        const p = entry.payload ?? {}
        if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
          const text2 = contentText(p.content)
          if (text2.trim()) {
            messages.push({ role: p.role === 'user' ? 'user' : 'assistant', content: text2, ts })
          }
        } else if (p.type === 'function_call' && typeof p.name === 'string') {
          messages.push({
            role: 'tool',
            toolName: p.name,
            content: typeof p.arguments === 'string' ? p.arguments : JSON.stringify(p.arguments ?? {}),
            ts
          })
        }
        break
      }
      default:
        break
    }
  }

  if (!externalId) {
    externalId = path.basename(filePath, '.jsonl')
  }
  if (messages.length === 0) return null

  return {
    externalId,
    agentType: 'codex',
    cwd,
    startedAt: startedAt ?? endedAt,
    endedAt,
    messages,
    rawPath: filePath
  }
}

/** Recursively find rollout-*.jsonl files under the sessions root. */
export function findCodexRollouts(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile() && /^rollout-.*\.jsonl$/i.test(e.name)) out.push(full)
    }
  }
  walk(root)
  return out
}
