import type Database from 'better-sqlite3'
import type { SearchHit } from '../../shared/types'

export interface SearchFilters {
  /** only query these sources; omitted = all four */
  kinds?: Array<SearchHit['kind']>
  /** sessions/messages by agent; memories include global (NULL) rows too */
  agent?: string
  /** sessions/messages scoped to a resolved project id */
  projectId?: number
  /** epoch-seconds cutoff; memories/notes compare their ms timestamps internally */
  sinceSec?: number
}

export interface SearchService {
  searchAll(q: string, limit?: number, filters?: SearchFilters): SearchHit[]
}

const quoteMatch = (query: string): string => `"${query.replace(/"/g, '""')}"`

export function createSearchService(sqlite: Database.Database): SearchService {
  // notes/notes_fts belong to core-vault's migration — probe per call so a
  // database without them (plugin disabled) simply yields no note hits
  const notesExist = sqlite.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notes_fts'`
  )

  return {
    searchAll(q: string, limit = 40, filters: SearchFilters = {}): SearchHit[] {
      const query = q.trim()
      if (!query) return []
      const kinds = filters.kinds && filters.kinds.length > 0 ? new Set<SearchHit['kind']>(filters.kinds) : null
      const want = (k: SearchHit['kind']): boolean => !kinds || kinds.has(k)
      const hits: SearchHit[] = []
      const agent = filters.agent
      const pid = filters.projectId
      const sinceSec = filters.sinceSec

      // ---- sessions ------------------------------------------------------
      if (want('session')) {
        const where = ['s.deleted = 0']
        const params: unknown[] = []
        if (agent) {
          where.push('s.agent_type = ?')
          params.push(agent)
        }
        if (pid != null) {
          where.push('s.project_id = ?')
          params.push(pid)
        }
        if (sinceSec != null) {
          where.push('COALESCE(s.started_at, s.updated_at) >= ?')
          params.push(sinceSec)
        }
        if (query.length >= 3) {
          const rows = sqlite
            .prepare(
              `SELECT s.id, s.agent_type, s.title,
                      snippet(sessions_fts, 1, '«', '»', '…', 10) AS snip
               FROM sessions_fts f JOIN sessions s ON s.id = f.rowid
               WHERE sessions_fts MATCH ? AND ${where.join(' AND ')}
               ORDER BY rank LIMIT ?`
            )
            .all(quoteMatch(query), ...params, limit) as Array<Record<string, unknown>>
          for (const r of rows) {
            hits.push({
              kind: 'session',
              id: r.id as number,
              sessionId: r.id as number,
              agentType: r.agent_type as SearchHit['agentType'],
              title: r.title as string,
              snippet: r.snip as string,
              rank: hits.length
            })
          }
        } else {
          // trigram needs >=3 chars — fall back to LIKE for very short queries
          const like = `%${query}%`
          const rows = sqlite
            .prepare(
              `SELECT s.id, s.agent_type, s.title, s.summary FROM sessions s
               WHERE ${where.join(' AND ')} AND (s.title LIKE ? OR s.summary LIKE ?)
               ORDER BY COALESCE(s.started_at, s.updated_at) DESC LIMIT ?`
            )
            .all(...params, like, like, limit) as Array<Record<string, unknown>>
          for (const r of rows) {
            hits.push({
              kind: 'session',
              id: r.id as number,
              sessionId: r.id as number,
              agentType: r.agent_type as SearchHit['agentType'],
              title: r.title as string,
              snippet: (r.summary as string) ?? '',
              rank: hits.length
            })
          }
        }
      }

      // ---- messages ------------------------------------------------------
      if (want('message')) {
        const where = ['s.deleted = 0']
        const params: unknown[] = []
        if (agent) {
          where.push('s.agent_type = ?')
          params.push(agent)
        }
        if (pid != null) {
          where.push('s.project_id = ?')
          params.push(pid)
        }
        if (sinceSec != null) {
          where.push('m.ts >= ?')
          params.push(sinceSec)
        }
        if (query.length >= 3) {
          const rows = sqlite
            .prepare(
              `SELECT m.id, m.session_id, s.agent_type, s.title,
                      snippet(messages_fts, 0, '«', '»', '…', 10) AS snip
               FROM messages_fts f
               JOIN session_messages m ON m.id = f.rowid
               JOIN sessions s ON s.id = m.session_id
               WHERE messages_fts MATCH ? AND ${where.join(' AND ')}
               ORDER BY rank LIMIT ?`
            )
            .all(quoteMatch(query), ...params, limit) as Array<Record<string, unknown>>
          for (const r of rows) {
            hits.push({
              kind: 'message',
              id: r.id as number,
              sessionId: r.session_id as number,
              agentType: r.agent_type as SearchHit['agentType'],
              title: r.title as string,
              snippet: r.snip as string,
              rank: hits.length
            })
          }
        } else {
          const like = `%${query}%`
          const rows = sqlite
            .prepare(
              `SELECT m.id, m.session_id, s.agent_type, s.title, substr(m.content, 1, 120) AS snip
               FROM session_messages m JOIN sessions s ON s.id = m.session_id
               WHERE ${where.join(' AND ')} AND m.content LIKE ?
               ORDER BY m.id DESC LIMIT ?`
            )
            .all(...params, like, limit) as Array<Record<string, unknown>>
          for (const r of rows) {
            hits.push({
              kind: 'message',
              id: r.id as number,
              sessionId: r.session_id as number,
              agentType: r.agent_type as SearchHit['agentType'],
              title: r.title as string,
              snippet: r.snip as string,
              rank: hits.length
            })
          }
        }
      }

      // ---- memories (global NULL agent rows always match an agent filter) --
      if (want('memory')) {
        const where = [`m.deleted = 0`, `m.status != 'retired'`]
        const params: unknown[] = []
        if (agent) {
          where.push('(m.agent_type IS NULL OR m.agent_type = ?)')
          params.push(agent)
        }
        if (sinceSec != null) {
          where.push('m.updated_at >= ?')
          params.push(sinceSec * 1000)
        }
        if (query.length >= 3) {
          const rows = sqlite
            .prepare(
              `SELECT m.id, m.kind, m.agent_type,
                      snippet(memories_fts, 0, '«', '»', '…', 10) AS snip
               FROM memories_fts f JOIN memories m ON m.id = f.rowid
               WHERE memories_fts MATCH ? AND ${where.join(' AND ')}
               ORDER BY rank LIMIT ?`
            )
            .all(quoteMatch(query), ...params, limit) as Array<Record<string, unknown>>
          for (const r of rows) {
            hits.push({
              kind: 'memory',
              id: r.id as number,
              agentType: (r.agent_type ?? undefined) as SearchHit['agentType'],
              title: `[${r.kind as string}]`,
              snippet: r.snip as string,
              rank: hits.length
            })
          }
        } else {
          const like = `%${query}%`
          const rows = sqlite
            .prepare(
              `SELECT m.id, m.kind, m.agent_type, substr(m.content, 1, 120) AS snip FROM memories m
               WHERE ${where.join(' AND ')} AND m.content LIKE ?
               ORDER BY m.updated_at DESC LIMIT ?`
            )
            .all(...params, like, limit) as Array<Record<string, unknown>>
          for (const r of rows) {
            hits.push({
              kind: 'memory',
              id: r.id as number,
              agentType: (r.agent_type ?? undefined) as SearchHit['agentType'],
              title: `[${r.kind as string}]`,
              snippet: r.snip as string,
              rank: hits.length
            })
          }
        }
      }

      // ---- notes ----------------------------------------------------------
      if (want('note') && notesExist.get()) {
        const where = ['n.deleted = 0']
        const params: unknown[] = []
        if (sinceSec != null) {
          where.push('n.updated_at >= ?')
          params.push(sinceSec * 1000)
        }
        if (query.length >= 3) {
          const rows = sqlite
            .prepare(
              `SELECT n.id, n.title, snippet(notes_fts, 1, '«', '»', '…', 8) AS snip
               FROM notes_fts f JOIN notes n ON n.id = f.rowid
               WHERE notes_fts MATCH ? AND ${where.join(' AND ')}
               LIMIT ?`
            )
            .all(quoteMatch(query), ...params, limit) as Array<Record<string, unknown>>
          for (const r of rows) {
            hits.push({
              kind: 'note',
              id: r.id as number,
              title: r.title as string,
              snippet: r.snip as string,
              rank: hits.length
            })
          }
        } else {
          const like = `%${query}%`
          const rows = sqlite
            .prepare(
              `SELECT n.id, n.title FROM notes n
               WHERE ${where.join(' AND ')} AND n.title LIKE ?
               ORDER BY n.updated_at DESC LIMIT ?`
            )
            .all(...params, like, limit) as Array<Record<string, unknown>>
          for (const r of rows) {
            hits.push({
              kind: 'note',
              id: r.id as number,
              title: r.title as string,
              snippet: r.title as string,
              rank: hits.length
            })
          }
        }
      }

      return hits.slice(0, limit)
    }
  }
}
