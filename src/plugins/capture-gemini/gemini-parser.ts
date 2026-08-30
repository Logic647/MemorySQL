import fs from 'node:fs'
import path from 'node:path'
import type { RawMessage, RawSession } from '../../shared/types'

/**
 * Gemini CLI (~/.gemini/). History files are JSON in a few observed shapes:
 *   { messages: [{role: 'user'|'model'|'assistant', parts: [{text}] | text}] }
 *   { history: [...] }                — same entry shape
 *   { sessionId?, messages/history }  — optional session id
 * Parsed defensively; unknown shapes are skipped.
 */
interface GeminiEntry {
  role?: string
  parts?: Array<{ text?: string }>
  text?: string
  content?: string
}

function entryToMessage(e: GeminiEntry): RawMessage | null {
  const roleRaw = (e.role ?? '').toLowerCase()
  const role = roleRaw === 'model' || roleRaw === 'assistant' ? 'assistant' : roleRaw === 'user' ? 'user' : null
  if (!role) return null
  let text = ''
  if (typeof e.text === 'string') text = e.text
  else if (typeof e.content === 'string') text = e.content
  else if (Array.isArray(e.parts)) {
    text = e.parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).filter(Boolean).join('\n')
  }
  if (!text.trim()) return null
  return { role, content: text }
}

export function parseGeminiHistory(relPath: string, parsed: unknown): RawSession | null {
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  const rawList = (obj.messages ?? obj.history) as GeminiEntry[] | undefined
  if (!Array.isArray(rawList)) return null
  const messages = rawList
    .map((e) => entryToMessage(e))
    .filter((m): m is RawMessage => m !== null)
  if (messages.length === 0) return null
  // namespace by relative path: different project dirs can hold same-named
  // files, and (agent_type, external_id) is the unique/dedup key
  const sessionId = typeof obj.sessionId === 'string' && obj.sessionId ? obj.sessionId : null
  const normalized = relPath.split(path.sep).join('/').replace(/\.[^.]+$/, '')
  const externalId = sessionId ? `${normalized}:${sessionId}` : normalized
  return {
    externalId,
    agentType: 'gemini',
    messages,
    rawPath: relPath
  }
}

/** recursively collect candidate history files under ~/.gemini */
export function findGeminiFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === '.lock' || e.name === 'tmp_install') continue
        walk(full, depth + 1)
      } else if (e.isFile() && /\.json$/i.test(e.name)) {
        out.push(full)
      }
    }
  }
  walk(root, 0)
  return out
}
