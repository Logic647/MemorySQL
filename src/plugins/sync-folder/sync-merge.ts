import type Database from 'better-sqlite3'

/**
 * Merge logic for sync-folder. Cross-device rows never share ids
 * (autoincrement per device), so merging uses NATURAL KEYS:
 *   projects  → path
 *   sessions  → (agent_type, external_id), messages follow their session
 *   memories  → content union (a memory is a fact; duplicates by content
 *               are skipped, new ids are assigned locally). scope/项目/
 *               locked/status 随包携带;项目记忆按 path 落到本地项目。
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
  // v2 fields (older bundles lack them → merge falls back to the old
  // global/active/unlocked defaults, which keeps bundle format compatible)
  scope?: string | null
  status?: string | null
  locked?: number | null
  agent_type?: string | null
  project_path?: string | null
  project_name?: string | null
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
      INSERT INTO sessions (agent_type, external_id, cwd, started_at, ended_at, last_message_at,
                            title, summary, content_hash, message_count, tool_call_count,
                            updated_at, device_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const sessUpd = db.prepare(`
      UPDATE sessions SET cwd = ?, started_at = ?, ended_at = ?, last_message_at = ?,
        title = ?, summary = ?, content_hash = ?, message_count = ?, tool_call_count = ?, updated_at = ?
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
      // last conversation time, derived from the synced messages themselves
      // (the bundle format stays unchanged — no cross-version field drift).
      // ts 0 counts as absent: a 0 would otherwise suppress the ended_at
      // fallback and show up as 1970.
      const lastMsgAt =
        msgs.reduce<number | null>(
          (max, m) => (m.ts != null && m.ts > 0 && (max == null || m.ts > max) ? m.ts : max),
          null
        ) ?? s.ended_at ?? null

      if (!local) {
        let sessionId = 0
        sessionId = Number(
          (sessIns.run(
            s.agent_type,
            s.external_id,
            s.cwd,
            s.started_at,
            s.ended_at,
            lastMsgAt,
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
        // user-renamed titles survive sync (parity with the ingest path)
        const lock = db
          .prepare(`SELECT title_locked, title FROM sessions WHERE id = ?`)
          .get(local.id) as { title_locked: number; title: string | null } | undefined
        const effTitle = lock?.title_locked ? lock.title ?? s.title : s.title
        const oldIds = (msgIds.all(local.id) as Array<{ id: number }>).map((r) => r.id)
        for (const mid of oldIds) ftsMsgDel.run(mid)
        msgDel.run(local.id)
        sessUpd.run(
          s.cwd,
          s.started_at,
          s.ended_at,
          lastMsgAt,
          effTitle,
          s.summary,
          s.content_hash,
          s.message_count,
          s.tool_call_count,
          s.updated_at,
          local.id
        )
        replaceMessages(local.id, msgs)
        ftsSessionDel.run(local.id)
        ftsSessionIns.run(local.id, effTitle ?? '', s.summary ?? '')
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
    // 记忆分层(2026-11-12)起,bundle 携带 scope/项目/锁定/状态:
    //   项目记忆在接收端按 path 落到本地项目(找不到就按 path 兜底建一个,
    //   与 projects 段同口径);否则会全部落成 global,分层直接失效。
    //   locked 必须携带,否则另一台机器的 curator 会覆盖用户锁定的条目;
    //   status 必须携带,否则 retired 的条目会在对端复活成 active。
    const memExists = db.prepare('SELECT id FROM memories WHERE deleted = 0 AND content = ?')
    const memFindByPath = db.prepare('SELECT id FROM projects WHERE path = ? AND deleted = 0 LIMIT 1')
    const memProjIns = db.prepare(
      'INSERT INTO projects (path, name, updated_at, device_id) VALUES (?, ?, ?, ?)'
    )
    const memIns = db.prepare(
      `INSERT INTO memories
         (kind, content, source, status, locked, scope, project_id, agent_type, updated_at, device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const basename = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() || p
    for (const m of bundle.memories) {
      if (memExists.get(m.content)) continue
      let projectId: number | null = null
      let scope = m.scope === 'project' ? 'project' : 'global'
      if (scope === 'project') {
        const local = m.project_path
          ? (memFindByPath.get(m.project_path) as { id: number } | undefined)
          : undefined
        if (local) {
          projectId = local.id
        } else if (m.project_path) {
          // bundle.projects 段只带水位内的项目;记忆引用的项目可能不在其中,
          // 这里按 path 兜底建一行(名字优先取 bundle 里的,再退到目录名)
          projectId = Number(
            (
              memProjIns.run(
                m.project_path,
                m.project_name || basename(m.project_path),
                m.updated_at,
                bundle.device
              ) as { lastInsertRowid: number | bigint }
            ).lastInsertRowid
          )
          report.projectsAdded++
        } else {
          // 远端是项目记忆但没带项目信息:落成全局而不是丢数据
          scope = 'global'
        }
      }
      const status = m.status === 'candidate' || m.status === 'retired' ? m.status : 'active'
      memIns.run(
        m.kind,
        m.content,
        m.source,
        status,
        m.locked ? 1 : 0,
        scope,
        projectId,
        m.agent_type ?? null,
        m.updated_at,
        m.device_id ?? bundle.device
      )
      report.memoriesAdded++
    }
  })

  run()
  return report
}
