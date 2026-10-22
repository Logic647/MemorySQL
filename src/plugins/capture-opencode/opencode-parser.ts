import fs from 'node:fs'
import path from 'node:path'
import type { RawMessage, RawSession } from '../../shared/types'
import { isWithin, listWithin, safeDir, withinRoot } from '../../main/core/safe-path'

/**
 * OpenCode (~/.local/share/opencode/storage/ or %LOCALAPPDATA%/opencode/storage):
 *   session/<scope>/ses_*.json  → {id, title?, directory?, time?: {created?, updated?}}
 *   message/<sessionId>/msg_*.json → {id, role: 'user'|'assistant', …}
 *   part/<messageId>/part_*.json   → {type:'text', text} | {type:'tool', …}
 * File names carry ordering (msg_0001…). Parsed defensively.
 */
function readJsonFiles(root: string, dir: string): Array<{ file: string; data: Record<string, unknown> }> {
  const out: Array<{ file: string; data: Record<string, unknown> }> = []
  // 文件名排序决定消息顺序;用纯字典序(无自定义比较器),避免把外部数据带进比较函数
  const names = listWithin(root, dir)
    .map((e) => e.name)
    .sort()
  for (const name of names) {
    const full = withinRoot(root, path.join(dir, name), 'opencode 文件')
    let st: fs.Stats
    try {
      st = fs.statSync(full)
    } catch {
      continue
    }
    if (!st.isFile() || !name.endsWith('.json')) continue
    try {
      const data = JSON.parse(fs.readFileSync(full, 'utf-8')) as Record<string, unknown>
      if (data && typeof data === 'object') out.push({ file: name, data })
    } catch {
      /* skip malformed */
    }
  }
  return out
}

function collectTexts(root: string, partDir: string, messageRef: string): string | null {
  const parts = readJsonFiles(root, partDir)
  if (parts.length === 0) return null
  const texts: string[] = []
  let toolCalls = 0
  for (const { data } of parts) {
    const type = String(data.type ?? '')
    if (type === 'text' && typeof data.text === 'string' && data.text.trim()) {
      texts.push(data.text)
    } else if (type === 'tool') {
      toolCalls++
    }
  }
  if (toolCalls > 0) {
    texts.push(`[${toolCalls} tool call${toolCalls > 1 ? 's' : ''}]`)
  }
  const joined = texts.join('\n\n').trim()
  return joined || (messageRef ? null : null)
}

export function parseOpencodeStorage(storageDir: string): RawSession[] {
  // 存储目录可能来自环境变量,先收口校验为真实存在的目录
  const base = safeDir(storageDir)
  if (!base) return []
  const root = base
  const sessionDir = withinRoot(root, path.join(root, 'session'), 'opencode 会话目录')
  if (!fs.existsSync(sessionDir)) return []
  const out: RawSession[] = []

  const scopeDirs: fs.Dirent[] = listWithin(root, sessionDir).filter((d) => d.isDirectory())

  for (const scope of scopeDirs) {
    const scopePath = withinRoot(root, path.join(sessionDir, scope.name), 'opencode scope')
    for (const { file, data } of readJsonFiles(root, scopePath)) {
      const sessionId = String(data.id ?? file.replace(/\.json$/, ''))
      if (!sessionId) continue
      const msgDir = withinRoot(root, path.join(root, 'message', sessionId), 'opencode 消息目录')
      if (!fs.existsSync(msgDir)) continue

      const messages: RawMessage[] = []
      let startedAt: number | undefined
      let endedAt: number | undefined
      for (const { data: msg } of readJsonFiles(root, msgDir)) {
        const role = String(msg.role ?? '') === 'user' ? 'user' : String(msg.role ?? '') === 'assistant' ? 'assistant' : null
        if (!role) continue
        const messageId = String(msg.id ?? '')
        const text = collectTexts(root, withinRoot(root, path.join(root, 'part', messageId), 'opencode part 目录'), messageId)
        if (!text) continue
        const time = msg.time as { created?: number } | undefined
        const ts = time?.created ? Math.floor(time.created / 1000) : undefined
        if (ts) {
          if (!startedAt || ts < startedAt) startedAt = ts
          if (!endedAt || ts > endedAt) endedAt = ts
        }
        messages.push({ role, content: text, ts })
      }
      if (messages.length === 0) continue

      const time = data.time as { created?: number; updated?: number } | undefined
      out.push({
        externalId: sessionId,
        agentType: 'opencode',
        cwd: typeof data.directory === 'string' ? data.directory : undefined,
        startedAt: startedAt ?? (time?.created ? Math.floor(time.created / 1000) : undefined),
        endedAt: endedAt ?? (time?.updated ? Math.floor(time.updated / 1000) : undefined),
        title: typeof data.title === 'string' && data.title ? data.title : undefined,
        messages,
        rawPath: scopePath
      })
    }
  }
  return out
}

export function findOpencodeStorage(home: string, localAppData?: string): string | null {
  // home / localAppData 来自环境变量,先收口校验为真实存在的目录
  const homeRoot = safeDir(home)
  if (!homeRoot) return null
  const appRoot = localAppData ? safeDir(localAppData) : null
  const candidates = [
    appRoot ? path.join(appRoot, 'opencode', 'storage') : null,
    path.join(homeRoot, '.local', 'share', 'opencode', 'storage')
  ].filter((p): p is string => p !== null)
  for (const c of candidates) {
    const abs = path.resolve(c)
    // 候选目录必须真实存在,且不能借 ".." 之类的片段跳出预期位置
    if (!isWithin(homeRoot, abs) && !(appRoot && isWithin(appRoot, abs))) continue
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return abs
  }
  return null
}
