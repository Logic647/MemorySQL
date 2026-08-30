import os from 'node:os'
import { createCapturePlugin } from '../_lib/capture-factory'
import { findCursorDbs, parseCursorDb } from './cursor-parser'

// Cursor stores chats inside SQLite databases, not a watchable file tree —
// manual rescan only.
export default createCapturePlugin({
  id: 'capture-cursor',
  name: 'Capture: Cursor (experimental)',
  agentType: 'cursor',
  defaultRoot: os.homedir(),
  sourceExists: (home) => findCursorDbs(home, process.env.APPDATA).length > 0,
  collect: (home) => {
    const sessions = []
    for (const dbPath of findCursorDbs(home, process.env.APPDATA)) {
      try {
        sessions.push(...parseCursorDb(dbPath))
      } catch {
        /* skip unreadable dbs */
      }
    }
    return sessions
  }
})
