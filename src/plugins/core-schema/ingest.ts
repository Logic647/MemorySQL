import crypto from 'node:crypto'
import path from 'node:path'
import type Database from 'better-sqlite3'
import type { RawSession } from '../../shared/types'
import type { SummarizerProvider } from '../../main/core/plugin-host'

const CONTENT_CAP = 100_000

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
  upsertMemory(input: { kind: string; content: string; source: string; agentType?: string; status?: string }): { id: number; changed: boolean }
  addMemory(input: { kind: string; content: string; source: string; agentType?: string; status?: string }): { id: number }
}

export interface IngestDeps {
  sqlite: Database.Database
  getSummarizer: () => SummarizerProvider | null
  onIngest: (sessionIds: number[]) => void
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
  const stmtSessionFind = sqlite.prepare(
    'SELECT id, content_hash FROM sessions WHERE agent_type = ? AND external_id = ?'
  )
  const stmtSessionIns = sqlite.prepare(`
    INSERT INTO sessions (agent_type, external_id, project_id, cwd, started_at, ended_at,
                          title, summary, raw_path, content_hash, message_count, tool_call_count,
                          updated_at, device_id)
    VALUES (@agent_type, @external_id, @project_id, @cwd, @started_at, @ended_at,
            @title, @summary, @raw_path, @content_hash, @message_count, @tool_call_count,
            @updated_at, @device_id)
  `)
  const stmtSessionUpdate = sqlite.prepare(`
    UPDATE sessions SET project_id = @project_id, cwd = @cwd, started_at = @started_at,
      ended_at = @ended_at, title = @title, summary = @summary, content_hash = @content_hash,
      message_count = @message_count, tool_call_count = @tool_call_count, updated_at = @updated_at
    WHERE id = @id
  `)
  const stmtMsgIds = sqlite.prepare('SELECT id FROM session_messages WHERE session_id = ?')
  const stmtMsgDel = sqlite.prepare('DELETE FROM session_messages WHERE session_id = ?')
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

  const ensureProject = (cwd?: string): number | null => {
    if (!cwd) return null
    const existing = stmtProjectFind.get(cwd) as { id: number } | undefined
    if (existing) return existing.id
    const name = path.basename(cwd) || cwd
    return Number(
      (stmtProjectIns.run(cwd, name, now(), 'local') as { lastInsertRowid: number | bigint })
        .lastInsertRowid
    )
  }

  const summarizeSession = async (
    s: RawSession
  ): Promise<{ title: string; summary: string }> => {
    const provider = getSummarizer()
    if (provider) {
      try {
        const out = await provider.summarize({
          agentType: s.agentType,
          cwd: s.cwd,
          messages: s.messages,
          currentTitle: s.title
        })
        if (out) return out
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
      | { id: number; content_hash: string }
      | undefined
    if (existing && existing.content_hash === contentHash) return { outcome: 'skipped' }

    const projectId = ensureProject(s.cwd)
    const { title, summary: summaryText } = summary
    const toolCalls = s.messages.filter((m) => m.role === 'tool').length
    const counts = {
      message_count: s.messages.length,
      tool_call_count: toolCalls
    }

    if (existing) {
      const sessionId = existing.id
      // drop old messages + their FTS rows before rewriting
      const oldIds = (stmtMsgIds.all(sessionId) as Array<{ id: number }>).map((r) => r.id)
      const tx = sqlite.transaction(() => {
        for (const mid of oldIds) stmtFtsMsgDel.run(mid)
        stmtMsgDel.run(sessionId)
        stmtSessionUpdate.run({
          id: sessionId,
          project_id: projectId,
          cwd: s.cwd ?? null,
          started_at: s.startedAt ?? null,
          ended_at: s.endedAt ?? null,
          title,
          summary: summaryText,
          content_hash: contentHash,
          ...counts,
          updated_at: now()
        })
        insertMessages(sessionId, s)
        stmtFtsSessionDel.run(sessionId)
        stmtFtsSessionIns.run(sessionId, title, summaryText)
      })
      tx()
      return { outcome: 'updated', id: sessionId }
    }

    let newId = 0
    const tx = sqlite.transaction(() => {
      newId = Number(
        (stmtSessionIns.run({
          agent_type: s.agentType,
          external_id: s.externalId,
          project_id: projectId,
          cwd: s.cwd ?? null,
          started_at: s.startedAt ?? null,
          ended_at: s.endedAt ?? null,
          title,
          summary: summaryText,
          raw_path: s.rawPath ?? null,
          content_hash: contentHash,
          ...counts,
          updated_at: now(),
          device_id: 'local'
        }) as { lastInsertRowid: number | bigint }).lastInsertRowid
      )
      insertMessages(newId, s)
      stmtFtsSessionIns.run(newId, title, summaryText)
    })
    tx()
    return { outcome: 'imported', id: newId }
  }

  function insertMessages(sessionId: number, s: RawSession): void {
    s.messages.forEach((m, seq) => {
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
    })
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
    'INSERT INTO memories (kind, content, source, updated_at, device_id, agent_type, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
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
      const id = Number(
        (memoryIns.run(input.kind, input.content, input.source, now(), 'local', input.agentType ?? null, input.status ?? 'active') as {
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
      const id = Number(
        (memoryIns.run(input.kind, content, input.source, now(), 'local', input.agentType ?? null, input.status ?? 'active') as {
          lastInsertRowid: number | bigint
        }).lastInsertRowid
      )
      return { id }
    }
  }
}
