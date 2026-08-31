import type Database from 'better-sqlite3'
import type { SearchHit } from '../../shared/types'

export interface SearchService {
  searchAll(q: string, limit?: number): SearchHit[]
}

export function createSearchService(sqlite: Database.Database): SearchService {
  const sessionHit = sqlite.prepare(`
    SELECT s.id, s.agent_type, s.title, s.started_at,
           snippet(sessions_fts, 1, '«', '»', '…', 10) AS snip
    FROM sessions_fts f JOIN sessions s ON s.id = f.rowid
    WHERE sessions_fts MATCH ? AND s.deleted = 0
    ORDER BY rank LIMIT ?
  `)
  const messageHit = sqlite.prepare(`
    SELECT m.id, m.session_id, s.agent_type, s.title,
           snippet(messages_fts, 0, '«', '»', '…', 10) AS snip
    FROM messages_fts f
    JOIN session_messages m ON m.id = f.rowid
    JOIN sessions s ON s.id = m.session_id
    WHERE messages_fts MATCH ? AND s.deleted = 0
    ORDER BY rank LIMIT ?
  `)
  // memories_fts (CORE_MIGRATIONS v3) exists before this service is created;
  // triggers keep it in sync from every memory write path
  const memoryHit = sqlite.prepare(`
    SELECT m.id, m.kind, m.agent_type,
           snippet(memories_fts, 0, '«', '»', '…', 10) AS snip
    FROM memories_fts f JOIN memories m ON m.id = f.rowid
    WHERE memories_fts MATCH ? AND m.deleted = 0 AND m.status != 'retired'
    ORDER BY rank LIMIT ?
  `)
  const sessionLike = sqlite.prepare(`
    SELECT id, agent_type, title, started_at, summary FROM sessions
    WHERE deleted = 0 AND (title LIKE ? OR summary LIKE ?)
    ORDER BY started_at DESC LIMIT ?
  `)
  const messageLike = sqlite.prepare(`
    SELECT m.id, m.session_id, s.agent_type, s.title, substr(m.content, 1, 120) AS snip
    FROM session_messages m JOIN sessions s ON s.id = m.session_id
    WHERE s.deleted = 0 AND m.content LIKE ?
    ORDER BY m.id DESC LIMIT ?
  `)
  const memoryLike = sqlite.prepare(`
    SELECT id, kind, agent_type, substr(content, 1, 120) AS snip FROM memories
    WHERE deleted = 0 AND status != 'retired' AND content LIKE ?
    ORDER BY updated_at DESC LIMIT ?
  `)

  // notes/notes_fts belong to core-vault's migration, which may not have run
  // when this service is constructed — prepare lazily, skip if never created
  let noteStmts:
    | {
        hit: Database.Statement
        like: Database.Statement
      }
    | null
    | undefined
  const noteQueries = (): { hit: Database.Statement; like: Database.Statement } | null => {
    if (noteStmts === undefined) {
      try {
        noteStmts = {
          hit: sqlite.prepare(`
            SELECT n.id, n.title, snippet(notes_fts, 1, '«', '»', '…', 8) AS snip
            FROM notes_fts f JOIN notes n ON n.id = f.rowid
            WHERE notes_fts MATCH ? AND n.deleted = 0
            LIMIT ?
          `),
          like: sqlite.prepare(`
            SELECT n.id, n.title, n.title AS snip FROM notes n
            WHERE n.deleted = 0 AND n.title LIKE ?
            ORDER BY n.updated_at DESC LIMIT ?
          `)
        }
      } catch {
        noteStmts = null // core-vault disabled or not yet migrated
      }
    }
    return noteStmts
  }

  return {
    searchAll(q: string, limit = 40): SearchHit[] {
      const query = q.trim()
      if (!query) return []
      const hits: SearchHit[] = []
      if (query.length >= 3) {
        // trigram tokenizer: quote the phrase so operators are treated literally
        const match = `"${query.replace(/"/g, '""')}"`
        for (const r of sessionHit.all(match, limit) as Array<Record<string, unknown>>) {
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
        for (const r of messageHit.all(match, limit) as Array<Record<string, unknown>>) {
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
        for (const r of memoryHit.all(match, limit) as Array<{
          id: number
          kind: string
          agent_type: string | null
          snip: string
        }>) {
          hits.push({
            kind: 'memory',
            id: r.id,
            agentType: (r.agent_type ?? undefined) as SearchHit['agentType'],
            title: `[${r.kind}]`,
            snippet: r.snip,
            rank: hits.length
          })
        }
        const notes = noteQueries()
        if (notes) {
          for (const r of notes.hit.all(match, limit) as Array<{
            id: number
            title: string | null
            snip: string
          }>) {
            hits.push({
              kind: 'note',
              id: r.id,
              title: r.title,
              snippet: r.snip,
              rank: hits.length
            })
          }
        }
      } else {
        // trigram needs >=3 chars — fall back to LIKE for very short queries
        const like = `%${query}%`
        for (const r of sessionLike.all(like, like, limit) as Array<Record<string, unknown>>) {
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
        for (const r of messageLike.all(like, limit) as Array<Record<string, unknown>>) {
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
        for (const r of memoryLike.all(like, limit) as Array<{
          id: number
          kind: string
          agent_type: string | null
          snip: string
        }>) {
          hits.push({
            kind: 'memory',
            id: r.id,
            agentType: (r.agent_type ?? undefined) as SearchHit['agentType'],
            title: `[${r.kind}]`,
            snippet: r.snip,
            rank: hits.length
          })
        }
        const notes = noteQueries()
        if (notes) {
          for (const r of notes.like.all(like, limit) as Array<{
            id: number
            title: string | null
            snip: string
          }>) {
            hits.push({
              kind: 'note',
              id: r.id,
              title: r.title,
              snippet: r.snip,
              rank: hits.length
            })
          }
        }
      }
      return hits.slice(0, limit)
    }
  }
}
