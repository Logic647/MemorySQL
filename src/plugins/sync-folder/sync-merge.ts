import type Database from 'better-sqlite3'

/**
 * Merge logic for sync-folder. Cross-device rows never share ids
 * (autoincrement per device), so merging uses NATURAL KEYS:
 *   projects  → path
 *   sessions  → (agent_type, external_id), messages follow their session
 *   memories  → content union (a memory is a fact; duplicates by content
 *               are skipped, new ids are assigned locally)
 * Conflicts resolve LWW on updated_at. Deletions do NOT propagate in this
 * MVP (documented limitation — use archive migration for full transfer).
 */

export interface BundleSession {
  agent_type: string
  external_id: string
  cwd: string | null
  started_at: number | null
  ended_at: number | null
  title: string | null
  summary: string | null
  content_hash: string
  message_count: number
  tool_call_count: number
  updated_at: number
}

export interface BundleMessage {
  session_key: string
  seq: number
  role: string
  content: string
  ts: number | null
  tool_name: string | null
}

export interface BundleMemory {
  kind: string
  content: string
  source: string | null
  updated_at: number
  device_id: string | null
}

export interface BundleProject {
  path: string
  name: string
  tech_stack: string | null
  updated_at: number
}

export interface SyncBundle {
  device: string
  exportedAt: number
  since: number
  sessions: BundleSession[]
  messages: BundleMessage[]
  memories: BundleMemory[]
  projects: BundleProject[]
}

export const sessionKey = (agentType: string, externalId: string): string => `${agentType}\u0000${externalId}`

export interface MergeReport {
  sessionsAdded: number
  sessionsUpdated: number
  memoriesAdded: number
  projectsAdded: number
  projectsUpdated: number
}

export function mergeBundle(db: Database.Database, bundle: SyncBundle): MergeReport {
  const report: MergeReport = {
    sessionsAdded: 0,
    sessionsUpdated: 0,
    memoriesAdded: 0,
    projectsAdded: 0,
    projectsUpdated: 0
  }

  const run = db.transaction(() => {
    // ---- projects (natural key: path) -----------------------------------
    const projFind = db.prepare('SELECT id, updated_at FROM projects WHERE path = ?')
    const projIns = db.prepare(
      'INSERT INTO projects (path, name, tech_stack, updated_at, device_id) VALUES (?, ?, ?, ?, ?)'
    )
    const projUpd = db.prepare(
      'UPDATE projects SET name = ?, tech_stack = ?, updated_at = ?, device_id = ? WHERE id = ?'
    )
    for (const p of bundle.projects) {
      const local = projFind.get(p.path) as { id: number; updated_at: number } | undefined
      if (!local) {
        projIns.run(p.path, p.name, p.tech_stack, p.updated_at, bundle.device)
        report.projectsAdded++
      } else if (p.updated_at > local.updated_at) {
        projUpd.run(p.name, p.tech_stack, p.updated_at, bundle.device, local.id)
        report.projectsUpdated++
      }
    }

    // ---- sessions (natural key: agent_type + external_id) ---------------
    const sessFind = db.prepare(
      'SELECT id, content_hash, updated_at FROM sessions WHERE agent_type = ? AND external_id = ?'
    )
    const sessIns = db.prepare(`
      INSERT INTO sessions (agent_type, external_id, cwd, started_at, ended_at, title, summary,
                            content_hash, message_count, tool_call_count, updated_at, device_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const sessUpd = db.prepare(`
      UPDATE sessions SET cwd = ?, started_at = ?, ended_at = ?, title = ?, summary = ?,
        content_hash = ?, message_count = ?, tool_call_count = ?, updated_at = ?
      WHERE id = ?
    `)
    const msgIds = db.prepare('SELECT id FROM session_messages WHERE session_id = ?')
    const msgDel = db.prepare('DELETE FROM session_messages WHERE session_id = ?')
    const msgIns = db.prepare(`
      INSERT INTO session_messages (session_id, seq, role, content, ts, tool_name)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    const ftsSessionDel = db.prepare('DELETE FROM sessions_fts WHERE rowid = ?')
    const ftsSessionIns = db.prepare('INSERT INTO sessions_fts (rowid, title, summary) VALUES (?, ?, ?)')
    const ftsMsgDel = db.prepare('DELETE FROM messages_fts WHERE rowid = ?')
    const ftsMsgIns = db.prepare('INSERT INTO messages_fts (rowid, content) VALUES (?, ?)')

    const messagesBySession = new Map<string, BundleMessage[]>()
    for (const m of bundle.messages) {
      const list = messagesBySession.get(m.session_key) ?? []
      list.push(m)
      messagesBySession.set(m.session_key, list)
    }

    for (const s of bundle.sessions) {
      const key = sessionKey(s.agent_type, s.external_id)
      const msgs = (messagesBySession.get(key) ?? []).sort((a, b) => a.seq - b.seq)
      const local = sessFind.get(s.agent_type, s.external_id) as
        | { id: number; content_hash: string; updated_at: number }
        | undefined

      if (!local) {
        let sessionId = 0
        sessionId = Number(
          (sessIns.run(
            s.agent_type,
            s.external_id,
            s.cwd,
            s.started_at,
            s.ended_at,
            s.title,
            s.summary,
            s.content_hash,
            s.message_count,
            s.tool_call_count,
            s.updated_at,
            bundle.device
          ) as { lastInsertRowid: number | bigint }).lastInsertRowid
        )
        replaceMessages(sessionId, msgs)
        ftsSessionIns.run(sessionId, s.title ?? '', s.summary ?? '')
        report.sessionsAdded++
      } else if (s.updated_at > local.updated_at && s.content_hash !== local.content_hash) {
        const oldIds = (msgIds.all(local.id) as Array<{ id: number }>).map((r) => r.id)
        for (const mid of oldIds) ftsMsgDel.run(mid)
        msgDel.run(local.id)
        sessUpd.run(
          s.cwd,
          s.started_at,
          s.ended_at,
          s.title,
          s.summary,
          s.content_hash,
          s.message_count,
          s.tool_call_count,
          s.updated_at,
          local.id
        )
        replaceMessages(local.id, msgs)
        ftsSessionDel.run(local.id)
        ftsSessionIns.run(local.id, s.title ?? '', s.summary ?? '')
        report.sessionsUpdated++
      }
    }

    function replaceMessages(sessionId: number, msgs: BundleMessage[]): void {
      for (const m of msgs) {
        const res = msgIns.run(sessionId, m.seq, m.role, m.content, m.ts, m.tool_name) as {
          lastInsertRowid: number | bigint
        }
        if (m.content.trim().length > 0) ftsMsgIns.run(Number(res.lastInsertRowid), m.content)
      }
    }

    // ---- memories (content union) ---------------------------------------
    const memExists = db.prepare('SELECT id FROM memories WHERE deleted = 0 AND content = ?')
    const memIns = db.prepare(
      'INSERT INTO memories (kind, content, source, updated_at, device_id) VALUES (?, ?, ?, ?, ?)'
    )
    for (const m of bundle.memories) {
      if (memExists.get(m.content)) continue
      memIns.run(m.kind, m.content, m.source, m.updated_at, m.device_id ?? bundle.device)
      report.memoriesAdded++
    }
  })

  run()
  return report
}
