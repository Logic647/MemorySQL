import type { RawMessage, RawSession } from '../../shared/types'
import { openForeignDb } from '../../main/core/sqlite-ro'

/**
 * opencode-lineage agents (opencode itself and its forks — ZCode CLI among
 * them) keep sessions in a SQLite store of three tables:
 *   session(id, directory, title, time_created, time_updated)
 *   message(id, session_id, data JSON {role, time:{created}, …})
 *   part(id, message_id, data JSON {type: text|tool|reasoning|step-finish…})
 * `directory` is the session cwd — the only reliable source for project
 * grouping (the model-io rollout logs often carry no cwd at all).
 * The db is normally locked by the running agent — openForeignDb snapshots it.
 */
interface SessionRow {
  id: string
  directory: string | null
  title: string | null
  time_created: number
  time_updated: number
}
interface MessageRow {
  id: string
  session_id: string
  data: string
}
interface PartRow {
  id: string
  message_id: string
  data: string
}

function epoch(ms: unknown): number | undefined {
  return typeof ms === 'number' && Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined
}

/** message data + its parts → 0..n raw messages (text first, then tool calls) */
function messageToRaw(messageData: string, parts: PartRow[]): RawMessage[] {
  let role = ''
  let created: number | undefined
  try {
    const j = JSON.parse(messageData) as { role?: unknown; time?: { created?: unknown } }
    if (typeof j.role === 'string') role = j.role
    created = epoch(j.time?.created)
  } catch {
    return []
  }
  if (role !== 'user' && role !== 'assistant') return []

  const out: RawMessage[] = []
  let text = ''
  for (const p of parts) {
    let pd: { type?: unknown; text?: unknown; tool?: unknown; state?: { input?: unknown } }
    try {
      pd = JSON.parse(p.data) as typeof pd
    } catch {
      continue
    }
    if (pd.type === 'text' && typeof pd.text === 'string' && pd.text.trim()) {
      text += (text ? '\n' : '') + pd.text
    } else if (pd.type === 'tool' && typeof pd.tool === 'string') {
      out.push({
        role: 'tool',
        toolName: pd.tool,
        content: JSON.stringify(pd.state?.input ?? {}),
        ts: created
      })
    }
    // reasoning / step-finish / timeline … carry no displayable turn content
  }
  if (text.trim()) out.unshift({ role, content: text, ts: created })
  return out
}

/**
 * Parse the whole store (or a single session when onlySessionId is given).
 * Sessions without any parseable turns are skipped.
 */
export function parseAgentSqliteSessions(
  dbPath: string,
  agentType: RawSession['agentType'],
  onlySessionId?: string
): RawSession[] {
  let db: ReturnType<typeof openForeignDb>['db']
  let cleanup: () => void
  try {
    ;({ db, cleanup } = openForeignDb(dbPath))
  } catch {
    return [] // missing/unopenable store — nothing to import
  }
  try {
    const sessions = (
      onlySessionId
        ? db.prepare('SELECT id, directory, title, time_created, time_updated FROM session WHERE id = ?').all(onlySessionId)
        : db.prepare('SELECT id, directory, title, time_created, time_updated FROM session ORDER BY time_updated').all()
    ) as SessionRow[]
    const msgStmt = db.prepare('SELECT id, session_id, data FROM message WHERE session_id = ? ORDER BY rowid')
    const partStmt = db.prepare('SELECT id, message_id, data FROM part WHERE message_id = ? ORDER BY rowid')

    const out: RawSession[] = []
    for (const s of sessions) {
      const messages: RawMessage[] = []
      for (const m of msgStmt.all(s.id) as MessageRow[]) {
        const parts = partStmt.all(m.id) as PartRow[]
        messages.push(...messageToRaw(m.data, parts))
      }
      if (messages.length === 0) continue
      out.push({
        externalId: s.id,
        agentType,
        cwd: s.directory ?? undefined,
        startedAt: epoch(s.time_created) ?? epoch(s.time_updated),
        endedAt: epoch(s.time_updated) ?? epoch(s.time_created),
        title: s.title ?? undefined,
        messages,
        rawPath: dbPath
      })
    }
    return out
  } finally {
    cleanup()
  }
}
