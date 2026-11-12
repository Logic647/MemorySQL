import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import type { RawMessage, RawSession } from '../../shared/types'
import type { SummarizerProvider } from '../../main/core/plugin-host'

const CONTENT_CAP = 100_000

/**
 * 单次入库等待摘要的预算。LLM 端点变慢/挂掉时不能把整次扫描堵在几十个
 * 会话的串行请求上(provider 自己的 45s 超时 × N 会变成分钟级)。
 * 超预算就先用规则标题入库;会话内容后续变化时会重新尝试总结(内容哈希未变
 * 则沿用库里的标题,不再重复调用)。
 */
const SUMMARY_BUDGET_MS = 15_000

/** stored content is capped before hashing, else >100KB-message sessions re-hash every scan */
function cap(text: string): string {
  return text.length > CONTENT_CAP ? `${text.slice(0, CONTENT_CAP)}\n…[truncated]` : text
}

function hashSession(s: RawSession): string {
  const h = crypto.createHash('sha256')
  h.update(s.agentType)
  h.update('\0')
  h.update(s.externalId)
  h.update('\0')
  for (const m of s.messages) {
    h.update(m.role)
    h.update('\0')
    h.update(cap(m.content))
    h.update('\0')
  }
  return h.digest('hex')
}

export interface IngestResult {
  scanned: number
  imported: number
  updated: number
  skipped: number
  sessionIds: number[]
}

