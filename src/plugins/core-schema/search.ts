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
      } else {
        // trigram needs >=3 chars — fall back to LIKE for very short queries
        const like = `%${query}%`
        for (const r of sessionLike.all(like, like, limit) as Array<Record<string, unknown>>) {
          hits.push({
            kind: 'session',
            id: r.id as number,
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
      }
      return hits.slice(0, limit)
    }
  }
}
