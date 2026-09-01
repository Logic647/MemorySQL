import type { MemorySQLPlugin } from '../../main/core/plugin-host'
import type { SessionSummaryRow, MessageRow, SearchHit } from '../../shared/types'
import { CORE_MIGRATIONS } from './migrations'
import { createIngestService, type IngestService } from './ingest'
import { createSearchService, type SearchService } from './search'
import { createMcpTools } from './mcp-tools'

export interface MemoriesService {
  upsertMemory(input: { kind: string; content: string; source: string; agentType?: string; status?: string }): { id: number; changed: boolean }
  addMemory(input: {
    kind: string
    content: string
    source: string
    agentType?: string
    status?: string
    projectId?: number | null
    tags?: string[]
  }): { id: number }
}

const plugin: MemorySQLPlugin = {
  manifest: {
    id: 'core-schema',
    name: 'Core Schema & Ingest',
    version: '0.1.0',
  },

  init(ctx) {
    ctx.db.migrate(CORE_MIGRATIONS)
    ctx.log.info('schema migrated')

    const ingest = createIngestService({
      sqlite: ctx.db.sqlite,
      getSummarizer: () => ctx.summarizer.pickActive(),
      onIngest: (sessionIds) => {
        if (sessionIds.length > 0) ctx.events.emit('ingest:result', sessionIds)
        ctx.events.emit('sessions:changed')
      }
    })
    const search = createSearchService(ctx.db.sqlite)

    ctx.services.provide<IngestService>('ingest', ingest)
    ctx.services.provide<SearchService>('search', search)
    ctx.services.provide<MemoriesService>('memories', ingest)

    // MCP tools served by the mcp-server plugin via the host registry
    const mcpTools = createMcpTools({
      sqlite: ctx.db.sqlite,
      search,
      memories: ingest,
      services: ctx.services
    })
    for (const tool of mcpTools) {
      ctx.mcp.registerTool(tool)
    }
    ctx.log.info(`registered ${mcpTools.length} mcp tools`)

    // ----- renderer-facing IPC -------------------------------------------
    ctx.ipc.handle('sessions:list', (payload) => {
      const { agentType, limit = 100, offset = 0, archived = false } = (payload ?? {}) as {
        agentType?: string
        limit?: number
        offset?: number
        archived?: boolean
      }
      const where = agentType && agentType !== 'all' ? 'AND agent_type = ?' : ''
      const archivedWhere = archived ? 'AND s.archived = 1' : 'AND s.archived = 0'
      const params: unknown[] = agentType && agentType !== 'all' ? [agentType] : []
      const rows = ctx.db.sqlite
        .prepare(
          `SELECT s.id, s.agent_type AS agentType, s.external_id AS externalId,
                  s.title, s.summary, p.name AS project,
                  s.started_at AS startedAt, s.ended_at AS endedAt,
                  s.message_count AS messageCount, s.tool_call_count AS toolCallCount,
                  s.title_locked AS titleLocked, s.archived AS archived, s.similar_to AS similarTo
           FROM sessions s LEFT JOIN projects p ON p.id = s.project_id
           WHERE s.deleted = 0 ${archivedWhere} ${where}
           ORDER BY COALESCE(s.started_at, s.updated_at) DESC
           LIMIT ? OFFSET ?`
        )
        .all(...params, limit, offset)
      return rows as SessionSummaryRow[]
    })

    ctx.ipc.handle('sessions:get', (payload) => {
      const { id } = (payload ?? {}) as { id?: number }
      if (!id) throw new Error('sessions:get requires id')
      const session = ctx.db.sqlite
        .prepare(
          `SELECT s.*, p.name AS project FROM sessions s
           LEFT JOIN projects p ON p.id = s.project_id WHERE s.id = ?`
        )
        .get(id) as Record<string, unknown> | undefined
      if (!session) throw new Error(`session not found: ${id}`)
      const messages = ctx.db.sqlite
        .prepare(
          `SELECT id, seq, role, content, ts, tool_name AS "toolName"
           FROM session_messages WHERE session_id = ? ORDER BY seq`
        )
        .all(id)
      return { session, messages: messages as MessageRow[] }
    })

    ctx.ipc.handle('sessions:rename', (payload) => {
      const { id, title } = (payload ?? {}) as { id?: number; title?: string }
      if (!id) throw new Error('sessions:rename requires id')
      const t = String(title ?? '').trim()
      if (!t) throw new Error('标题不能为空')
      const row = ctx.db.sqlite
        .prepare(`SELECT summary FROM sessions WHERE id = ? AND deleted = 0`)
        .get(id) as { summary: string | null } | undefined
      if (!row) throw new Error(`session not found: ${id}`)
      const finalTitle = t.slice(0, 200)
      const tx = ctx.db.sqlite.transaction(() => {
        ctx.db.sqlite
          .prepare(`UPDATE sessions SET title = ?, title_locked = 1, updated_at = ? WHERE id = ?`)
          .run(finalTitle, Date.now(), id)
        ctx.db.sqlite.prepare(`DELETE FROM sessions_fts WHERE rowid = ?`).run(id)
        ctx.db.sqlite
          .prepare(`INSERT INTO sessions_fts (rowid, title, summary) VALUES (?, ?, ?)`)
          .run(id, finalTitle, row.summary ?? '')
      })
      tx()
      ctx.events.emit('sessions:changed')
      return { ok: true, title: finalTitle }
    })

    ctx.ipc.handle('sessions:archive', (payload) => {
      const { id, archived } = (payload ?? {}) as { id?: number; archived?: boolean }
      if (!id || typeof archived !== 'boolean') throw new Error('sessions:archive requires {id, archived}')
      ctx.db.sqlite
        .prepare(`UPDATE sessions SET archived = ?, updated_at = ? WHERE id = ? AND deleted = 0`)
        .run(archived ? 1 : 0, Date.now(), id)
      ctx.events.emit('sessions:changed')
      return { ok: true }
    })

    ctx.ipc.handle('search:all', (payload) => {
      const { q, limit = 40 } = (payload ?? {}) as { q?: string; limit?: number }
      return search.searchAll(q ?? '', limit) as SearchHit[]
    })

    ctx.ipc.handle('memories:list', () => {
      return ctx.db.sqlite
        .prepare(
          `SELECT id, kind, content, source, status, agent_type AS agentType, tags, project_id AS projectId, updated_at FROM memories
           WHERE deleted = 0 ORDER BY kind, updated_at DESC`
        )
        .all()
    })

    ctx.ipc.handle('stats:overview', () => {
      const byAgent = ctx.db.sqlite
        .prepare(
          `SELECT agent_type, COUNT(*) AS sessions, SUM(message_count) AS messages
           FROM sessions WHERE deleted = 0 GROUP BY agent_type`
        )
        .all()
      const memories = (
        ctx.db.sqlite.prepare('SELECT COUNT(*) AS n FROM memories WHERE deleted = 0').get() as {
          n: number
        }
      ).n
      return { byAgent, memories }
    })
  },

  start() {
    console.info('[core-schema] core services ready (ingest / search / memories)')
  }
}

export default plugin
