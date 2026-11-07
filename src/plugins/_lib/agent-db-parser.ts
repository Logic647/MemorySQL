import type { RawMessage, RawSession } from '../../shared/types'
import { openForeignDb } from '../../main/core/sqlite-ro.ts'

/**
 * opencode-lineage agents (opencode itself and its forks — ZCode CLI among
 * them) keep sessions in a SQLite store. Two layouts exist:
 *
 * legacy (zcode, opencode ≤1.x):
 *   session(id, directory, title, time_created, time_updated)
 *   message(id, session_id, data JSON {role, time:{created}, …})
 *   part(id, message_id, data JSON {type: text|tool|reasoning|step-finish…})
 *
 * v2 (opencode ≥2.0, 2026-09): `session` is gone — replaced by
 *   session_v2(id, directory, title, time_created, time_updated, project_id…)
 *   session_message(id, session_id, type 'user'|'assistant'|…, seq, data JSON)
 * where the parts moved INSIDE the message data: assistant rows carry a
 * `content` array ({type: text|tool|reasoning}, tool parts as {name, state}),
 * user rows carry a plain `text`.
 *
 * `directory` is the session cwd — the only reliable source for project
 * grouping. The db is normally locked by the running agent — openForeignDb
 * snapshots it. Layout is detected per open: legacy first, then v2; a store
 * with neither yields [] instead of throwing.
 */
interface SessionRow {
  id: string
  directory: string | null
  title: string | null
  time_created: number
  time_updated: number
  /** 子会话线索(列是否存在按 store 探测,见 sessionColumns) */
  parent_id?: string | null
  task_type?: string | null
  agent?: string | null
  /** 归档标记(opencode 系表里有;不存在时不导入归档语义) */
  time_archived?: number | null
}
interface MessageRow {
  id: string
  session_id: string
  data: string
}
interface V2MessageRow extends MessageRow {
  type: string
}
interface PartRow {
  id: string
  message_id: string
  data: string
}

function epoch(ms: unknown): number | undefined {
  return typeof ms === 'number' && Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined
}

/** content part shape — union of legacy part rows and v2 in-data content */
interface ContentPart {
  type?: unknown
  text?: unknown
  tool?: unknown
  name?: unknown
  state?: { input?: unknown }
}

/** role + message data (+ parts when the layout keeps them separate) → 0..n raw messages */
function messageToRaw(messageData: string, parts: PartRow[], forcedRole?: string): RawMessage[] {
  let role = ''
  let created: number | undefined
  let j: { time?: { created?: unknown }; text?: unknown; content?: unknown }
  try {
    j = JSON.parse(messageData) as typeof j
    if (forcedRole != null) role = forcedRole
    else if (typeof (j as { role?: unknown }).role === 'string') role = (j as { role: string }).role
    created = epoch(j.time?.created)
  } catch {
    return []
  }
  if (role !== 'user' && role !== 'assistant') return []

  const out: RawMessage[] = []
  let text = ''
  const eatPart = (pd: ContentPart): void => {
    if (pd.type === 'text' && typeof pd.text === 'string' && pd.text.trim()) {
      text += (text ? '\n' : '') + pd.text
    } else if (pd.type === 'tool') {
      // legacy parts name the tool `tool`, v2 content parts name it `name`
      const toolName = typeof pd.tool === 'string' ? pd.tool : typeof pd.name === 'string' ? pd.name : null
      if (toolName) {
        out.push({
          role: 'tool',
          toolName,
          content: JSON.stringify(pd.state?.input ?? {}),
          ts: created
        })
      }
    }
    // reasoning / step-finish / timeline … carry no displayable turn content
  }
  for (const p of parts) {
    try {
      eatPart(JSON.parse(p.data) as ContentPart)
    } catch {
      continue
    }
  }
  // v2: parts are embedded in the message data — assistant `content` array,
  // plain user `text` (only when the layout has no separate part rows)
  if (Array.isArray(j.content)) {
    for (const c of j.content as ContentPart[]) eatPart(c)
  } else if (parts.length === 0 && typeof j.text === 'string' && j.text.trim()) {
    text = j.text
  }
  if (text.trim()) out.unshift({ role, content: text, ts: created })
  return out
}

/** open the store and pick the layout: legacy `session` first, then `session_v2` */
function detectLayout(db: ReturnType<typeof openForeignDb>['db']): 'legacy' | 'v2' | null {
  const tables = new Set(
    (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map(
      (r) => r.name
    )
  )
  if (tables.has('session')) return 'legacy'
  if (tables.has('session_v2')) return 'v2'
  return null
}

/**
 * 子会话判定所需的列在不同代/不同 fork 里并不一致:
 *   zcode     : session.parent_id + session.task_type('interactive'|'subagent_child'|'workflow_child'|'selection_side_chat')
 *   opencode  : session.parent_id (+ agent='explore' 之类)
 *   session_v2: 可能两者都没有 —— 有就取,没有就当顶层会话
 * 所以先按 PRAGMA 探测列,再拼 SELECT;表名只可能是上面两个常量。
 */
function sessionColumns(
  db: ReturnType<typeof openForeignDb>['db'],
  table: 'session' | 'session_v2'
): Set<string> {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    return new Set(rows.map((r) => r.name))
  } catch {
    return new Set()
  }
}

