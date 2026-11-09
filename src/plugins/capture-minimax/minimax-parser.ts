import fs from 'node:fs'
import path from 'node:path'
import type { RawMessage, RawSession } from '../../shared/types'

/**
 * MiniMax Code(MiniMax,闭源,bin mcode)会话目录。格式按 magpie 对真实
 * 文件的实证解析(internal/sessions/calls_minimax.go,对 @minimax-ai/code
 * 0.6.8 sandbox 实测)还原:
 *
 *   <data>/v2/sessions/<yyyy>/<mm>/<dd>/<hh-mm-ss-ms>-session_<base64(id)>/
 *     messages.jsonl   一行一条:{message_id, turn_id,
 *                       message:{role, model?, provider?, usage?, timestamp(毫秒), content?}}
 *     history-catalog.json 等旁文件可能登记别的代(messages*.jsonl)
 *
 * data 根:$MINIMAX_DATA_DIR 否则 ~/.minimax。会话 id = 文件夹名
 * `-session_` 之后的 base64(尝试 rawurl/url/rawstd/std 四种)。
 * 标题/cwd:官方读取器未涉及 —— 元数据若有落盘,从目录内 *.json 兜底探测。
 */

function decodeBase64Id(dirName: string): string {
  const i = dirName.indexOf('-session_')
  if (i < 0) return dirName
  const b64 = dirName.slice(i + '-session_'.length)
  for (const decode of [
    (s: string) => Buffer.from(s, 'base64url').toString('utf-8'),
    (s: string) => Buffer.from(s, 'base64').toString('utf-8')
  ]) {
    try {
      const out = decode(b64)
      if (out && /^[\x20-\x7e]+$/.test(out)) return out
    } catch {
      continue
    }
  }
  return dirName
}

interface MinimaxLine {
  message_id?: string
  message?: {
    role?: string
    model?: string
    content?: unknown
    timestamp?: number
  }
}

function secondsOf(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.floor(v / 1000) : undefined
}

function textOf(content: unknown): { text: string; blocks: unknown[] | null } {
  if (typeof content === 'string') return { text: content, blocks: null }
  if (Array.isArray(content)) return { text: '', blocks: content }
  return { text: '', blocks: null }
}

function contentToRaw(content: unknown, role: 'user' | 'assistant', ts: number | undefined): RawMessage[] {
  const out: RawMessage[] = []
  const { text, blocks } = textOf(content)
  if (text.trim()) {
    out.push({ role, content: text, ts })
    return out
  }
  if (!blocks) return out
  let acc = ''
  const flush = (): void => {
    if (acc.trim()) {
      out.push({ role, content: acc, ts })
      acc = ''
    }
  }
  for (const b of blocks as Array<{ type?: string; text?: string; name?: string; input?: unknown }>) {
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
      acc += (acc ? '\n' : '') + b.text
    } else if ((b.type === 'tool_use' || b.type === 'toolCall') && typeof b.name === 'string' && b.name) {
      flush()
      out.push({ role: 'tool', toolName: b.name, content: JSON.stringify(b.input ?? {}), ts })
    }
  }
  flush()
  return out
}

/** 解析一个 minimax 会话目录 */
export function parseMinimaxSessionDir(dir: string): RawSession | null {
  const jsonls = fs
    .readdirSync(dir)
    .filter((f) => f === 'messages.jsonl' || /^messages.*\.jsonl$/.test(f))
  if (jsonls.length === 0) return null
  const messages: RawMessage[] = []
  const seen = new Set<string>()
  let startedAt: number | undefined
  let endedAt: number | undefined
  for (const name of jsonls) {
    let raw = ''
    try {
      raw = fs.readFileSync(path.join(dir, name), 'utf-8')
    } catch {
      continue
    }
    for (const line of raw.split('\n')) {
      const t = line.trim()
      if (!t) continue
      let ev: MinimaxLine
      try {
        ev = JSON.parse(t) as MinimaxLine
      } catch {
        continue
      }
      const m = ev.message
      if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue
      // 同一 message_id 在多代里重复 —— 只收第一次
      const mid = ev.message_id?.trim()
      if (mid) {
        if (seen.has(mid)) continue
        seen.add(mid)
      }
      const ts = secondsOf(m.timestamp)
      if (ts != null) {
        if (startedAt == null || ts < startedAt) startedAt = ts
        if (endedAt == null || ts > endedAt) endedAt = ts
      }
      messages.push(...contentToRaw(m.content, m.role, ts))
    }
  }
  if (messages.length === 0) return null

  // 元数据兜底:目录内的其他 *.json(meta/session 信息)探测 title/cwd
  let title: string | undefined
  let cwd: string | undefined
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json') || f === 'history-catalog.json' || f.startsWith('messages')) continue
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as Record<string, unknown>
      const cand = (j as { title?: unknown; name?: unknown; cwd?: unknown; working_dir?: unknown })
      if (!title && typeof cand.title === 'string' && cand.title.trim()) title = cand.title.trim()
      else if (!title && typeof cand.name === 'string' && cand.name.trim()) title = cand.name.trim()
      if (!cwd && typeof cand.cwd === 'string' && cand.cwd.trim()) cwd = cand.cwd.trim()
      else if (!cwd && typeof cand.working_dir === 'string' && cand.working_dir.trim()) cwd = cand.working_dir.trim()
    } catch {
      continue
    }
  }

  const dirName = path.basename(dir)
  return {
    externalId: decodeBase64Id(dirName),
    agentType: 'minimax',
    cwd,
    startedAt: startedAt ?? undefined,
    endedAt: endedAt ?? startedAt,
    title,
    messages,
    rawPath: path.join(dir, 'messages.jsonl')
  }
}
