import fs from 'node:fs'
import path from 'node:path'
import type { RawMessage, RawSession } from '../../shared/types'

/**
 * Pi 系(pi coding agent 与其 fork:omp / OmO)会话转录。格式按 magpie
 * 对真实文件的实证解析(internal/sessions/pi.go + omp.go)还原:
 *
 *   <agent-dir>/sessions/<cwd-slug>/<time>_<session-id>.jsonl   一个会话一个文件
 *   agent-dir:pi  = $PI_CODING_AGENT_DIR 否则 ~/.pi/agent
 *              omp = ~/.omp/agent(profiles:<~/.omp>/profiles/<name>/agent)
 *              omo = ~/.omo/agent(Pi fork)
 *   (PI_CODING_AGENT_SESSION_DIR / settings.json 的 sessionDir 可指单一平铺目录)
 *
 * 一行一个 entry:
 *   {type:"session", id, cwd, parentSession?(fork 来源), title?}
 *   {type:"session_info", name}           标题
 *   {type:"title_change", title}          omp 的改标题
 *   {type:"model_change", modelId|model}
 *   {type:"usage"|"model_usage", model, usage:{input,output,cacheRead,cacheWrite}}
 *   {type:"compaction"|"branch_summary", usage}
 *   {type:"message", message:{role, model?, content, ts/timestamp}}
 *     user content = 字符串或块数组(text);assistant content = 块数组
 *     ({type:"text",text} | {type:"toolCall", name, arguments})
 * fork 会话把源会话 entries 连时间全拷 —— header(parentSession)之后、
 * 早于 header 时间戳的 entry 是拷贝段,跳过。
 *
 * omp 子代理:与 .jsonl 同名的 artifacts 目录 <time>_<id>/<agent-id>.jsonl
 * (可再嵌套)—— 作为 isSubagent 会话入its,parentExternalId = 主会话 id。
 */

interface PiLine {
  type?: string
  id?: string
  cwd?: string
  parentSession?: string
  name?: string
  title?: string
  message?: {
    role?: string
    content?: unknown
    timestamp?: string
  }
}

interface PiPart {
  type?: string
  text?: string
  name?: string
  arguments?: unknown
}

/** 从一行 JSON 提取 ISO timestamp(与 magpie tsAt 同口径:只认 "timestamp":"…") */
function lineTsSec(line: string, mtimeMs: number): number | undefined {
  const i = line.indexOf('"timestamp":"')
  if (i >= 0) {
    const rest = line.slice(i + 13)
    const j = rest.indexOf('"')
    if (j >= 0 && j <= 40) {
      const ms = Date.parse(rest.slice(0, j))
      if (Number.isFinite(ms)) return Math.floor(ms / 1000)
    }
  }
  return mtimeMs > 0 ? Math.floor(mtimeMs / 1000) : undefined
}

