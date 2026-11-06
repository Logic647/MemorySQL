import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCapturePlugin } from '../_lib/capture-factory'
import { parseAgentSqliteSessions } from '../_lib/agent-db-parser'
import { userDataDir } from '../../main/core/safe-path'
import { findOpencodeStorage, parseOpencodeStorage } from './opencode-parser'

/**
 * OpenCode keeps sessions in a SQLite store. Layouts, detected per open:
 * ≥2.0 → session_v2 + session_message (parts embedded in the message JSON);
 * ≤1.x → session/message/part (same layout as its fork ZCode). Older builds
 * used the JSON tree under storage/; all three are supported, db first.
 */
function findOpencodeDb(): string | null {
  const candidates = [
    path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db'),
    path.join(userDataDir('local'), 'opencode', 'opencode.db')
  ]
  return candidates.find((c) => fs.existsSync(c)) ?? null
}

/**
 * db file and its -wal sidecar. `-shm` is deliberately excluded: it is the
 * shared-memory index and churns on plain reads, which would turn every query
 * by the agent into a full-store rescan.
 */
const OPENCODE_DB_WATCH = /opencode\.db(-wal)?$/i

function watchPaths(): string[] {
  const db = findOpencodeDb()
  if (db) return [path.dirname(db)]
  // db not created yet — watch existing candidate parents so a later create fires
  const dirs = [
    path.join(os.homedir(), '.local', 'share', 'opencode'),
    path.join(userDataDir('local'), 'opencode')
  ]
  return dirs.filter((d) => fs.existsSync(d))
}

export default createCapturePlugin({
  id: 'capture-opencode',
  name: 'Capture: OpenCode / Copilot CLI',
  agentType: 'opencode',
  defaultRoot: os.homedir(),
  sourceExists: (home) =>
    findOpencodeDb() !== null || findOpencodeStorage(home, userDataDir('local')) !== null,
  collect: (home) => {
    const dbPath = findOpencodeDb()
    if (dbPath) return parseAgentSqliteSessions(dbPath, 'opencode')
    const storage = findOpencodeStorage(home, userDataDir('local'))
    return storage ? parseOpencodeStorage(storage) : []
  },
  // db 型来源可按 time_updated 增量;JSON 树(旧版)没有可靠的时间字段,
  // 返回 watermark:null 让工厂不要推进水位(否则会漏读)
  collectSince: (home, sinceMs) => {
    const dbPath = findOpencodeDb()
    if (dbPath) {
      const sessions = parseAgentSqliteSessions(dbPath, 'opencode', undefined, { since: sinceMs })
      let maxEnded = 0
      for (const s of sessions) if ((s.endedAt ?? 0) > maxEnded) maxEnded = s.endedAt ?? 0
      return { sessions, watermark: maxEnded > 0 ? maxEnded * 1000 : null }
    }
    const storage = findOpencodeStorage(home, userDataDir('local'))
    return { sessions: storage ? parseOpencodeStorage(storage) : [], watermark: null }
  },
  // db-backed: any write to opencode.db(-wal) re-reads the whole (small) store —
  // title/cwd renames show up without waiting for the next app launch.
  // watchPaths is a function so a db created after plugin load is still watched.
  watchPaths,
  watch: { match: OPENCODE_DB_WATCH, rescan: true }
})
