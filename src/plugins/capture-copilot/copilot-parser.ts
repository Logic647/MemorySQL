import fs from 'node:fs'
import path from 'node:path'
import type { RawMessage, RawSession } from '../../shared/types'

/**
 * GitHub Copilot CLI(闭源,npm @github/copilot + 原生二进制)—— 会话目录。
 * **2026-11-10 在 NAS 上真机实测**(1.0.108,已登录):目录与事件形状如下。
 *
 *   ~/.copilot/session-state/<session-uuid>/
 *     workspace.yaml   id / cwd / name(= 首个 prompt,作标题)/ created_at / updated_at
 *     events.jsonl     事件流,一行一事件:{type, data, id, timestamp, parentId}
 *     checkpoints/index.md, rewind-file-snapshots/tracking.json
 *   ~/.copilot/session-store.db   SQLite **派生索引**(sessions/turns/…), 正文以 events.jsonl 为准
 *
 * events.jsonl 的 type(实测用例覆盖到的):
 *   session.start          data.sessionId / startTime / context.cwd / copilotVersion
 *   user.message           data.content
 *   assistant.message      data.content / model / toolRequests[]
 *   tool.execution_start   data.toolName / arguments / toolCallId
 *   tool.execution_complete data.toolCallId / success / result.content
 *   session.usage_record   data.usage{inputTokens, outputTokens, cacheReadTokens, model}
 *   instruction.update / system.message / assistant.turn_start|end / session.shutdown
 *
 * 未登录时也会建 session-state/<uuid>/workspace.yaml(只有元数据),故缺
 * events.jsonl 的目录按空会话跳过。
 */

interface CopilotWorkspace {
  id?: string
  cwd?: string
  name?: string
  created_at?: string
  updated_at?: string
  user_named?: string
}

/** workspace.yaml 的极简解析(一层 key: value,值可能带引号) */
export function parseCopilotWorkspace(text: string): CopilotWorkspace {
  const out: CopilotWorkspace = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (!m) continue
    const key = m[1]
    let val = m[2].trim()
    if (
      (val.startsWith("'") && val.endsWith("'")) ||
      (val.startsWith('"') && val.endsWith('"'))
    ) {
      val = val.slice(1, -1)
    }
    if (!val) continue
    if (key in out) continue
    ;(out as Record<string, string>)[key] = val
  }
  return out
}

function isoSeconds(v: unknown): number | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined
}

interface CopilotEvent {
  type?: string
  timestamp?: string
  data?: Record<string, unknown>
}

/** tool.execution_complete 的 result.content 取文本(可能是字符串或块数组) */
function toolResultText(result: unknown): string {
  if (typeof result === 'string') return result
  if (!result || typeof result !== 'object') return ''
  const r = result as { content?: unknown }
  if (typeof r.content === 'string') return r.content
  if (Array.isArray(r.content)) {
    return (r.content as Array<{ type?: string; text?: string }>)
      .map((c) => (c.type === 'text' && typeof c.text === 'string' ? c.text : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/** 解析一个 Copilot 会话目录;没有 events.jsonl / 没有消息 → null */
export function parseCopilotSessionDir(dir: string): RawSession | null {
  let ws: CopilotWorkspace = {}
  try {
    ws = parseCopilotWorkspace(fs.readFileSync(path.join(dir, 'workspace.yaml'), 'utf-8'))
  } catch {
    /* 缺 workspace.yaml 时按 events 兜底 */
  }
  let raw = ''
  try {
    raw = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf-8')
  } catch {
    return null // 未登录只建目录,没有事件流
  }

  const messages: RawMessage[] = []
  let startedAt = isoSeconds(ws.created_at)
  let endedAt = isoSeconds(ws.updated_at)
  let cwd = ws.cwd?.trim() || undefined
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    let ev: CopilotEvent
    try {
      ev = JSON.parse(t) as CopilotEvent
    } catch {
      continue // 半行(写入中被读到)
    }
    const ts = isoSeconds(ev.timestamp)
    if (ts != null) {
      if (startedAt == null || ts < startedAt) startedAt = ts
      if (endedAt == null || ts > endedAt) endedAt = ts
    }
    const d = ev.data ?? {}
    switch (ev.type) {
      case 'session.start': {
        const at = isoSeconds(d.startTime)
        if (at != null && (startedAt == null || at < startedAt)) startedAt = at
        const ctx = d.context as { cwd?: unknown } | undefined
        if (!cwd && typeof ctx?.cwd === 'string' && ctx.cwd.trim()) cwd = ctx.cwd.trim()
        break
      }
      case 'user.message': {
        const content = typeof d.content === 'string' ? d.content : ''
        if (content.trim()) messages.push({ role: 'user', content, ts })
        break
      }
      case 'assistant.message': {
        const content = typeof d.content === 'string' ? d.content : ''
        if (content.trim()) messages.push({ role: 'assistant', content, ts })
        break
      }
      case 'tool.execution_start': {
        const name = typeof d.toolName === 'string' ? d.toolName : undefined
        if (name) {
          messages.push({
            role: 'tool',
            toolName: name,
            content: JSON.stringify(d.arguments ?? {}),
            ts
          })
        }
        break
      }
      case 'tool.execution_complete': {
        const text = toolResultText(d.result)
        if (text.trim()) messages.push({ role: 'tool', content: text, ts })
        break
      }
      default:
        break // usage / turn 标记 / instructions 不进时间线
    }
  }
  if (messages.length === 0) return null

  const title = ws.name?.trim() && ws.name.trim() !== 'New Session' ? ws.name.trim() : undefined
  return {
    externalId: ws.id?.trim() || path.basename(dir),
    agentType: 'copilot',
    cwd,
    startedAt,
    endedAt: endedAt ?? startedAt,
    title,
    messages,
    rawPath: path.join(dir, 'events.jsonl')
  }
}