function contentToRaw(content: unknown, ts: number | undefined, role: 'user' | 'assistant'): RawMessage[] {
  const out: RawMessage[] = []
  let text = ''
  const flush = (): void => {
    if (text.trim()) {
      out.push({ role, content: text, ts })
      text = ''
    }
  }
  if (typeof content === 'string') {
    if (content.trim()) out.push({ role, content, ts })
    return out
  }
  if (!Array.isArray(content)) return out
  for (const p of content as PiPart[]) {
    if (p.type === 'text' && typeof p.text === 'string' && p.text.trim()) {
      text += (text ? '\n' : '') + p.text
    } else if (p.type === 'toolCall' && typeof p.name === 'string' && p.name) {
      flush()
      out.push({ role: 'tool', toolName: p.name, content: JSON.stringify(p.arguments ?? {}), ts })
    } else if (p.type === 'toolResult') {
      // 工具回执:content 字符串或块数组;保留文本作工具回执
      const inner = (p as { content?: unknown }).content
      let reply = ''
      if (typeof inner === 'string') reply = inner
      else if (Array.isArray(inner)) {
        reply = (inner as PiPart[])
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

/** 解析单个 pi 形状转录文件;agentType 由调用方给(pi/omp/omo) */
export function parsePiSessionFile(file: string, agentType: string): RawSession | null {
  let raw: string
  let mtimeMs = 0
  try {
    raw = fs.readFileSync(file, 'utf-8')
    mtimeMs = fs.statSync(file).mtimeMs
  } catch {
    return null
  }
  const lines = raw.split('\n')
  let header: PiLine | null = null
  let headerTs: number | undefined
  const messages: RawMessage[] = []
  let startedAt: number | undefined
  let endedAt: number | undefined
  let title: string | undefined
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    const ts = lineTsSec(t, mtimeMs)
    let entry: PiLine
    try {
      entry = JSON.parse(t) as PiLine
    } catch {
      continue // 半行,下次增量再收
    }
    if (!header && entry.type === 'session') {
      header = entry
      headerTs = ts
      if (entry.title?.trim()) title = entry.title.trim()
      continue
    }
    // fork 的拷贝段:header 之后、早于 header 落笔时间的 entry 都是源会话的
    if (header?.parentSession && headerTs != null && ts != null && ts < headerTs) continue
    if (entry.type === 'session_info' && entry.name?.trim()) {
      title = entry.name.trim()
      continue
    }
    if (entry.type === 'title_change' && entry.title?.trim()) {
      title = entry.title.trim()
      continue
    }
    if (entry.type !== 'message' || !entry.message) continue
    const role = entry.message.role
    if (role !== 'user' && role !== 'assistant') continue
    if (ts != null) {
      if (startedAt == null || ts < startedAt) startedAt = ts
      if (endedAt == null || ts > endedAt) endedAt = ts
    }
    messages.push(...contentToRaw(entry.message.content, ts, role))
  }
  if (!header || messages.length === 0) return null
  return {
    externalId: header.id?.trim() || path.basename(file, '.jsonl').split('_').pop() || path.basename(file),
    agentType,
    cwd: header.cwd?.trim() || undefined,
    startedAt: startedAt ?? headerTs,
    endedAt: endedAt ?? startedAt ?? headerTs,
    title,
    messages,
    rawPath: file
  }
}

/** 文件名 <time>_<id>.jsonl → 取下划线后的 id;不合式的返回 null */
export function piSessionIdOf(file: string): string | null {
  const name = path.basename(file, '.jsonl')
  const i = name.indexOf('_')
  if (i <= 0 || i === name.length - 1) return null
  return name.slice(i + 1)
}

/** 列出一个 agent 根下的会话文件(含平铺目录与 cwd 分层两代) */
export function listPiSessionFiles(roots: string[]): string[] {
  const out: string[] = []
  for (const root of roots) {
    // sessions/<cwd>/<file>.jsonl 与 sessions/<file>.jsonl(用户自指目录)
    for (const pattern of [path.join(root, 'sessions', '*', '*.jsonl'), path.join(root, 'sessions', '*.jsonl'), path.join(root, '*.jsonl')]) {
      let matches: string[]
      try {
        matches = fs.globSync(pattern)
      } catch {
        continue
      }
      out.push(...matches)
    }
  }
  return [...new Set(out)]
}

/**
 * omp 的 artifacts 子代理:与 .jsonl 同名的目录 <time>_<id>/<agent>.jsonl。
 * 返回 isSubagent 会话,parentExternalId = 主会话 id(跳过嵌套层之外的
 * btw-history 等)。主文件本身不在这里解析。
 */
export function parseOmpArtifacts(file: string, agentType: string): RawSession[] {
  const dir = path.basename(file, '.jsonl')
  const artifactDir = path.join(path.dirname(file), dir)
  const out: RawSession[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(artifactDir, { withFileTypes: true })
  } catch {
    return out
  }
  const parentId = piSessionIdOf(file)
  if (!parentId) return out
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue
    try {
      const s = parsePiSessionFile(path.join(artifactDir, e.name), agentType)
      if (!s) continue
      out.push({ ...s, isSubagent: true, parentExternalId: parentId })
    } catch {
      continue
    }
  }
  return out
}
