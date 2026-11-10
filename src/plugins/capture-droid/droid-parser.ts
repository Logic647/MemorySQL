import fs from 'node:fs'
import path from 'node:path'
import type { RawMessage, RawSession } from '../../shared/types'

/**
 * Droid(Factory,闭源)会话转录。格式按 magpie 对真实文件的实证解析
 * (yetone/magpie internal/sessions/droid.go)还原:
 *
 *   ~/.factory/sessions/<id>.jsonl               老会话直接在根下
 *   ~/.factory/sessions/<cwd-slug>/<id>.jsonl    新会话按工作目录分文件夹
 *   同名 <id>.settings.json                      模型/tokenUsage 运行总量
 *   (FACTORY_HOME_OVERRIDE 可覆盖根)
 *
 * 首行 = session_start 事件:{type:"session_start", id, title, cwd, lastCwd,
 *   parent(fork 来源), forkedAtMessageId, callingSessionId(子代理/`/btw` 的调用方)}。
 * 之后一行一事件;message 事件的 message:{role, content},content 是字符串或
 * Anthropic 风格块(text/tool_use)。时间:行内 ISO 时间戳字段(键名不保证唯一,
 * 常见 timestamp/ts/createdAt),取不到回落文件 mtime。
 * fork 会把源会话的消息连 id 一起拷到 forkedAtMessageId 为止 —— 拷贝段跳过。
 * 子代理:callingSessionId 非空 → isSubagent + parentExternalId。
 */

interface DroidStart {
  type?: string
  id?: string
  title?: string
  cwd?: string
  lastCwd?: string
  parent?: string
  forkedAtMessageId?: string
  callingSessionId?: string
}

interface DroidEvent {
  type?: string
  id?: string
  timestamp?: string
  ts?: unknown
  message?: { role?: string; content?: unknown }
}

interface ContentBlock {
  type?: string
  text?: string
  name?: string
  input?: unknown
}

/** 行内时间:优先 ISO 字符串,数字按 秒/毫秒 自适应;都取不到 undefined */
function eventTs(ev: DroidEvent, fileMtimeMs: number): number | undefined {
  if (typeof ev.timestamp === 'string' && ev.timestamp.trim()) {
    const ms = Date.parse(ev.timestamp)
    if (Number.isFinite(ms)) return Math.floor(ms / 1000)
  }
  if (typeof ev.ts === 'number' && Number.isFinite(ev.ts)) {
    return Math.floor(ev.ts > 1e11 ? ev.ts / 1000 : ev.ts)
  }
  if (Number.isFinite(fileMtimeMs) && fileMtimeMs > 0) return Math.floor(fileMtimeMs / 1000)
  return undefined
}

function blocksToRaw(
  content: unknown,
  ts: number | undefined,
  role: 'user' | 'assistant'
): RawMessage[] {
  const out: RawMessage[] = []
  if (typeof content === 'string') {
    if (content.trim()) out.push({ role, content, ts })
    return out
  }
  if (!Array.isArray(content)) return out
  let text = ''
  const flush = (): void => {
    if (text.trim()) {
      out.push({ role, content: text, ts })
      text = ''
    }
  }
  for (const b of content as ContentBlock[]) {
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
      text += (text ? '\n' : '') + b.text
    } else if (b.type === 'tool_use' && typeof b.name === 'string' && b.name) {
      flush()
      out.push({ role: 'tool', toolName: b.name, content: JSON.stringify(b.input ?? {}), ts })
    } else if (b.type === 'tool_result') {
      // tool_result 的 content 可能是字符串或块数组;归并文本作为工具回执
      const inner = (b as { content?: unknown }).content
      let reply = ''
      if (typeof inner === 'string') reply = inner
      else if (Array.isArray(inner)) {
        reply = (inner as ContentBlock[])
          .map((c) => (c.type === 'text' && typeof c.text === 'string' ? c.text : ''))
          .filter(Boolean)
          .join('\n')
      }
      if (reply.trim()) {
        flush()
        out.push({ role: 'tool', content: reply, ts })
      }
    }
  }
  flush()
  return out
}


/** 解析单个 droid 转录文件;非会话/半截文件返回 null */
export function parseDroidSession(file: string): RawSession | null {
  let raw: string
  let mtimeMs = 0
  try {
    raw = fs.readFileSync(file, 'utf-8')
    mtimeMs = fs.statSync(file).mtimeMs
  } catch {
    return null
  }
  const lines = raw.split('\n')
  let header: DroidStart | null = null
  const messages: RawMessage[] = []
  // fork 的拷贝段:到 forkedAtMessageId 为止(在 header 处一次性 arm,不重臂)
  let copying = false
  let startedAt: number | undefined
  let endedAt: number | undefined
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    let ev: DroidEvent
    try {
      ev = JSON.parse(t) as DroidEvent
    } catch {
      continue // 半行(写入中被读到)下次增量再收
    }
    if (!header && ev.type === 'session_start') {
      header = ev as DroidStart
      copying = header.forkedAtMessageId != null
      continue
    }
    if (copying) {
      if (ev.id && ev.id === header?.forkedAtMessageId) copying = false
      continue
    }
    if (ev.type !== 'message' || !ev.message) continue
    const role = ev.message.role
    if (role !== 'user' && role !== 'assistant') continue
    const ts = eventTs(ev, mtimeMs)
    if (ts != null) {
      if (startedAt == null || ts < startedAt) startedAt = ts
      if (endedAt == null || ts > endedAt) endedAt = ts
    }
    messages.push(...blocksToRaw(ev.message.content, ts, role))
  }
  if (!header || messages.length === 0) return null
  const id = header.id?.trim() || path.basename(file, '.jsonl')
  const calling = header.callingSessionId?.trim() || ''
  const title = header.title?.trim() && header.title.trim() !== 'New Session' ? header.title.trim() : undefined
  const cwd = (header.lastCwd?.trim() || header.cwd?.trim()) || undefined
  return {
    externalId: id,
    agentType: 'droid',
    cwd,
    startedAt: startedAt ?? (mtimeMs > 0 ? Math.floor(mtimeMs / 1000) : undefined),
    endedAt: endedAt ?? (mtimeMs > 0 ? Math.floor(mtimeMs / 1000) : undefined),
    title,
    messages,
    rawPath: file,
    ...(calling && calling !== id
      ? { isSubagent: true, parentExternalId: calling }
      : {})
  }
}
