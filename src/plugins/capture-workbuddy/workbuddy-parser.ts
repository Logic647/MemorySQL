import fs from 'node:fs'
import path from 'node:path'
import type { RawMessage, RawSession } from '../../shared/types'
import { openForeignDb } from '../../main/core/sqlite-ro'

/**
 * Tencent WorkBuddy desktop stores sessions under ~/.workbuddy/:
 *   workbuddy.db  — SQLite sessions(id, title, cwd, created_at ms, deleted_at, …)
 *                   + workspaces; metadata (title/cwd) lives here.
 *   projects/{slug}/{conversationId}.jsonl  — append-only message log.
 * Each JSONL record is typically:
 *   { id?, type: 'message', role: 'user'|'assistant', content: string|[{text}],
 *     timestamp: epoch ms, cwd? }
 * Tool-ish records may use other type/role values; those without a displayable
 * turn are skipped. Slug = path with `:\`/`/` → `-`, lowercased.
 */
interface WorkbuddyLine {
  id?: unknown
  type?: unknown
  role?: unknown
  content?: unknown
  timestamp?: unknown
  cwd?: unknown
}

export interface WorkbuddyMeta {
  id: string
  title?: string
  cwd?: string
  createdAtMs?: number
}

function epochSecFromMs(ms: unknown): number | undefined {
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0
    ? Math.floor(ms / 1000)
    : undefined
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      if (block && typeof block === 'object') {
        const t = (block as { text?: unknown }).text
        if (typeof t === 'string' && t.trim()) parts.push(t)
      }
    }
    return parts.join('\n')
  }
  return ''
}

/** Strip WorkBuddy-injected system-reminder wrappers down to the user query. */
export function stripSystemReminder(text: string): string {
  if (!text.includes('<system-reminder')) return text
  const m = /<user_query>([\s\S]*?)<\/user_query>/.exec(text)
  return m?.[1]?.trim() || text
}

export function parseWorkbuddyMessages(text: string): RawMessage[] {
  const messages: RawMessage[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let entry: WorkbuddyLine
    try {
      entry = JSON.parse(trimmed) as WorkbuddyLine
    } catch {
      continue
    }
    const type = typeof entry.type === 'string' ? entry.type : ''
    const role = typeof entry.role === 'string' ? entry.role : ''
    // primary shape: type=message with user/assistant turns
    if (type && type !== 'message') continue
    if (role !== 'user' && role !== 'assistant') continue

    let raw = extractText(entry.content)
    if (!raw.trim()) continue
    if (role === 'user') raw = stripSystemReminder(raw)
    if (!raw.trim()) continue
    const ts = epochSecFromMs(entry.timestamp)
    messages.push({ role, content: raw, ts })
  }
  return messages
}

export function parseWorkbuddyJsonl(filePath: string, text: string): RawSession | null {
  const messages = parseWorkbuddyMessages(text)
  if (messages.length === 0) return null

  let cwd: string | undefined
  let startedAt: number | undefined
  let endedAt: number | undefined
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let entry: WorkbuddyLine
    try {
      entry = JSON.parse(trimmed) as WorkbuddyLine
    } catch {
      continue
    }
    if (typeof entry.cwd === 'string' && entry.cwd && !cwd) cwd = entry.cwd
    const ts = epochSecFromMs(entry.timestamp)
    if (ts) {
      if (!startedAt || ts < startedAt) startedAt = ts
      if (!endedAt || ts > endedAt) endedAt = ts
    }
  }

  return {
    externalId: path.basename(filePath, '.jsonl'),
    agentType: 'workbuddy',
    cwd,
    startedAt,
    endedAt,
    messages,
    rawPath: filePath
  }
}

export function findWorkbuddyDb(root: string): string | null {
  const db = path.join(root, 'workbuddy.db')
  return fs.existsSync(db) ? db : null
}

/** All JSONL transcripts under the WorkBuddy root's projects directory. */
export function findWorkbuddyJsonl(root: string): string[] {
  const projectsDir = path.join(root, 'projects')
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('_')) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full)
    }
  }
  walk(projectsDir)
  return out
}

/** Snapshot-read title/cwd/created_at from workbuddy.db (empty if unopenable). */
export function loadWorkbuddyMeta(root: string): Map<string, WorkbuddyMeta> {
  const map = new Map<string, WorkbuddyMeta>()
  const dbPath = findWorkbuddyDb(root)
  if (!dbPath) return map
  let db: ReturnType<typeof openForeignDb>['db']
  let cleanup: () => void
  try {
    ;({ db, cleanup } = openForeignDb(dbPath))
  } catch {
    return map
  }
  try {
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'`)
      .get() as { name?: string } | undefined
    if (!tables) return map
    const rows = db.prepare('SELECT id, title, cwd, created_at FROM sessions').all() as Array<{
      id: string
      title: string | null
      cwd: string | null
      created_at: number | null
    }>
    for (const r of rows) {
      if (!r.id) continue
      map.set(r.id, {
        id: r.id,
        title: r.title ?? undefined,
        cwd: r.cwd ?? undefined,
        createdAtMs: typeof r.created_at === 'number' ? r.created_at : undefined
      })
    }
  } catch {
    /* unexpected schema — metadata enrichment is optional */
  } finally {
    cleanup()
  }
  return map
}

/** Full scan: JSONL transcripts enriched with workbuddy.db metadata when present. */
export function collectWorkbuddy(root: string): RawSession[] {
  const meta = loadWorkbuddyMeta(root)
  const out: RawSession[] = []
  for (const file of findWorkbuddyJsonl(root)) {
    try {
      const s = parseWorkbuddyJsonl(file, fs.readFileSync(file, 'utf-8'))
      if (!s) continue
      const m = meta.get(s.externalId)
      if (m?.title && !s.title) s.title = m.title
      if (m?.cwd) s.cwd = m.cwd
      if (m?.createdAtMs) {
        const created = epochSecFromMs(m.createdAtMs)
        if (created) s.startedAt = created
      }
      out.push(s)
    } catch {
      /* per-file errors are non-fatal */
    }
  }
  return out
}
