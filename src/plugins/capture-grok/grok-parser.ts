import fs from 'node:fs'
import path from 'node:path'
import type { RawMessage, RawSession } from '../../shared/types'

/**
 * Grok Build(xAI,闭源)会话目录。格式按 magpie 对真实文件的实证解析
 * (internal/sessions/grok.go)还原:
 *
 *   ~/.grok/sessions/<urlencode(cwd)>/<session-id>/
 *     summary.json   {info:{id,cwd}, created_at, generated_title, session_summary,
 *                     current_model_id, parent_session_id, session_kind}
 *     updates.jsonl  事件一行一条,行内 timestamp(秒)
 *     subagents/<child>.json               子代理登记(标题用)
 *   (GROK_HOME 可覆盖根)
 *
 * session_kind 以 "subagent" 开头 = 子代理会话(parent_session_id 指调用方)。
 * events 里 assistant 回复与 tool_call(update 带进度 tool_call_update)在
 * updates.jsonl;文本块在 content。
 */

interface GrokSummary {
  info?: { id?: string; cwd?: string }
  created_at?: string
  generated_title?: string
  session_summary?: string
  parent_session_id?: string
  session_kind?: string
}

interface GrokUpdate {
  timestamp?: number
  params?: {
    update?: {
      sessionUpdate?: string
      content?: { type?: string; text?: string } | unknown
      _meta?: { hostTurn?: boolean; 'x.ai/tool'?: { name?: string } }
    }
  }
  message?: { role?: string; content?: unknown }
  [k: string]: unknown
}

function secondsOf(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.floor(v > 1e11 ? v / 1000 : v)
  if (typeof v === 'string' && v.trim()) {
    const ms = Date.parse(v)
    if (Number.isFinite(ms)) return Math.floor(ms / 1000)
  }
  return undefined
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return (content as Array<{ type?: string; text?: string }>)
      .map((c) => (c.type === 'text' && typeof c.text === 'string' ? c.text : ''))
      .filter(Boolean)
      .join('\n')
  }
  if (content && typeof content === 'object') {
    const c = content as { type?: string; text?: string }
    if (c.type === 'text' && typeof c.text === 'string') return c.text
  }
  return ''
}

/** 解析一个 grok 会话目录(summary.json + updates.jsonl) */
export function parseGrokSessionDir(dir: string): RawSession | null {
  let summary: GrokSummary = {}
  try {
    summary = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf-8')) as GrokSummary
  } catch {
    /* summary 缺失时按 events 兜底 */
  }
  let raw = ''
  let mtimeMs = 0
  try {
    raw = fs.readFileSync(path.join(dir, 'updates.jsonl'), 'utf-8')
    mtimeMs = fs.statSync(path.join(dir, 'updates.jsonl')).mtimeMs
  } catch {
    return null
  }
  const messages: RawMessage[] = []
  // fork / restore 出来的会话,开头是源会话更新的拷贝 —— 早于 created_at 的
  // update 不算它自己的(与 magpie 同口径;否则父会话内容会被重复导入)。
  const createdSec = secondsOf(summary.created_at)
  const copyCutoff = summary.parent_session_id?.trim() && createdSec != null ? createdSec : null
  let startedAt: number | undefined = copyCutoff ?? undefined
  let endedAt: number | undefined
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    let ev: GrokUpdate
    try {
      ev = JSON.parse(t) as GrokUpdate
    } catch {
      continue
    }
    const ts = secondsOf(ev.timestamp) ?? (mtimeMs > 0 ? Math.floor(mtimeMs / 1000) : undefined)
    if (copyCutoff != null && ts != null && ts < copyCutoff) continue // 源会话的拷贝段
    if (ts != null) {
      if (startedAt == null || ts < startedAt) startedAt = ts
      if (endedAt == null || ts > endedAt) endedAt = ts
    }
    const upd = ev.params?.update
    if (upd) {
      // ACP 风格流式块:同一轮的相邻 chunk 合并成一条消息
      if (upd.sessionUpdate === 'user_message_chunk' || upd.sessionUpdate === 'agent_message_chunk') {
        const role = upd.sessionUpdate === 'user_message_chunk' ? 'user' : 'assistant'
        const text = textOfContent(upd.content)
        if (text) {
          const last = messages[messages.length - 1]
          if (last && last.role === role) last.content += text
          else messages.push({ role, content: text, ts })
        }
      } else if (upd.sessionUpdate === 'tool_call') {
        const name = upd._meta?.['x.ai/tool']?.name
        if (name) messages.push({ role: 'tool', toolName: name, content: '{}', ts })
      }
    } else if (ev.message) {
      const role = ev.message.role
      if (role !== 'user' && role !== 'assistant') continue
      const text = textOfContent(ev.message.content)
      if (text.trim()) messages.push({ role, content: text, ts })
    }
  }
  for (const m of messages) if (typeof m.content === 'string' && !m.content.trim()) m.content = ''
  if (!messages.some((m) => m.content.trim())) return null
  const id = summary.info?.id?.trim() || path.basename(dir)
  const kind = summary.session_kind?.trim() ?? ''
  const isSubagent = kind.toLowerCase().startsWith('subagent')
  const parent = summary.parent_session_id?.trim() || ''
  const title = summary.generated_title?.trim() || summary.session_summary?.trim() || undefined
  return {
    externalId: id,
    agentType: 'grok',
    cwd: summary.info?.cwd?.trim() || undefined,
    startedAt: startedAt ?? secondsOf(summary.created_at),
    endedAt: endedAt ?? secondsOf(summary.created_at),
    title,
    messages,
    rawPath: path.join(dir, 'updates.jsonl'),
    ...(isSubagent && parent && parent !== id ? { isSubagent: true, parentExternalId: parent } : {})
  }
}
