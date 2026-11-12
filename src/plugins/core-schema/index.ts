import type { MemorySQLPlugin } from '../../main/core/plugin-host'
import type { SessionSummaryRow, MessageRow, SearchHit } from '../../shared/types'
import { CORE_MIGRATIONS } from './migrations'
import { createIngestService, type IngestService } from './ingest'
import { createSearchService, type SearchService } from './search'
import { createMcpTools } from './mcp-tools'

export interface MemoriesService {
  upsertMemory(input: {
    kind: string
    content: string
    source: string
    agentType?: string
    status?: string
    tags?: string[]
    projectId?: number | null
    scope?: 'global' | 'project'
    locked?: boolean
  }): { id: number; changed: boolean }
  addMemory(input: {
    kind: string
    content: string
    source: string
    agentType?: string
    status?: string
    projectId?: number | null
    tags?: string[]
    scope?: 'global' | 'project'
    locked?: boolean
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
      const { agentType, limit = 100, offset = 0, archived = false, includeSubagents = false } =
        (payload ?? {}) as {
          agentType?: string
          limit?: number
          offset?: number
          archived?: boolean
          includeSubagents?: boolean
        }
      const where = agentType && agentType !== 'all' ? 'AND s.agent_type = ?' : ''
      const archivedWhere = archived ? 'AND s.archived = 1' : 'AND s.archived = 0'
      // 子代理会话默认不占列表位置(它们挂在父会话下面,见 sessions:subagents)
      const subWhere = includeSubagents ? '' : 'AND s.is_subagent = 0'
      const params: unknown[] = agentType && agentType !== 'all' ? [agentType] : []
      const rows = ctx.db.sqlite
        .prepare(
          `SELECT s.id, s.agent_type AS agentType, s.external_id AS externalId,
                  s.title, s.summary, p.name AS project,
                  s.started_at AS startedAt, s.ended_at AS endedAt,
                  s.last_message_at AS lastMessageAt,
                  s.message_count AS messageCount, s.tool_call_count AS toolCallCount,
                  s.title_locked AS titleLocked, s.archived AS archived, s.similar_to AS similarTo,
                  s.sort_key AS sortKey, s.project_id AS projectId,
                  s.is_subagent AS isSubagent, s.parent_session_id AS parentSessionId,
                  (SELECT COUNT(*) FROM sessions c
                    WHERE c.parent_session_id = s.id AND c.deleted = 0) AS subagentCount
           FROM sessions s LEFT JOIN projects p ON p.id = s.project_id
           WHERE s.deleted = 0 ${archivedWhere} ${subWhere} ${where}
           ORDER BY COALESCE(s.started_at, s.updated_at) DESC
           LIMIT ? OFFSET ?`
        )
        .all(...params, limit, offset)
      return rows as SessionSummaryRow[]
    })

    // 父会话展开时取子代理会话(顺序与列表一致:新的在前)
    ctx.ipc.handle('sessions:subagents', (payload) => {
      const { parentId } = (payload ?? {}) as { parentId?: number }
      if (!parentId) return []
      return ctx.db.sqlite
        .prepare(
          `SELECT s.id, s.agent_type AS agentType, s.external_id AS externalId,
                  s.title, s.summary, p.name AS project,
                  s.started_at AS startedAt, s.ended_at AS endedAt,
                  s.last_message_at AS lastMessageAt,
                  s.message_count AS messageCount, s.tool_call_count AS toolCallCount,
                  s.title_locked AS titleLocked, s.archived AS archived, s.similar_to AS similarTo,
                  s.sort_key AS sortKey, s.project_id AS projectId,
                  s.is_subagent AS isSubagent, s.parent_session_id AS parentSessionId,
                  0 AS subagentCount
           FROM sessions s LEFT JOIN projects p ON p.id = s.project_id
           WHERE s.deleted = 0 AND s.parent_session_id = ?
           ORDER BY COALESCE(s.started_at, s.updated_at) ASC`
        )
        .all(parentId) as SessionSummaryRow[]
    })

