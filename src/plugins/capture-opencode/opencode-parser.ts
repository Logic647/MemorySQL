import fs from 'node:fs'
import path from 'node:path'
import type { RawMessage, RawSession } from '../../shared/types'

/**
 * OpenCode (~/.local/share/opencode/storage/ or %LOCALAPPDATA%/opencode/storage):
 *   session/<scope>/ses_*.json  → {id, title?, directory?, time?: {created?, updated?}}
 *   message/<sessionId>/msg_*.json → {id, role: 'user'|'assistant', …}
 *   part/<messageId>/part_*.json   → {type:'text', text} | {type:'tool', …}
 * File names carry ordering (msg_0001…). Parsed defensively.
 */
function readJsonFiles(dir: string): Array<{ file: string; data: Record<string, unknown> }> {
  const out: Array<{ file: string; data: Record<string, unknown> }> = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, e.name), 'utf-8')) as Record<string, unknown>
      if (data && typeof data === 'object') out.push({ file: e.name, data })
    } catch {
      /* skip malformed */
    }
  }
  return out
}

function collectTexts(partDir: string, messageRef: string): string | null {
  const parts = readJsonFiles(partDir)
  if (parts.length === 0) return null
  const texts: string[] = []
  let toolCalls = 0
  for (const { data } of parts) {
    const type = String(data.type ?? '')
    if (type === 'text' && typeof data.text === 'string' && data.text.trim()) {
      texts.push(data.text)
    } else if (type === 'tool') {
      toolCalls++
    }
  }
  if (toolCalls > 0) {
    texts.push(`[${toolCalls} tool call${toolCalls > 1 ? 's' : ''}]`)
  }
  const joined = texts.join('\n\n').trim()
  return joined || (messageRef ? null : null)
}

export function parseOpencodeStorage(storageDir: string): RawSession[] {
  const sessionDir = path.join(storageDir, 'session')
  if (!fs.existsSync(sessionDir)) return []
  const out: RawSession[] = []

  const scopeDirs: fs.Dirent[] = (() => {
    try {
      return fs.readdirSync(sessionDir, { withFileTypes: true }).filter((d) => d.isDirectory())
    } catch {
      return []
    }
  })()

  for (const scope of scopeDirs) {
    const scopePath = path.join(sessionDir, scope.name)
    for (const { file, data } of readJsonFiles(scopePath)) {
      const sessionId = String(data.id ?? file.replace(/\.json$/, ''))
      if (!sessionId) continue
      const msgDir = path.join(storageDir, 'message', sessionId)
      if (!fs.existsSync(msgDir)) continue

      const messages: RawMessage[] = []
      let startedAt: number | undefined
      let endedAt: number | undefined
      for (const { data: msg } of readJsonFiles(msgDir)) {
        const role = String(msg.role ?? '') === 'user' ? 'user' : String(msg.role ?? '') === 'assistant' ? 'assistant' : null
        if (!role) continue
        const messageId = String(msg.id ?? '')
        const text = collectTexts(path.join(storageDir, 'part', messageId), messageId)
        if (!text) continue
        const time = msg.time as { created?: number } | undefined
        const ts = time?.created ? Math.floor(time.created / 1000) : undefined
        if (ts) {
          if (!startedAt || ts < startedAt) startedAt = ts
          if (!endedAt || ts > endedAt) endedAt = ts
        }
        messages.push({ role, content: text, ts })
      }
      if (messages.length === 0) continue

      const time = data.time as { created?: number; updated?: number } | undefined
      out.push({
        externalId: sessionId,
        agentType: 'opencode',
        cwd: typeof data.directory === 'string' ? data.directory : undefined,
        startedAt: startedAt ?? (time?.created ? Math.floor(time.created / 1000) : undefined),
        endedAt: endedAt ?? (time?.updated ? Math.floor(time.updated / 1000) : undefined),
        title: typeof data.title === 'string' && data.title ? data.title : undefined,
        messages,
        rawPath: scopePath
      })
    }
  }
  return out
}

export function findOpencodeStorage(home: string, localAppData?: string): string | null {
  const candidates = [
    localAppData ? path.join(localAppData, 'opencode', 'storage') : null,
    path.join(home, '.local', 'share', 'opencode', 'storage')
  ].filter((p): p is string => p !== null)
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return null
}
