import path from 'node:path'
import type { RawMessage, RawSession } from '../../shared/types'
import { openForeignDb } from '../../main/core/sqlite-ro'

/**
 * Cursor chat history (experimental — format drifts between versions).
 * Checked in order:
 *   1. cursorDiskKV keys 'composerData:<id>' → {conversation:[{type:1|2,text,…}], name}
 *   2. ItemTable key 'workbench.panel.aichat.view.aichat.chatdata'
 *      → {tabs:[{bubbles:[{type:'user'|'ai', text}]}]}
 * state.vscdb locations: AppData Cursor User globalStorage and each
 * workspaceStorage subdirectory (state.vscdb).
 */
const COMPOSER_TEXT_MAX = 4000

export function findCursorDbs(home: string, appData?: string): string[] {
  const roots = [
    appData ? path.join(appData, 'Cursor', 'User') : path.join(home, 'AppData', 'Roaming', 'Cursor', 'User'),
    path.join(home, '.config', 'Cursor', 'User')
  ]
  const dbs: string[] = []
  for (const userDir of roots) {
    const global = path.join(userDir, 'globalStorage', 'state.vscdb')
    if (fs2Exists(global)) dbs.push(global)
    const wsDir = path.join(userDir, 'workspaceStorage')
    try {
      for (const e of fs2Readdir(wsDir)) {
        const db = path.join(wsDir, e, 'state.vscdb')
        if (fs2Exists(db)) dbs.push(db)
      }
    } catch {
      /* no workspaceStorage */
    }
  }
  return dbs
}

import fs from 'node:fs'
function fs2Exists(p: string): boolean {
  return fs.existsSync(p)
}
function fs2Readdir(p: string): string[] {
  try {
    return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return []
  }
}

interface ComposerBubble {
  type?: number | string
  text?: string
}

export function parseCursorDb(dbPath: string): RawSession[] {
  const { db, cleanup } = openForeignDb(dbPath)
  try {
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    ).map((r) => r.name)
    const out: RawSession[] = []

    if (tables.includes('cursorDiskKV')) {
      const rows = db
        .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
        .all() as Array<{ key: string; value: string }>
      for (const row of rows) {
        try {
          const data = JSON.parse(row.value) as {
            conversation?: ComposerBubble[]
            name?: string
            lastUpdatedAt?: number
          }
          const messages: RawMessage[] = []
          for (const bubble of data.conversation ?? []) {
            if (typeof bubble.text !== 'string' || !bubble.text.trim()) continue
            const role = bubble.type === 1 || bubble.type === 'user' ? 'user' : 'assistant'
            messages.push({ role, content: bubble.text.slice(0, COMPOSER_TEXT_MAX) })
          }
          if (messages.length === 0) continue
          out.push({
            externalId: row.key.slice('composerData:'.length),
            agentType: 'cursor',
            title: data.name || undefined,
            endedAt: data.lastUpdatedAt ? Math.floor(data.lastUpdatedAt / 1000) : undefined,
            messages,
            rawPath: dbPath
          })
        } catch {
          /* skip malformed composer rows */
        }
      }
    }

    if (out.length === 0 && tables.includes('ItemTable')) {
      const row = db
        .prepare("SELECT value FROM ItemTable WHERE key = 'workbench.panel.aichat.view.aichat.chatdata'")
        .get() as { value: string } | undefined
      if (row) {
        try {
          const data = JSON.parse(row.value) as { tabs?: Array<{ bubbles?: ComposerBubble[] }> }
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
              externalId: `chatdata-${path.basename(path.dirname(dbPath))}`,
              agentType: 'cursor',
              messages,
              rawPath: dbPath
            })
          }
        } catch {
          /* malformed chatdata */
        }
      }
    }
    return out
  } finally {
    cleanup()
  }
}
