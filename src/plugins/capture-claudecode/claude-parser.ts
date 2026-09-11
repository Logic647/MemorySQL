import fs from 'node:fs'
import path from 'node:path'
import type { RawMessage, RawSession } from '../../shared/types'

/**
 * Claude Code (~/.claude/projects/<project-slug>/*.jsonl). Each line:
 *   { type: 'user'|'assistant'|'summary'|'system'|…,
 *     message: { role, content: string | Array<{type:'text'|'tool_use'|'tool_result', …}> },
 *     timestamp: ISO, sessionId, cwd, isSidechain? }
 */
interface ClaudeLine {
  type?: string
  message?: { role?: string; content?: unknown }
  timestamp?: string
  sessionId?: string
  cwd?: string
  isSidechain?: boolean
}

function isoToEpoch(iso?: string): number | undefined {
  if (!iso) return undefined
  const t = Date.parse(iso)
  return Number.isNaN(t) ? undefined : Math.floor(t / 1000)
}

function contentToMessages(role: 'user' | 'assistant', content: unknown, ts?: number): RawMessage[] {
  const out: RawMessage[] = []
  if (typeof content === 'string') {
    if (content.trim()) out.push({ role, content, ts })
    return out
  }
  if (!Array.isArray(content)) return out
  for (const part of content as Array<{ type?: string; text?: string; name?: string; input?: unknown }>) {
    if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
      out.push({ role, content: part.text, ts })
    } else if (part.type === 'tool_use' && typeof part.name === 'string') {
      out.push({
        role: 'tool',
        toolName: part.name,
        content: JSON.stringify(part.input ?? {}),
        ts
      })
    }
    // tool_result blocks are ignored: the paired tool_use already carries context
  }
  return out
}

export function parseClaudeJsonl(
  filePath: string,
  text: string,
  agentType: RawSession['agentType'] = 'claudecode'
): RawSession | null {
  let externalId: string | undefined
  let cwd: string | undefined
  let startedAt: number | undefined
  let endedAt: number | undefined
  const messages: RawMessage[] = []

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let entry: ClaudeLine
    try {
      entry = JSON.parse(trimmed) as ClaudeLine
    } catch {
      continue
    }
    const ts = isoToEpoch(entry.timestamp)
    // sidechain (subagent) lines contribute neither messages nor timestamps
    if (!entry.isSidechain) {
      if (ts && (!endedAt || ts > endedAt)) endedAt = ts
      if (ts && (!startedAt || ts < startedAt)) startedAt = ts
      if (entry.sessionId && !externalId) externalId = entry.sessionId
      if (entry.cwd && !cwd) cwd = entry.cwd
    }

    if ((entry.type === 'user' || entry.type === 'assistant') && entry.message && !entry.isSidechain) {
      const role = entry.type === 'user' ? 'user' : 'assistant'
      messages.push(...contentToMessages(role, entry.message.content, ts))
    }
  }

  if (messages.length === 0) return null
  return {
    externalId: externalId ?? path.basename(filePath, '.jsonl'),
    agentType,
    cwd,
    startedAt: startedAt ?? endedAt,
    endedAt,
    messages,
    rawPath: filePath
  }
}

export function findClaudeFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full)
    }
  }
  walk(root)
  return out
}

function msToSec(ms: unknown): number | undefined {
  return typeof ms === 'number' && Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined
}

/**
 * Claude Desktop (Electron shell, data dir "Claude-3p") drives the bundled
 * claude.exe through the Agent SDK, so no transcript is ever written under
 * ~/.claude/projects — only this per-session metadata file survives. The
 * title/cwd/timestamps still make the conversation visible in the session
 * list, project grouping and search.
 */
interface DesktopMetaJson {
  sessionId?: string
  cliSessionId?: string
  cwd?: string
  title?: string
  createdAt?: number
  lastActivityAt?: number
}

export function parseDesktopMeta(
  filePath: string,
  text: string
): { session: RawSession; cliSessionId?: string } | null {
  let j: DesktopMetaJson
  try {
    j = JSON.parse(text) as DesktopMetaJson
  } catch {
    return null
  }
  if (!j.sessionId) return null
  const createdAt = msToSec(j.createdAt)
  const lastActivityAt = msToSec(j.lastActivityAt)
  const title = typeof j.title === 'string' && j.title.trim() ? j.title : undefined
  return {
    session: {
      externalId: `desktop:${j.sessionId}`,
      agentType: 'claudecode',
      cwd: j.cwd,
      startedAt: createdAt ?? lastActivityAt,
      endedAt: lastActivityAt ?? createdAt,
      title,
      messages: [],
      rawPath: filePath
    },
    cliSessionId: j.cliSessionId
  }
}

export function findDesktopMetaFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile() && e.name.startsWith('local_') && e.name.endsWith('.json')) out.push(full)
    }
  }
  walk(root)
  return out
}

/**
 * ~/.claude/history.jsonl logs every interactive prompt (user side only):
 *   { display, timestamp(ms), project, sessionId }
 * Grouped by sessionId into prompt-only sessions. Real transcripts, when
 * they exist, carry the assistant side and win over these via skipSessionIds.
 */
interface HistoryEntryJson {
  display?: unknown
  timestamp?: unknown
  project?: unknown
  sessionId?: unknown
}

export function parseHistoryJsonl(
  text: string,
  sourcePath: string,
  skipSessionIds: ReadonlySet<string> = new Set()
): RawSession[] {
  const groups = new Map<string, { messages: RawMessage[]; cwd?: string; startedAt?: number; endedAt?: number }>()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let e: HistoryEntryJson
    try {
      e = JSON.parse(trimmed) as HistoryEntryJson
    } catch {
      continue
    }
    const id = typeof e.sessionId === 'string' ? e.sessionId : ''
    const display = typeof e.display === 'string' ? e.display.trim() : ''
    if (!id || !display || skipSessionIds.has(id)) continue
    const ts = msToSec(e.timestamp)
    const cwd = typeof e.project === 'string' && e.project ? e.project : undefined
    const g = groups.get(id) ?? { messages: [], cwd, startedAt: ts, endedAt: ts }
    g.messages.push({ role: 'user', content: display, ts })
    if (cwd && !g.cwd) g.cwd = cwd
    if (ts !== undefined && (g.startedAt === undefined || ts < g.startedAt)) g.startedAt = ts
    if (ts !== undefined && (g.endedAt === undefined || ts > g.endedAt)) g.endedAt = ts
    groups.set(id, g)
  }
  const out: RawSession[] = []
  for (const [id, g] of groups) {
    out.push({
      externalId: `history:${id}`,
      agentType: 'claudecode',
      cwd: g.cwd,
      startedAt: g.startedAt,
      endedAt: g.endedAt,
      messages: g.messages,
      rawPath: sourcePath
    })
  }
  return out
}
