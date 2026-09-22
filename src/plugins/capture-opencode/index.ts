import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCapturePlugin } from '../_lib/capture-factory'
import { parseAgentSqliteSessions } from '../_lib/agent-db-parser'
import { findOpencodeStorage, parseOpencodeStorage } from './opencode-parser'

/**
 * OpenCode >= 2026 keeps sessions in a SQLite store (session/message/part
 * tables — same layout as its fork ZCode). Older builds used the JSON tree
 * under storage/; both are supported, db first.
 */
function findOpencodeDb(): string | null {
  const candidates = [
    path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db'),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'opencode', 'opencode.db') : ''
  ].filter(Boolean)
  return candidates.find((c) => fs.existsSync(c)) ?? null
}

export default createCapturePlugin({
  id: 'capture-opencode',
  name: 'Capture: OpenCode / Copilot CLI',
  agentType: 'opencode',
  defaultRoot: os.homedir(),
  sourceExists: (home) =>
    findOpencodeDb() !== null || findOpencodeStorage(home, process.env.LOCALAPPDATA) !== null,
  collect: (home) => {
    const dbPath = findOpencodeDb()
    if (dbPath) return parseAgentSqliteSessions(dbPath, 'opencode')
    const storage = findOpencodeStorage(home, process.env.LOCALAPPDATA)
    return storage ? parseOpencodeStorage(storage) : []
  }
})
