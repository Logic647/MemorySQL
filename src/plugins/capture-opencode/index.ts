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

/** db file and its -wal/-shm sidecars (WAL writes may not touch the main file) */
const OPENCODE_DB_WATCH = /opencode\.db(-wal|-shm)?$/i

function watchPaths(): string[] {
  const db = findOpencodeDb()
  if (db) return [path.dirname(db)]
  // db not created yet — watch existing candidate parents so a later create fires
  const dirs = [
    path.join(os.homedir(), '.local', 'share', 'opencode'),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'opencode') : ''
  ].filter(Boolean)
  return dirs.filter((d) => fs.existsSync(d))
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
  },
  // db-backed: any write to opencode.db(-wal) re-reads the whole (small) store —
  // title/cwd renames show up without waiting for the next app launch.
  // watchPaths is a function so a db created after plugin load is still watched.
  watchPaths,
  watch: { match: OPENCODE_DB_WATCH, rescan: true }
})