/** 一次 SELECT 的列清单:基础列 + 探测到的子会话线索列 + 归档列 */
function sessionSelectList(columns: Set<string>): string {
  const extra: string[] = []
  if (columns.has('parent_id')) extra.push('parent_id')
  if (columns.has('task_type')) extra.push('task_type')
  if (columns.has('agent')) extra.push('agent')
  if (columns.has('time_archived')) extra.push('time_archived')
  return ['id', 'directory', 'title', 'time_created', 'time_updated', ...extra].join(', ')
}

/** 是否子代理/子任务会话(源库标注,不靠猜标题) */
function subagentOf(row: SessionRow): boolean {
  if (typeof row.parent_id === 'string' && row.parent_id.trim() !== '') return true
  const taskType = typeof row.task_type === 'string' ? row.task_type.trim() : ''
  return taskType !== '' && taskType !== 'interactive'
}

/** 源库归档标记(opencode 2.2.6 起 --archived 会把脚本化/CI 会话直接建成归档态) */
function archivedOf(row: SessionRow): boolean {
  return row.time_archived != null
}

/**
 * Parse the whole store (or a single session when onlySessionId is given).
 * Sessions without any parseable turns are skipped.
 *
 * `opts.since` (epoch ms) restricts a full scan to sessions whose
 * `time_updated` is newer — the startup scan used to re-parse every session
 * (788 ms for 73 zcode sessions / 30k messages) even when nothing changed.
 */
export function parseAgentSqliteSessions(
  dbPath: string,
  agentType: RawSession['agentType'],
  onlySessionId?: string,
  opts?: { since?: number }
): RawSession[] {
  let db: ReturnType<typeof openForeignDb>['db']
  let cleanup: () => void
  try {
    ;({ db, cleanup } = openForeignDb(dbPath))
  } catch {
    return [] // missing/unopenable store — nothing to import
  }
  try {
    const layout = detectLayout(db)
    if (layout === null) return [] // unknown schema — never throw "no such table"

    const since = !onlySessionId && opts?.since && opts.since > 0 ? opts.since : null
    const table = layout === 'legacy' ? 'session' : 'session_v2'
    const cols = sessionSelectList(sessionColumns(db, table))
    const sessions: SessionRow[] = []
    if (layout === 'legacy') {
      sessions.push(
        ...(onlySessionId
          ? (db.prepare(`SELECT ${cols} FROM session WHERE id = ?`).all(onlySessionId) as SessionRow[])
          : since !== null
            ? (db.prepare(`SELECT ${cols} FROM session WHERE time_updated > ? ORDER BY time_updated`).all(since) as SessionRow[])
            : (db.prepare(`SELECT ${cols} FROM session ORDER BY time_updated`).all() as SessionRow[]))
      )
    } else {
      // session_v2 keeps the legacy column names for id/directory/title/time_*
      sessions.push(
        ...(onlySessionId
          ? (db.prepare(`SELECT ${cols} FROM session_v2 WHERE id = ?`).all(onlySessionId) as SessionRow[])
          : since !== null
            ? (db.prepare(`SELECT ${cols} FROM session_v2 WHERE time_updated > ? ORDER BY time_updated`).all(since) as SessionRow[])
            : (db.prepare(`SELECT ${cols} FROM session_v2 ORDER BY time_updated`).all() as SessionRow[]))
      )
    }

    const msgStmt =
      layout === 'legacy'
        ? db.prepare('SELECT id, session_id, data FROM message WHERE session_id = ? ORDER BY rowid')
        : db.prepare('SELECT id, session_id, type, data FROM session_message WHERE session_id = ? ORDER BY seq')
    // legacy only — v2 has no part table (parts live in the message data)
    const partStmt = layout === 'legacy' ? db.prepare('SELECT id, message_id, data FROM part WHERE message_id = ? ORDER BY rowid') : null

    const out: RawSession[] = []
    for (const s of sessions) {
      const messages: RawMessage[] = []
      for (const m of msgStmt.all(s.id) as V2MessageRow[]) {
        // v2 roles come from the type column; legacy from the data JSON
        const parts = partStmt ? (partStmt.all(m.id) as PartRow[]) : []
        messages.push(...messageToRaw(m.data, parts, layout === 'v2' ? m.type : undefined))
      }
      if (messages.length === 0) continue
      const isSubagent = subagentOf(s)
      out.push({
        externalId: s.id,
        agentType,
        cwd: s.directory ?? undefined,
        startedAt: epoch(s.time_created) ?? epoch(s.time_updated),
        endedAt: epoch(s.time_updated) ?? epoch(s.time_created),
        title: s.title ?? undefined,
        messages,
        rawPath: dbPath,
        ...(isSubagent
          ? { isSubagent: true, parentExternalId: typeof s.parent_id === 'string' ? s.parent_id : undefined }
          : {}),
        ...(archivedOf(s) ? { archived: true } : {})
      })
    }
    return out
  } finally {
    cleanup()
  }
}
