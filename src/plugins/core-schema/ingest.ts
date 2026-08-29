import crypto from 'node:crypto'
import path from 'node:path'
import type Database from 'better-sqlite3'
import type { RawSession } from '../../shared/types'
import type { SummarizerProvider } from '../../main/core/plugin-host'

const CONTENT_CAP = 100_000

export interface IngestResult {
  scanned: number
  imported: number
  updated: number
  skipped: number
  sessionIds: number[]
}

export interface IngestService {
  ingestSessions(sessions: RawSession[]): IngestResult
  upsertMemory(input: { kind: string; content: string; source: string }): { id: number; changed: boolean }
}

export interface IngestDeps {
  sqlite: Database.Database
  getSummarizer: () => SummarizerProvider | null
  onIngest: () => void
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
    h.update(m.content)
    h.update('\0')
  }
  return h.digest('hex')
}

function cap(text: string): string {
  return text.length > CONTENT_CAP ? `${text.slice(0, CONTENT_CAP)}\n…[truncated]` : text
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

  const summarize = (s: RawSession): { title: string; summary: string } => {
    const provider = getSummarizer()
    if (provider) {
      try {
        const out = provider.summarize({
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

  const ingestOne = (s: RawSession): { outcome: 'imported' | 'updated' | 'skipped'; id?: number } => {
    const contentHash = hashSession(s)
    const existing = stmtSessionFind.get(s.agentType, s.externalId) as
      | { id: number; content_hash: string }
      | undefined
    if (existing && existing.content_hash === contentHash) return { outcome: 'skipped' }

    const projectId = ensureProject(s.cwd)
    const { title, summary } = summarize(s)
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
          summary,
          content_hash: contentHash,
          ...counts,
          updated_at: now()
        })
        insertMessages(sessionId, s)
        stmtFtsSessionDel.run(sessionId)
        stmtFtsSessionIns.run(sessionId, title, summary)
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
          summary,
          raw_path: s.rawPath ?? null,
          content_hash: contentHash,
          ...counts,
          updated_at: now(),
          device_id: 'local'
        }) as { lastInsertRowid: number | bigint }).lastInsertRowid
      )
      insertMessages(newId, s)
      stmtFtsSessionIns.run(newId, title, summary)
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

  const ingestTx = sqlite.transaction((sessions: RawSession[]) => {
    const result: IngestResult = { scanned: 0, imported: 0, updated: 0, skipped: 0, sessionIds: [] }
    for (const s of sessions) {
      result.scanned++
      const { outcome, id } = ingestOne(s)
      if (outcome !== 'skipped' && id !== undefined) result.sessionIds.push(id)
      if (outcome === 'imported') result.imported++
      else if (outcome === 'updated') result.updated++
      else result.skipped++
    }
    return result
  })

  const memoryFind = sqlite.prepare('SELECT id, content FROM memories WHERE source = ? AND deleted = 0')
  const memoryIns = sqlite.prepare(
    'INSERT INTO memories (kind, content, source, updated_at, device_id) VALUES (?, ?, ?, ?, ?)'
  )
  const memoryUpdate = sqlite.prepare(
    'UPDATE memories SET kind = ?, content = ?, updated_at = ? WHERE id = ?'
  )

  return {
    ingestSessions(sessions: RawSession[]): IngestResult {
      const res = ingestTx(sessions)
      if (res.imported + res.updated > 0) onIngest()
      return res
    },

    upsertMemory(input): { id: number; changed: boolean } {
      const existing = memoryFind.get(input.source) as { id: number; content: string } | undefined
      if (existing) {
        if (existing.content === input.content) return { id: existing.id, changed: false }
        memoryUpdate.run(input.kind, input.content, now(), existing.id)
        return { id: existing.id, changed: true }
      }
      const id = Number(
        (memoryIns.run(input.kind, input.content, input.source, now(), 'local') as {
          lastInsertRowid: number | bigint
        }).lastInsertRowid
      )
      return { id, changed: true }
    }
  }
}
