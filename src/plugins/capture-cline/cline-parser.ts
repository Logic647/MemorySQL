import fs from 'node:fs'
import path from 'node:path'
import type { RawMessage, RawSession } from '../../shared/types'

/**
 * Cline CLI(开源,cline/cline,3.x 基于 Cline SDK)会话目录(格式按
 * magpie 对真实文件的实证解析 internal/sessions/cline.go 还原):
 *
 *   <sessions>/<session-id>/<session-id>.json           manifest(标题/cwd/起始)
 *   <sessions>/<session-id>/<session-id>.messages.json  消息(整文件重写)
 *   <sessions>/<session-id>/<agent-id>.messages.json    子代理消息(在父目录里)
 *
 * sessions 目录解析链:CLINE_SESSION_DATA_DIR → <CLINE_DATA_DIR>/sessions
 *   → <CLINE_DIR>/data/sessions → ~/.cline/data/sessions
 *
 * manifest:{session_id, started_at(RFC3339), cwd, prompt, metadata:{title, fork:{forkedAt}}}
 * messages.json:{messages:[{role, content(Anthropic 风格块), ts(毫秒),
 *   modelInfo:{id}, metrics:{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}}]}
 */

export interface ClineManifest {
  session_id?: string
  started_at?: string
  cwd?: string
  prompt?: string
  metadata?: { title?: string; fork?: { forkedAt?: string } }
}

interface ClineMessage {
  role?: string
  content?: unknown
  ts?: number
  modelInfo?: { id?: string }
}

interface ContentBlock {
  type?: string
  text?: string
  name?: string
  input?: unknown
  content?: unknown
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const b of content as ContentBlock[]) {
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) parts.push(b.text)
  }
  return parts.join('\n')
}

function blocksToRaw(content: unknown, ts: number | undefined, role: 'user' | 'assistant'): RawMessage[] {
  const out: RawMessage[] = []
  const asText = blockText(content)
  if (asText.trim()) out.push({ role, content: asText, ts })
  if (!Array.isArray(content)) return out
  for (const b of content as ContentBlock[]) {
    if (b.type === 'tool_use' && typeof b.name === 'string' && b.name) {
      out.push({ role: 'tool', toolName: b.name, content: JSON.stringify(b.input ?? {}), ts })
    } else if (b.type === 'tool_result') {
      const inner = b.content
      let reply = ''
      if (typeof inner === 'string') reply = inner
      else if (Array.isArray(inner)) {
        reply = (inner as ContentBlock[])
          .map((c) => (c.type === 'text' && typeof c.text === 'string' ? c.text : ''))
          .filter(Boolean)
          .join('\n')
      }
      if (reply.trim()) out.push({ role: 'tool', content: reply, ts })
    }
  }
  return out
}

function secondsOf(ms: unknown): number | undefined {
  return typeof ms === 'number' && Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined
}

/**
 * 解析一个 Cline 会话目录(目录名 = 会话 id)。
 * main = 会话本体;目录里其他 *.messages.json 是子代理(父 externalId = 目录名)。
 * fork(metadata.fork.forkedAt):消息从 forkedAt 起才是自己的,之前的拷贝段跳过。
 */
export function parseClineSessionDir(dir: string): RawSession[] {
  const id = path.basename(dir)
  let manifest: ClineManifest = {}
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf-8')) as ClineManifest
  } catch {
    /* manifest 缺失时按空处理 */
  }
  const out: RawSession[] = []

  let files: fs.Dirent[]
  try {
    files = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  const forkedAt = manifest.metadata?.fork?.forkedAt
  const sinceMs = forkedAt ? Date.parse(forkedAt) : NaN

  for (const entry of files) {
    if (!entry.isFile() || !entry.name.endsWith('.messages.json')) continue
    const main = entry.name === `${id}.messages.json`
    let doc: { messages?: ClineMessage[] }
    try {
      doc = JSON.parse(fs.readFileSync(path.join(dir, entry.name), 'utf-8')) as { messages?: ClineMessage[] }
    } catch {
      continue // 整文件重写途中被读到,下次增量再收
    }
    const messages: RawMessage[] = []
    let startedAt: number | undefined
    let endedAt: number | undefined
    for (const m of doc.messages ?? []) {
      const role = m.role
      if (role !== 'user' && role !== 'assistant') continue
      const ts = secondsOf(m.ts)
      if (sinceMs !== undefined && Number.isFinite(sinceMs) && (ts ?? 0) * 1000 < sinceMs) continue
      if (ts != null) {
        if (startedAt == null || ts < startedAt) startedAt = ts
        if (endedAt == null || ts > endedAt) endedAt = ts
      }
      const raw = blocksToRaw(m.content, ts, role)
      messages.push(...raw)
    }
    if (messages.length === 0) continue
    const title = main ? (manifest.metadata?.title?.trim() || undefined) : undefined
    const startMs = main && manifest.started_at ? Date.parse(manifest.started_at) : NaN
    out.push({
      externalId: main ? id : entry.name.replace(/\.messages\.json$/, ''),
      agentType: 'cline',
      cwd: main ? manifest.cwd || undefined : undefined,
      startedAt: secondsOf(startMs) ?? startedAt,
      endedAt: endedAt ?? startedAt,
      title,
      messages,
      rawPath: path.join(dir, entry.name),
      ...(main ? {} : { isSubagent: true, parentExternalId: id })
    })
  }
  return out
}

/** cline 的 sessions 目录(按环境变量解析链) */
export function clineSessionsDir(env: NodeJS.ProcessEnv = process.env, home = ''): string {
  const sessionDir = env.CLINE_SESSION_DATA_DIR?.trim()
  if (sessionDir) return sessionDir
  const dataDir = env.CLINE_DATA_DIR?.trim()
  if (dataDir) return path.join(dataDir, 'sessions')
  const dir = env.CLINE_DIR?.trim() || home
  return path.join(dir, '.cline', 'data', 'sessions')
}
