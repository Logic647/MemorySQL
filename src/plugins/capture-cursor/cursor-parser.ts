import path from 'node:path'
import type Database from 'better-sqlite3'
import type { RawMessage, RawSession } from '../../shared/types'
import { openForeignDb } from '../../main/core/sqlite-ro'
import { listWithin, safeDir, withinRoot } from '../../main/core/safe-path'

/**
 * Cursor chat history. Primary store (verified against community parsers:
 * cursor-chat-export / vibe-replay analysis, 2025+):
 *   <appData>/Cursor/User/globalStorage/state.vscdb
 *     cursorDiskKV 'composerData:<sessionId>'  → session meta, contains
 *       fullConversationHeadersOnly: [{type: 1(user)|2(AI), bubbleId}]
 *     cursorDiskKV 'bubbleId:<sessionId>:<bubbleId>' → {text, toolFormerData}
 * Legacy fallbacks kept: inline conversation[] on composerData, and
 * ItemTable 'workbench.panel.aichat.view.aichat.chatdata'.
 * EXPERIMENTAL: format drifts between Cursor versions.
 */
const COMPOSER_TEXT_MAX = 6000

export function findCursorDbs(home: string, appData?: string): string[] {
  // home / appData 来自环境变量,先收口校验为真实存在的目录
  const homeRoot = safeDir(home)
  if (!homeRoot) return []
  const appRoot = appData ? safeDir(appData) : null
  const userDirs = [
    appRoot ? path.join(appRoot, 'Cursor', 'User') : path.join(homeRoot, 'AppData', 'Roaming', 'Cursor', 'User'),
    path.join(homeRoot, '.config', 'Cursor', 'User')
  ]
  const dbs: string[] = []
  for (const userDir of userDirs) {
    // 目录来自环境变量,先解析并确认仍在预期根目录内,再逐个文件校验边界
    const dir = withinRoot(homeRoot, userDir, 'Cursor 数据目录')
    const global = withinRoot(dir, path.join(dir, 'globalStorage', 'state.vscdb'), 'Cursor 库文件')
    if (fsExists(global)) dbs.push(global)
    try {
      const wsDir = withinRoot(dir, path.join(dir, 'workspaceStorage'), 'Cursor 工作区目录')
      for (const e of listWithin(wsDir, wsDir)) {
        if (!e.isDirectory()) continue
        const db = withinRoot(wsDir, path.join(wsDir, e.name, 'state.vscdb'), 'Cursor 库文件')
        if (fsExists(db)) dbs.push(db)
      }
    } catch {
      /* no workspaceStorage */
    }
  }
  return dbs
}

import fs from 'node:fs'
function fsExists(p: string): boolean {
  return fs.existsSync(p)
}

interface ComposerData {
  name?: string
  lastUpdatedAt?: number
  createdAt?: number
  fullConversationHeadersOnly?: Array<{ type?: number; bubbleId?: string }>
  conversation?: Array<{ type?: number | string; text?: string }>
}

export function parseCursorDb(dbPath: string): RawSession[] {
  const { db, cleanup } = openForeignDb(dbPath)
  try {
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    ).map((r) => r.name)
    if (!tables.includes('cursorDiskKV')) return parseLegacyChatData(db, tables)
    return parseCursorDiskKv(db, dbPath)
  } finally {
    cleanup()
  }
}

function parseCursorDiskKv(db: Database.Database, dbPath: string): RawSession[] {
  const out: RawSession[] = []
  const getBubble = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?')

  const composers = db
    .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
    .all() as Array<{ key: string; value: string }>

  for (const row of composers) {
    try {
      const sessionId = row.key.slice('composerData:'.length)
      const data = JSON.parse(row.value) as ComposerData
      const messages: RawMessage[] = []

      const headers = data.fullConversationHeadersOnly
      if (Array.isArray(headers)) {
        // current format: ordered header list pointing at separate bubble rows
        for (const h of headers) {
          if (!h?.bubbleId) continue
          const bubbleRow = getBubble.get(`bubbleId:${sessionId}:${h.bubbleId}`) as
            | { value: string }
            | undefined
          if (!bubbleRow) continue
          let bubble: { text?: string; toolFormerData?: { name?: string; params?: unknown; result?: unknown } }
          try {
            bubble = JSON.parse(bubbleRow.value) as typeof bubble
          } catch {
            continue
          }
          const tool = bubble.toolFormerData
          if (tool && typeof tool.name === 'string') {
            messages.push({
              role: 'tool',
              toolName: tool.name,
              content: JSON.stringify({ params: tool.params ?? null, result: tool.result ?? null }).slice(0, 2000)
            })
          }
          if (typeof bubble.text === 'string' && bubble.text.trim()) {
            const role = h.type === 1 ? 'user' : 'assistant'
            messages.push({ role, content: bubble.text.slice(0, COMPOSER_TEXT_MAX) })
          }
        }
      } else if (Array.isArray(data.conversation)) {
        // older format: inline conversation on the composer row
        for (const bubble of data.conversation) {
          if (typeof bubble.text !== 'string' || !bubble.text.trim()) continue
          const role = bubble.type === 1 || bubble.type === 'user' ? 'user' : 'assistant'
          messages.push({ role, content: bubble.text.slice(0, COMPOSER_TEXT_MAX) })
        }
      }

      if (messages.length === 0) continue
      out.push({
        externalId: sessionId,
        agentType: 'cursor',
        title: typeof data.name === 'string' && data.name ? data.name : undefined,
        startedAt:
          typeof data.lastUpdatedAt === 'number'
            ? Math.floor(data.lastUpdatedAt / 1000)
            : typeof data.createdAt === 'number'
              ? Math.floor(data.createdAt / 1000)
              : undefined,
        endedAt:
          typeof data.lastUpdatedAt === 'number'
            ? Math.floor(data.lastUpdatedAt / 1000)
            : typeof data.createdAt === 'number'
              ? Math.floor(data.createdAt / 1000)
              : undefined,
        messages,
        rawPath: dbPath
      })
    } catch {
      /* skip malformed composer rows */
    }
  }
  return out
}

interface ChatData {
  tabs?: Array<{ bubbles?: Array<{ type?: number | string; text?: string }> }>
}

/** very old path: inline chatdata on ItemTable */
function parseLegacyChatData(
  db: Database.Database,
  tables: string[]
): RawSession[] {
  const out: RawSession[] = []
  if (!tables.includes('ItemTable')) return out
  const row = db
    .prepare("SELECT value FROM ItemTable WHERE key = 'workbench.panel.aichat.view.aichat.chatdata'")
    .get() as { value: string } | undefined
  if (!row) return out
  try {
    const data = JSON.parse(row.value) as ChatData
    const messages: RawMessage[] = []
    for (const tab of data.tabs ?? []) {
      for (const b of tab.bubbles ?? []) {
        if (typeof b.text !== 'string' || !b.text.trim()) continue
        const role = b.type === 'user' ? 'user' : 'assistant'
        messages.push({ role, content: b.text.slice(0, COMPOSER_TEXT_MAX) })
      }
    }
    if (messages.length > 0) {
      out.push({
        externalId: `chatdata-legacy`,
        agentType: 'cursor',
        messages,
        rawPath: 'state.vscdb'
      })
    }
  } catch {
    /* malformed chatdata */
  }
  return out
}
