import fs from 'node:fs'
import path from 'node:path'
import type { RawMessage, RawSession } from '../../shared/types'
import { safeDir, walkWithin } from '../../main/core/safe-path.ts'

/**
 * Claude Code (~/.claude/projects/<project-slug>/*.jsonl). Each line:
 *   { type: 'user'|'assistant'|'summary'|'system'|…,
 *     message: { role, content: string | Array<{type:'text'|'tool_use'|'tool_result', …}> },
 *     timestamp: ISO, sessionId, cwd, isSidechain? }
 *
 * CodeBuddy Code ≥2.x(~/.codebuddy/projects)是**同目录布局的另一形态**
 * (2026-10-25 NAS 真机实测:文档调研版 parser 对真实数据解析 0 条,这是
 * capture-codebuddy 的首次真机校准):
 *   { type: 'message', role: 'user'|'assistant',
 *     content: [{type:'input_text'|'output_text', text}],
 *     timestamp: **毫秒 epoch**(非 ISO), sessionId, cwd }
 *   会话消息内嵌在顶层(无 .message 壳);另有 type:'file-history-snapshot'
 *   等非会话行,按既有规则跳过。
 */
interface ClaudeLine {
  type?: string
  role?: string
  message?: { role?: string; content?: unknown }
  content?: unknown
  timestamp?: string | number
  sessionId?: string
  cwd?: string
  isSidechain?: boolean
}

function toEpoch(ts?: string | number): number | undefined {
  // CodeBuddy 写毫秒 epoch;Claude 系写 ISO 字符串
  if (typeof ts === 'number') return Number.isFinite(ts) ? Math.floor(ts / 1000) : undefined
  if (!ts) return undefined
  const t = Date.parse(ts)
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
    // 'text' = Claude 系;'input_text'/'output_text' = CodeBuddy ≥2.x(OpenAI Responses 风格)
    if (
      (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') &&
      typeof part.text === 'string' &&
      part.text.trim()
    ) {
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
    const ts = toEpoch(entry.timestamp)
    // sidechain (subagent) lines contribute neither messages nor timestamps
    if (!entry.isSidechain) {
      if (ts && (!endedAt || ts > endedAt)) endedAt = ts
      if (ts && (!startedAt || ts < startedAt)) startedAt = ts
      if (entry.sessionId && !externalId) externalId = entry.sessionId
      if (entry.cwd && !cwd) cwd = entry.cwd
    }

    // Claude 系:type=user|assistant + message.content;
    // CodeBuddy ≥2.x:type=message + 顶层 role/content(见文件头注释)
    if (!entry.isSidechain && (entry.type === 'user' || entry.type === 'assistant') && entry.message) {
      const role = entry.type === 'user' ? 'user' : 'assistant'
      messages.push(...contentToMessages(role, entry.message.content, ts))
    } else if (
      entry.type === 'message' &&
      (entry.role === 'user' || entry.role === 'assistant') &&
      !entry.isSidechain
    ) {
      messages.push(...contentToMessages(entry.role as 'user' | 'assistant', entry.content, ts))
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
  // 根目录来自环境变量/设置,先收口校验(必须是已存在的目录),再在其中遍历
  const base = safeDir(root)
  if (!base) return []
  const out: string[] = []
  walkWithin(base, base, (file) => {
    if (file.endsWith('.jsonl')) out.push(file)
  })
  return out
}

function msToSec(ms: unknown): number | undefined {
  return typeof ms === 'number' && Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined
}

/** Claude 桌面端(Claude.app ≥5.x,内部代号 CCD)的会话存储目录名 */
export const DESKTOP_SESSION_STORES = ['claude-code-sessions', 'local-agent-mode-sessions']

/** 会话目录可以嵌套得多深(org/account/[session]) —— 留出余量,防止未来布局加深 */
const MAX_PROJECTS_DEPTH = 8

/**
 * Claude Code **桌面版**不再"对话不落盘"。
 *
 * 桌面端给 Code 会话单独设 `CLAUDE_CONFIG_DIR`,transcript 仍按 Claude Code 的
 * 格式写在 `<config>/projects/<project-slug>/<sessionId>.jsonl`,只是 config 不在
 * `~/.claude`,而在应用自己的会话存储里:
 *
 *   %LOCALAPPDATA%/<app>/claude-code-sessions/<org>/<account>/.claude/projects/…
 *   %LOCALAPPDATA%/<app>/local-agent-mode-sessions/<org>/<account>/<session>/.claude/projects/…
 *
 * 依据:claude.exe 的 asar 里 transcript 读取路径是
 * `join(sessionStorageDir, '.claude', 'projects')`;写侧由 CLI 按 CLAUDE_CONFIG_DIR
 * 落盘(同一个 projects 布局)。少数形态把 `projects/` 直接放在会话目录下,
 * 因此两种都收。目录在用户第一次打开 Code 标签页之前**不存在**,所以必须
 * 每次扫描现场发现,不能缓存。
 */
export function findDesktopProjectsRoots(appDataDirs: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []

  const hasTranscript = (dir: string): boolean => {
    let slugs: fs.Dirent[]
    try {
      slugs = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return false
    }
    for (const slug of slugs) {
      if (!slug.isDirectory()) continue
      let files: fs.Dirent[]
      try {
        files = fs.readdirSync(path.join(dir, slug.name), { withFileTypes: true })
      } catch {
        continue
      }
      if (files.some((f) => f.isFile() && f.name.endsWith('.jsonl'))) return true
    }
    return false
  }

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_PROJECTS_DEPTH) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const full = path.join(dir, e.name)
      if (e.name === 'projects') {
        // transcript 树内部不再下钻(projects 下面全是 <slug>/<id>.jsonl)
        if (hasTranscript(full)) out.push(full)
        continue
      }
      walk(full, depth + 1)
    }
  }

  for (const appDir of appDataDirs) {
    for (const store of DESKTOP_SESSION_STORES) {
      const base = safeDir(path.join(appDir, store))
      if (base) walk(base, 0)
    }
  }
  // Windows 路径大小写不敏感 —— 同一个目录经不同候选根进来只保留一次
  return out.filter((dir) => {
    const key = process.platform === 'win32' ? path.resolve(dir).toLowerCase() : path.resolve(dir)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Claude Desktop 旧版(Electron shell, data dir "Claude-3p")通过 Agent SDK 驱动
 * 内置 claude.exe,**对话不落盘**,只有这份 per-session 元数据(local_*.json)。
 * 新版(≥5.x)的 Code 会话会把 transcript 写进自己的 CLAUDE_CONFIG_DIR
 * (见 findDesktopProjectsRoots),元数据仍在;有 transcript 时以 transcript 为准,
 * 这里只在没有正文时兜底 —— 标题/cwd/时间至少让对话在列表、项目分组和搜索里可见。
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
  const base = safeDir(root)
  if (!base) return []
  const out: string[] = []
  walkWithin(base, base, (file) => {
    const name = path.basename(file)
    if (name.startsWith('local_') && name.endsWith('.json')) out.push(file)
  })
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
