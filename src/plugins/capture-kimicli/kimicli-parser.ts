import fs from 'node:fs'
import path from 'node:path'
import type { RawMessage, RawSession } from '../../shared/types'

/**
 * Kimi CLI (MoonshotAI/kimi-cli) session storage:
 *   ~/.kimi/sessions/<md5(workdir)>/<uuid>/context.jsonl   (current)
 *   ~/.kimi/sessions/<md5(workdir)>/<uuid>.jsonl           (legacy, auto-migrated)
 * Each context line is a kosong Message (Pydantic): { role, content, tool_calls? }.
 * content is a string or a list of parts — TextPart{text}, ThinkPart (skip),
 * ToolCall{id,name,arguments}. Roles starting with "_" are metadata records.
 * A sibling state.json carries { custom_title, archived, ... }.
 * context.jsonl has no per-record timestamps — file mtime is the session's
 * only reliable time anchor.
 */
interface KimiPart {
  text?: unknown
  type?: unknown
  thinking?: unknown
  thought?: unknown
  name?: unknown
  arguments?: unknown
}

interface KimiLine {
  role?: unknown
  content?: unknown
  tool_calls?: unknown
}

export interface KimiSessionRef {
  id: string
  contextFile: string
  stateFile?: string
  /** current layout: <hash>/<uuid>/context.jsonl; legacy: <hash>/<uuid>.jsonl */
  legacy: boolean
}

function isTexty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

export function parseKimiContext(text: string): RawMessage[] {
  const messages: RawMessage[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let entry: KimiLine
    try {
      entry = JSON.parse(trimmed) as KimiLine
    } catch {
      continue
    }
    const role = typeof entry.role === 'string' ? entry.role : ''
    // "_system_prompt" & friends are metadata records, not conversation turns
    if (!role || role.startsWith('_') || (role !== 'user' && role !== 'assistant')) continue

    let text = ''
    if (isTexty(entry.content)) {
      text = entry.content
    } else if (Array.isArray(entry.content)) {
      const texts: string[] = []
      for (const part of entry.content as KimiPart[]) {
        if (!part || typeof part !== 'object') continue
        if (isTexty(part.text)) texts.push(part.text)
        // thinking/thought parts and tool-call parts carry no turn text here
      }
      text = texts.join('')
    }
    if (text.trim()) messages.push({ role, content: text })

    // OpenAI-style tool calls (assistant asking for tools)
    if (Array.isArray(entry.tool_calls)) {
      for (const tc of entry.tool_calls as Array<Record<string, unknown>>) {
        if (!tc || typeof tc !== 'object') continue
        const fn = (tc.function ?? {}) as Record<string, unknown>
        const name = isTexty(tc.name) ? tc.name : isTexty(fn.name) ? fn.name : 'tool'
        const args = tc.arguments ?? fn.arguments
        messages.push({
          role: 'tool',
          toolName: name,
          content: args === undefined ? '' : JSON.stringify(args)
        })
      }
    }
  }
  return messages
}

export function findKimiSessions(sessionsRoot: string): KimiSessionRef[] {
  const out: KimiSessionRef[] = []
  let hashDirs: fs.Dirent[]
  try {
    hashDirs = fs.readdirSync(sessionsRoot, { withFileTypes: true })
  } catch {
    return out
  }
  for (const hashDir of hashDirs) {
    if (!hashDir.isDirectory()) continue
    const hashPath = path.join(sessionsRoot, hashDir.name)
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(hashPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        const contextFile = path.join(hashPath, e.name, 'context.jsonl')
        if (fs.existsSync(contextFile)) {
          out.push({
            id: e.name,
            contextFile,
            stateFile: path.join(hashPath, e.name, 'state.json'),
            legacy: false
          })
        }
      } else if (e.isFile() && e.name.endsWith('.jsonl')) {
        // legacy flat layout: <uuid>.jsonl directly under the work-dir hash
        out.push({
          id: path.basename(e.name, '.jsonl'),
          contextFile: path.join(hashPath, e.name),
          legacy: true
        })
      }
    }
  }
  return out
}

export function readKimiTitle(stateFile?: string): string | undefined {
  if (!stateFile) return undefined
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8')) as { custom_title?: unknown }
    return isTexty(state.custom_title) ? state.custom_title : undefined
  } catch {
    return undefined
  }
}

export function buildKimiSession(
  ref: KimiSessionRef,
  text: string,
  title?: string
): RawSession | null {
  const messages = parseKimiContext(text)
  if (messages.length === 0) return null
  let endedAt: number | undefined
  try {
    endedAt = Math.floor(fs.statSync(ref.contextFile).mtimeMs / 1000)
  } catch {
    /* no mtime — session without time anchor is still importable */
  }
  return {
    externalId: ref.id,
    agentType: 'kimicli',
    startedAt: endedAt,
    endedAt,
    title,
    messages,
    rawPath: ref.contextFile
  }
}
