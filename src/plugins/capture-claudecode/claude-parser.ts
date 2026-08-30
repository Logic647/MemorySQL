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

export function parseClaudeJsonl(filePath: string, text: string): RawSession | null {
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
    agentType: 'claudecode',
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

import fs from 'node:fs'