    ctx.ipc.handle('sessions:get', (payload) => {
      const { id, beforeSeq, limit = 200, all = false } = (payload ?? {}) as {
        id?: number
        beforeSeq?: number
        limit?: number
        all?: boolean
      }
      if (!id) throw new Error('sessions:get requires id')
      const session = ctx.db.sqlite
        .prepare(
          `SELECT s.*, p.name AS project FROM sessions s
           LEFT JOIN projects p ON p.id = s.project_id WHERE s.id = ? AND s.deleted = 0`
        )
        .get(id) as Record<string, unknown> | undefined
      if (!session) throw new Error(`session not found: ${id}`)
      // tail-first paging: the default page is the LAST `limit` messages;
      // beforeSeq walks earlier pages. `all` lifts the cap (privacy export).
      const cap = all ? -1 : Math.min(Math.max(limit ?? 200, 1), 1000)
      const select = `SELECT id, seq, role, content, ts, tool_name AS "toolName"
           FROM session_messages WHERE session_id = ?`
      const rows =
        beforeSeq != null
          ? (ctx.db.sqlite
              .prepare(`${select} AND seq < ? ORDER BY seq DESC LIMIT ?`)
              .all(id, beforeSeq, cap) as MessageRow[])
          : (ctx.db.sqlite.prepare(`${select} ORDER BY seq DESC LIMIT ?`).all(id, cap) as MessageRow[])
      const messages = rows.reverse()
      const firstSeq = messages.length > 0 ? Number(messages[0].seq) : null
      const total = (
        ctx.db.sqlite
          .prepare(`SELECT COUNT(*) AS n FROM session_messages WHERE session_id = ?`)
          .get(id) as { n: number }
      ).n
      // `all` fetched everything — there can be nothing earlier to page in
      const hasMore =
        !all &&
        firstSeq != null &&
        !!ctx.db.sqlite
          .prepare(`SELECT 1 FROM session_messages WHERE session_id = ? AND seq < ? LIMIT 1`)
          .get(id, firstSeq)
      return { session, messages, total, hasMore, firstSeq }
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

    // manual ordering: place a session between prevId/nextId (either may be
    // null = start/end of the list) and optionally move it to a project
    ctx.ipc.handle('sessions:move', (payload) => {
      const { id, projectId, prevId, nextId } = (payload ?? {}) as {
        id?: number
        projectId?: number | null
        prevId?: number | null
        nextId?: number | null
      }
      if (!id) throw new Error('sessions:move requires id')
      const keyOf = (rid: number): number | null => {
        const r = ctx.db.sqlite
          .prepare(`SELECT sort_key, started_at FROM sessions WHERE id = ?`)
          .get(rid) as { sort_key: number | null; started_at: number | null } | undefined
        return r ? (r.sort_key ?? r.started_at ?? null) : null
      }
      const prev = prevId != null ? keyOf(prevId) : null
      const next = nextId != null ? keyOf(nextId) : null
      let sortKey: number | null
      if (prev != null && next != null) sortKey = (prev + next) / 2
      else if (prev != null) sortKey = prev + 1
      else if (next != null) sortKey = next - 1
      else sortKey = null
      ctx.db.sqlite
        .prepare(
          `UPDATE sessions SET sort_key = ?, project_id = COALESCE(?, project_id), updated_at = ?
           WHERE id = ? AND deleted = 0`
        )
        .run(sortKey, projectId ?? null, Date.now(), id)
      ctx.events.emit('sessions:changed')
      return { ok: true, sortKey }
    })

    // drag & drop: move a session into a project (created on demand)
    ctx.ipc.handle('sessions:assignProject', (payload) => {
      const { id, projectName } = (payload ?? {}) as { id?: number; projectName?: string }
      if (!id) throw new Error('sessions:assignProject requires {id, projectName}')
      if (!projectName?.trim()) {
        ctx.db.sqlite
          .prepare(`UPDATE sessions SET project_id = NULL, updated_at = ? WHERE id = ? AND deleted = 0`)
          .run(Date.now(), id)
        ctx.events.emit('sessions:changed')
        return { ok: true, cleared: true }
      }
      const name = projectName.trim().slice(0, 120)
      let project = ctx.db.sqlite
        .prepare(`SELECT id FROM projects WHERE name = ? AND deleted = 0`)
        .get(name) as { id: number } | undefined
      if (!project) {
        const ins = ctx.db.sqlite
          .prepare(`INSERT INTO projects (name, updated_at, device_id) VALUES (?, ?, 'local')`)
          .run(name, Date.now()) as { lastInsertRowid: number | bigint }
        project = { id: Number(ins.lastInsertRowid) }
      }
      // moving a session carries its whole relay subtree (folded continuations
      // must follow their origin, or the chain splits across projects)
      ctx.db.sqlite
        .prepare(
          `WITH RECURSIVE tree(id) AS (
             SELECT ?
             UNION ALL
             SELECT s.id FROM sessions s JOIN tree t ON s.similar_to = t.id
             WHERE s.deleted = 0
           )
           UPDATE sessions SET project_id = ?, updated_at = ?
           WHERE id IN (SELECT id FROM tree) AND deleted = 0`
        )
        .run(id, project.id, Date.now())
      ctx.events.emit('sessions:changed')
      return { ok: true, projectId: project.id, project: name }
    })

    // manual relay curation: mark a session as a continuation of another
    // (targetId null clears an automatic/manual mark)
    ctx.ipc.handle('sessions:setRelay', (payload) => {
      const { id, targetId } = (payload ?? {}) as { id?: number; targetId?: number | null }
      if (!id) throw new Error('sessions:setRelay requires id')
      if (targetId != null) {
        if (targetId === id) throw new Error('不能把会话设为它自己的续接')
        const target = ctx.db.sqlite
          .prepare(`SELECT project_id, started_at FROM sessions WHERE id = ? AND deleted = 0`)
          .get(targetId) as { project_id: number | null; started_at: number | null } | undefined
        if (!target) throw new Error(`目标会话不存在: #${targetId}`)
        ctx.db.sqlite
          .prepare(`UPDATE sessions SET similar_to = ?, updated_at = ? WHERE id = ? AND deleted = 0`)
          .run(targetId, Date.now(), id)
      } else {
        ctx.db.sqlite
          .prepare(`UPDATE sessions SET similar_to = NULL, updated_at = ? WHERE id = ? AND deleted = 0`)
          .run(Date.now(), id)
      }
      ctx.events.emit('sessions:changed')
      return { ok: true }
    })

    ctx.ipc.handle('search:all', (payload) => {
      const { q, limit = 40 } = (payload ?? {}) as { q?: string; limit?: number }
      return search.searchAll(q ?? '', limit) as SearchHit[]
    })

    ctx.ipc.handle('memories:list', (payload) => {
      // paged: the memory list grows without bound (distill candidates, MCP
      // writes), so the renderer fetches it in chunks.
      // scope/project filters are pushed into SQL: the memory page now has a
      // global/project switch, and filtering 2000 loaded rows client-side would
      // make "项目记忆" look empty on large libraries.
      const { limit = 500, offset = 0, scope, projectId, kind, status } = (payload ?? {}) as {
        limit?: number
        offset?: number
        scope?: string
        projectId?: number
        kind?: string
        status?: string
      }
      const cap = Math.min(Math.max(limit ?? 500, 1), 2000)
      const where = ['m.deleted = 0']
      const params: Array<string | number> = []
      if (scope === 'global' || scope === 'project') {
        where.push('m.scope = ?')
        params.push(scope)
      }
      if (typeof projectId === 'number' && projectId > 0) {
        where.push('m.project_id = ?')
        params.push(projectId)
      }
      if (kind) {
        where.push('m.kind = ?')
        params.push(kind)
      }
      if (status) {
        where.push('m.status = ?')
        params.push(status)
      }
      return ctx.db.sqlite
        .prepare(
          `SELECT m.id, m.kind, m.content, m.source, m.status, m.agent_type AS agentType,
                  m.tags, m.project_id AS projectId, p.name AS projectName,
                  m.scope, m.locked, m.access_count AS accessCount, m.last_access_at AS lastAccessAt,
                  m.updated_at
             FROM memories m
             LEFT JOIN projects p ON p.id = m.project_id
            WHERE ${where.join(' AND ')}
            ORDER BY m.kind, m.updated_at DESC
            LIMIT ? OFFSET ?`
        )
        .all(...params, cap, Math.max(offset ?? 0, 0))
    })

    // 记忆页的项目筛选器:只列真正有项目记忆的项目(按条数降序)。
    // retired 不计入:自动整理会持续停用旧候选,侧栏计数要和默认列表一致。
    ctx.ipc.handle('memories:projects', () => {
      return ctx.db.sqlite
        .prepare(
          `SELECT p.id, p.name, COUNT(m.id) AS count
             FROM projects p
             JOIN memories m ON m.project_id = p.id AND m.deleted = 0 AND m.scope = 'project' AND m.status != 'retired'
            WHERE p.deleted = 0
            GROUP BY p.id
            ORDER BY count DESC, p.name`
        )
        .all() as Array<{ id: number; name: string; count: number }>
    })

    ctx.ipc.handle('stats:overview', () => {
      // 计数口径必须和列表一致:子代理会话不在列表里占位,这里也不计入,
      // 否则侧栏显示 100 而列表只有 63 条,用户只会觉得丢数据了
      const byAgent = ctx.db.sqlite
        .prepare(
          `SELECT agent_type, COUNT(*) AS sessions, SUM(message_count) AS messages
           FROM sessions WHERE deleted = 0 AND is_subagent = 0 GROUP BY agent_type`
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