export interface IngestService {
  ingestSessions(sessions: RawSession[]): Promise<IngestResult>
  upsertMemory(input: {
    kind: string
    content: string
    source: string
    agentType?: string
    status?: string
    tags?: string[]
    projectId?: number | null
    /** 缺省按 projectId 推断:有项目 = project,否则 = global */
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

export interface IngestDeps {
  sqlite: Database.Database
  getSummarizer: () => SummarizerProvider | null
  onIngest: (sessionIds: number[]) => void
}

/**
 * Newest message timestamp, in epoch seconds — the "last conversation time".
 *
 * `ts` of 0 is treated as absent, not as a real epoch: some adapters hand back
 * a 0 for a missing field, and storing it would (a) suppress the ended_at
 * fallback and (b) render as 1970 everywhere.
 */
function latestMessageTs(s: RawSession): number | null {
  let max: number | null = null
  for (const m of s.messages) {
    const ts = m.ts ?? 0
    if (ts > 0 && (max == null || ts > max)) max = ts
  }
  return max
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

function fallbackTitle(s: RawSession): string {
  const firstUser = s.messages.find((m) => m.role === 'user')?.content ?? ''
  return clip(firstLine(firstUser) || s.externalId, 80)
}

function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? ''
}

export function createIngestService(deps: IngestDeps): IngestService {
  const { sqlite, getSummarizer, onIngest } = deps
  const now = () => Date.now()
  // serializes concurrent ingest invocations across their await boundaries
  let ingestRunning: Promise<void> | null = null

  const stmtProjectFind = sqlite.prepare('SELECT id FROM projects WHERE path = ?')
  const stmtProjectIns = sqlite.prepare(
    'INSERT INTO projects (path, name, updated_at, device_id) VALUES (?, ?, ?, ?)'
  )
  const stmtProjectAdopt = sqlite.prepare(
    'UPDATE projects SET path = ?, name = ?, updated_at = ? WHERE id = ?'
  )
  const stmtProjectCandidates = sqlite.prepare(
    'SELECT id, path, name FROM projects WHERE deleted = 0 AND path IS NOT NULL AND path != ?'
  )
  const stmtSessionsRecwd = sqlite.prepare(
    'UPDATE sessions SET cwd = ?, project_id = ?, updated_at = ? WHERE cwd = ? AND deleted = 0'
  )
  const stmtSessionFind = sqlite.prepare(
    `SELECT id, content_hash, title_locked, title, cwd, project_id, summary, last_message_at,
            is_subagent, parent_external_id, parent_session_id, archived
     FROM sessions WHERE agent_type = ? AND external_id = ?`
  )
  const stmtSessionIns = sqlite.prepare(`
    INSERT INTO sessions (agent_type, external_id, project_id, cwd, started_at, ended_at,
                          last_message_at, title, summary, raw_path, content_hash,
                          message_count, tool_call_count, updated_at, device_id,
                          is_subagent, parent_external_id, archived)
    VALUES (@agent_type, @external_id, @project_id, @cwd, @started_at, @ended_at,
            @last_message_at, @title, @summary, @raw_path, @content_hash,
            @message_count, @tool_call_count, @updated_at, @device_id,
            @is_subagent, @parent_external_id, @archived)
  `)
  const stmtSessionUpdate = sqlite.prepare(`
    UPDATE sessions SET project_id = @project_id, cwd = @cwd, started_at = @started_at,
      ended_at = @ended_at, last_message_at = @last_message_at, title = @title, summary = @summary,
      content_hash = @content_hash, message_count = @message_count, tool_call_count = @tool_call_count,
      updated_at = @updated_at, raw_path = COALESCE(@raw_path, raw_path),
      is_subagent = @is_subagent, parent_external_id = @parent_external_id,
      archived = MAX(archived, @archived)
    WHERE id = @id
  `)
  // 父会话可能比子会话晚入库(首次全量导入、或父会话先被删再恢复),
  // 所以每次入库后做一次廉价回填 —— (agent_type, external_id) 有唯一索引。
  const stmtReconcileParents = sqlite.prepare(`
    UPDATE sessions
       SET parent_session_id = (
             SELECT p.id FROM sessions p
              WHERE p.agent_type = sessions.agent_type
                AND p.external_id = sessions.parent_external_id
                AND p.deleted = 0)
     WHERE is_subagent = 1 AND parent_session_id IS NULL AND parent_external_id IS NOT NULL
  `)
  // hash unchanged: only project/cwd/title/last_message_at may still need a refresh
  const stmtSessionMeta = sqlite.prepare(`
    UPDATE sessions SET project_id = @project_id, cwd = @cwd, title = @title,
      last_message_at = @last_message_at, updated_at = @updated_at,
      is_subagent = @is_subagent, parent_external_id = @parent_external_id,
      archived = @archived
    WHERE id = @id
  `)
  // message-level diff: compare the stored prefix against the freshly parsed
  // session and only rewrite the tail that actually changed. A long session
  // appending one message used to delete+reinsert every row (and every FTS
  // trigram entry) — measured at ~1.4 s for a 7.3k-message session.
  const stmtMsgCount = sqlite.prepare('SELECT count(*) AS n FROM session_messages WHERE session_id = ?')
  const stmtMsgIter = sqlite.prepare(
    'SELECT id, role, content, ts, tool_name, meta FROM session_messages WHERE session_id = ? ORDER BY seq'
  )
  const stmtMsgTailIds = sqlite.prepare(
    'SELECT id FROM session_messages WHERE session_id = ? AND seq >= ? ORDER BY seq'
  )
  const stmtMsgDelTail = sqlite.prepare(
    'DELETE FROM session_messages WHERE session_id = ? AND seq >= ?'
  )
  const stmtMsgIns = sqlite.prepare(`
    INSERT INTO session_messages (session_id, seq, role, content, ts, tool_name, meta)
    VALUES (@session_id, @seq, @role, @content, @ts, @tool_name, @meta)
  `)
  const stmtFtsSessionDel = sqlite.prepare('DELETE FROM sessions_fts WHERE rowid = ?')
  const stmtFtsSessionIns = sqlite.prepare(
    'INSERT INTO sessions_fts (rowid, title, summary) VALUES (?, ?, ?)'
  )
  const stmtFtsMsgDel = sqlite.prepare('DELETE FROM messages_fts WHERE rowid = ?')
  const stmtFtsMsgIns = sqlite.prepare('INSERT INTO messages_fts (rowid, content) VALUES (?, ?)')

  const pathExists = (p: string): boolean => {
    try {
      return fs.existsSync(p)
    } catch {
      return false
    }
  }
  const sameDir = (a: string, b: string): boolean => {
    const norm = (p: string): string => {
      const s = p.replace(/[\\/]+$/, '')
      return process.platform === 'win32' ? s.replace(/\//g, '\\').toLowerCase() : s
    }
    try {
      return norm(path.dirname(a)) === norm(path.dirname(b))
    } catch {
      return false
    }
  }

  /**
   * Resolve cwd → project row. A folder rename/move leaves the old row with a
   * path that no longer exists; when exactly one such orphan shares the new
   * path's parent (or its display name), adopt that row instead of forking a
   * duplicate project group, and re-point every session still on the old path.
   */
  const ensureProject = (cwd?: string): number | null => {
    if (!cwd) return null
    const existing = stmtProjectFind.get(cwd) as { id: number } | undefined
    if (existing) return existing.id
    const name = path.basename(cwd) || cwd
    const candidates = (stmtProjectCandidates.all(cwd) as Array<{ id: number; path: string; name: string }>).filter(
      (p) => sameDir(p.path, cwd)
    )
    const orphans = candidates.filter((p) => !pathExists(p.path))
    const adopt = orphans.find((p) => p.name === name) ?? (orphans.length === 1 ? orphans[0] : undefined)
    if (adopt) {
      stmtProjectAdopt.run(cwd, name, now(), adopt.id)
      stmtSessionsRecwd.run(cwd, adopt.id, now(), adopt.path)
      return adopt.id
    }
    return Number(
      (stmtProjectIns.run(cwd, name, now(), 'local') as { lastInsertRowid: number | bigint })
        .lastInsertRowid
    )
  }

  /** 超时返回 null(调用方降级);不负责取消 provider 自己的请求 */
  async function withinBudget<T>(p: Promise<T> | T, ms: number): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        Promise.resolve(p),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), ms)
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  const summarizeSession = async (
    s: RawSession
  ): Promise<{ title: string; summary: string }> => {
    // adapter-supplied titles are authoritative, and zero-message sessions
    // (e.g. Claude Desktop metadata) have nothing to summarize — no LLM spend
    if (s.title || s.messages.length === 0) {
      return { title: s.title ?? fallbackTitle(s), summary: '' }
    }
    /**
     * 内容没变时沿用库里已有的标题/摘要。
     *
     * 过去这里对**所有**无标题会话都调一次 LLM:claudecode 一次扫描 108 条里
     * 94 条会被「重新总结」,LLM 每次给的标题还不一样 → 94 次 update + 94 次
     * 联网,新会话的入库排在它们后面,用户看到的就是「点了扫描一直转」。
     * 会话消息哈希没变就没有重新总结的理由;用户改名(title_locked)也由
     * ingestOne 保留。
     */
    const existing = stmtSessionFind.get(s.agentType, s.externalId) as
      | { title: string | null; summary: string | null; content_hash: string }
      | undefined
    if (existing?.title && existing.content_hash === hashSession(s)) {
      return { title: existing.title, summary: existing.summary ?? '' }
    }
    const provider = getSummarizer()
    if (provider) {
      try {
        const out = await withinBudget(
          provider.summarize({
            agentType: s.agentType,
            cwd: s.cwd,
            messages: s.messages,
            currentTitle: s.title
          }),
          SUMMARY_BUDGET_MS
        )
        if (out) return out
        console.warn('[core-schema] summarizer timed out, using fallback title')
      } catch (err) {
        console.error('[core-schema] summarizer failed, using fallback', err)
      }
    }
    return { title: s.title ?? fallbackTitle(s), summary: '' }
  }

  const ingestOne = (
    s: RawSession,
    summary: { title: string; summary: string }
  ): { outcome: 'imported' | 'updated' | 'skipped'; id?: number } => {
    const contentHash = hashSession(s)
    const existing = stmtSessionFind.get(s.agentType, s.externalId) as
      | {
          id: number
          content_hash: string
          title_locked: number
          title: string | null
          cwd: string | null
          project_id: number | null
          summary: string | null
          last_message_at: number | null
          is_subagent: number
          parent_external_id: string | null
          parent_session_id: number | null
          archived: number
        }
      | undefined

    // 子会话标记(源库标注)。老库升级后这一列是默认 0,内容哈希又没变,
    // 所以下面「哈希相同」的早退里也要比对它,否则历史子会话永远不会被标上。
    const isSubagent = s.isSubagent ? 1 : 0
    const parentExternalId = s.isSubagent ? (s.parentExternalId ?? null) : null
    // 归档语义是**单调**的:源只能把它置 1(源库里用户归档了它);
    // 取消归档只能由用户在 MemorySQL 里做 —— 不然每次重扫都会翻回去。
    const archived = s.archived ? 1 : 0

    // a user-renamed title survives re-ingest (auto summaries never clobber it)
    const lockedTitle =
      existing?.title_locked && existing.title ? existing.title : undefined
    const nextTitle = lockedTitle ?? summary.title

    // trust the adapter's cwd only when it points at something real — a
    // renamed-away folder must not clobber a project we just re-homed
    const incomingCwd = s.cwd ?? null
    const effectiveCwd =
      incomingCwd != null && (pathExists(incomingCwd) || !existing?.cwd)
        ? incomingCwd
        : (existing?.cwd ?? incomingCwd)

    if (existing && existing.content_hash === contentHash) {
      // messages unchanged — title/cwd/project may still have moved
      const nextProjectId = ensureProject(effectiveCwd ?? undefined)
      const needTitle = nextTitle !== existing.title
      const needCwd = effectiveCwd !== existing.cwd
      const needProject = nextProjectId !== existing.project_id
      // content_hash covers only role+content, so an adapter that reports a
      // newer activity time for identical messages (Claude Desktop metadata:
      // no messages at all, endedAt = the file's lastActivityAt) would never
      // refresh last_message_at here. Keep it monotonic and refresh it too.
      const lastMessageAt = latestMessageTs(s) ?? s.endedAt ?? null
      const needLast = lastMessageAt != null && lastMessageAt > (existing.last_message_at ?? 0)
      const needSub =
        isSubagent !== existing.is_subagent || parentExternalId !== (existing.parent_external_id ?? null)
      // 归档只升不降(MAX),所以仅当源标记了归档且本地还是 0 时才算"需要动"
      const needArch = archived === 1 && existing.archived === 0
      if (!needTitle && !needCwd && !needProject && !needLast && !needSub && !needArch) {
        return { outcome: 'skipped' }
      }
      stmtSessionMeta.run({
        id: existing.id,
        project_id: nextProjectId,
        cwd: effectiveCwd,
        title: nextTitle,
        last_message_at: needLast ? lastMessageAt : existing.last_message_at,
        updated_at: now(),
        is_subagent: isSubagent,
        parent_external_id: parentExternalId,
        archived: needArch ? 1 : existing.archived
      })
      if (needTitle) {
        stmtFtsSessionDel.run(existing.id)
        stmtFtsSessionIns.run(existing.id, nextTitle, existing.summary ?? '')
      }
      stmtReconcileParents.run()
      return { outcome: 'updated', id: existing.id }
    }

    const projectId = ensureProject(effectiveCwd ?? undefined)
    const { title, summary: summaryText } = { title: nextTitle, summary: summary.summary }
    const toolCalls = s.messages.filter((m) => m.role === 'tool').length
    const counts = {
      message_count: s.messages.length,
      tool_call_count: toolCalls
    }
    // "last conversation time" = newest message timestamp; adapters that
    // report no per-message ts fall back to the session's ended_at
    const lastMessageAt = latestMessageTs(s) ?? s.endedAt ?? null

    if (existing) {
      const sessionId = existing.id
      const tx = sqlite.transaction(() => {
        stmtSessionUpdate.run({
          id: sessionId,
          project_id: projectId,
          cwd: effectiveCwd,
          started_at: s.startedAt ?? null,
          ended_at: s.endedAt ?? null,
          last_message_at: lastMessageAt,
          title,
          summary: summaryText,
          content_hash: contentHash,
          raw_path: s.rawPath ?? null,
          is_subagent: isSubagent,
          parent_external_id: parentExternalId,
          archived,
          ...counts,
          updated_at: now()
        })
        syncMessages(sessionId, s)
        stmtFtsSessionDel.run(sessionId)
        stmtFtsSessionIns.run(sessionId, title, summaryText)
      })
      tx()
      stmtReconcileParents.run()
      return { outcome: 'updated', id: sessionId }
    }

    let newId = 0
    const tx = sqlite.transaction(() => {
      newId = Number(
        (stmtSessionIns.run({
          agent_type: s.agentType,
          external_id: s.externalId,
          project_id: projectId,
          cwd: effectiveCwd,
          started_at: s.startedAt ?? null,
          ended_at: s.endedAt ?? null,
          last_message_at: lastMessageAt,
          title,
          summary: summaryText,
          raw_path: s.rawPath ?? null,
          content_hash: contentHash,
          ...counts,
          updated_at: now(),
          device_id: 'local',
          is_subagent: isSubagent,
          parent_external_id: parentExternalId,
          archived
        }) as { lastInsertRowid: number | bigint }).lastInsertRowid
      )
      insertMessages(newId, s)
      stmtFtsSessionIns.run(newId, title, summaryText)
    })
    tx()
    stmtReconcileParents.run()
    return { outcome: 'imported', id: newId }
  }

  interface StoredMessage {
    id: number
    role: string
    content: string
    ts: number | null
    tool_name: string | null
    meta: string | null
  }

  /** Field-for-field comparison against what insertMessages would have stored. */
  function sameMessage(row: StoredMessage, m: RawMessage): boolean {
    return (
      row.role === m.role &&
      row.content === cap(m.content) &&
      (row.ts ?? null) === (m.ts ?? null) &&
      (row.tool_name ?? null) === (m.toolName ?? null) &&
      (row.meta ?? null) === (m.meta ? JSON.stringify(m.meta) : null)
    )
  }

  /**
   * Rewrite only the messages that changed.
   *
   * Adapters re-parse the whole source file, so the overwhelmingly common case
   * is "old messages are a prefix of the new ones". Walk the stored rows in
   * `seq` order, stop at the first mismatch, and delete + reinsert from there.
   * Appending one message to a 7.3k-message session therefore touches one row
   * instead of deleting and re-inserting 7.3k rows (FTS trigram maintenance was
   * 94% of the old cost).
   */
  function syncMessages(sessionId: number, s: RawSession): void {
    const oldCount = (stmtMsgCount.get(sessionId) as { n: number }).n
    let keep = 0
    for (const row of stmtMsgIter.iterate(sessionId) as IterableIterator<StoredMessage>) {
      if (keep >= s.messages.length) break
      if (!sameMessage(row, s.messages[keep])) break
      keep++
    }
    if (keep === oldCount && keep === s.messages.length) return
    if (keep < oldCount) {
      for (const r of stmtMsgTailIds.all(sessionId, keep) as Array<{ id: number }>) {
        stmtFtsMsgDel.run(r.id)
      }
      stmtMsgDelTail.run(sessionId, keep)
    }
    insertMessages(sessionId, s, keep)
  }

  function insertMessages(sessionId: number, s: RawSession, from = 0): void {
    for (let seq = from; seq < s.messages.length; seq++) {
      const m = s.messages[seq]
      const res = stmtMsgIns.run({
        session_id: sessionId,
        seq,
        role: m.role,
        content: cap(m.content),
        ts: m.ts ?? null,
        tool_name: m.toolName ?? null,
        meta: m.meta ? JSON.stringify(m.meta) : null
      }) as { lastInsertRowid: number | bigint }
      // index meaningful content only; skip empty/tool-argument noise bodies
      if (m.content.trim().length > 0) {
        stmtFtsMsgIns.run(Number(res.lastInsertRowid), cap(m.content))
      }
    }
  }

  const ingestTx = sqlite.transaction(
    (sessions: RawSession[], summaries: Array<{ title: string; summary: string }>) => {
      const result: IngestResult = { scanned: 0, imported: 0, updated: 0, skipped: 0, sessionIds: [] }
      for (let i = 0; i < sessions.length; i++) {
        result.scanned++
        const { outcome, id } = ingestOne(sessions[i], summaries[i])
        if (outcome !== 'skipped' && id !== undefined) result.sessionIds.push(id)
        if (outcome === 'imported') result.imported++
        else if (outcome === 'updated') result.updated++
        else result.skipped++
      }
      return result
    }
  )

  // deleted rows stay found: user deletion must not be resurrected by a re-import
  const memoryFind = sqlite.prepare('SELECT id, content, deleted FROM memories WHERE source = ?')
  const memoryIns = sqlite.prepare(
    `INSERT INTO memories
       (kind, content, source, updated_at, device_id, agent_type, status, tags, project_id, scope, locked)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const memoryUpdate = sqlite.prepare(
    'UPDATE memories SET kind = ?, content = ?, agent_type = ?, updated_at = ? WHERE id = ?'
  )

  return {
    // summarization happens OUTSIDE the transaction — an LLM call must not
    // hold the write lock (sync providers just resolve immediately).
    // The run-lock keeps manual scans and watcher increments from
    // interleaving their await boundaries.
    async ingestSessions(sessions: RawSession[]): Promise<IngestResult> {
      while (ingestRunning) await ingestRunning
      let resolveLock: () => void = () => {}
      ingestRunning = new Promise<void>((r) => (resolveLock = r))
      try {
        const summaries: Array<{ title: string; summary: string }> = []
        for (const s of sessions) summaries.push(await summarizeSession(s))
        const res = ingestTx(sessions, summaries)
        if (res.imported + res.updated > 0) onIngest(res.sessionIds)
        return res
      } finally {
        resolveLock()
        ingestRunning = null
      }
    },

    upsertMemory(input): { id: number; changed: boolean } {
      const existing = memoryFind.get(input.source) as { id: number; content: string; deleted: number } | undefined
      if (existing?.deleted) return { id: existing.id, changed: false } // tombstone wins
      if (existing) {
        if (existing.content === input.content) return { id: existing.id, changed: false }
        memoryUpdate.run(input.kind, input.content, input.agentType ?? null, now(), existing.id)
        return { id: existing.id, changed: true }
      }
      const scope = input.scope ?? (input.projectId != null ? 'project' : 'global')
      const id = Number(
        (memoryIns.run(
          input.kind,
          input.content,
          input.source,
          now(),
          'local',
          input.agentType ?? null,
          input.status ?? 'active',
          input.tags && input.tags.length > 0 ? JSON.stringify(input.tags.slice(0, 10)) : null,
          input.projectId ?? null,
          scope,
          input.locked ? 1 : 0
        ) as {
          lastInsertRowid: number | bigint
        }).lastInsertRowid
      )
      return { id, changed: true }
    },

    // agent-written memories are individual facts — insert always, never
    // overwrite by source (unlike file-backed memories which replace by source)
    addMemory(input): { id: number } {
      const MEMORY_CAP = 4000
      const content =
        input.content.length > MEMORY_CAP
          ? `${input.content.slice(0, MEMORY_CAP)}\n…[truncated]`
          : input.content
      const scope = input.scope ?? (input.projectId != null ? 'project' : 'global')
      const id = Number(
        (
          memoryIns.run(
            input.kind,
            content,
            input.source,
            now(),
            'local',
            input.agentType ?? null,
            input.status ?? 'active',
            input.tags && input.tags.length > 0 ? JSON.stringify(input.tags.slice(0, 10)) : null,
            input.projectId ?? null,
            scope,
            input.locked ? 1 : 0
          ) as { lastInsertRowid: number | bigint }
        ).lastInsertRowid
      )
      return { id }
    }
  }
}
