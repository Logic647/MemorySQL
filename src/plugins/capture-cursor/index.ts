import os from 'node:os'
import { createCapturePlugin } from '../_lib/capture-factory'
import { userDataDir } from '../../main/core/safe-path'
import { findCursorDbs, parseCursorDb } from './cursor-parser'

// Cursor stores chats inside SQLite databases, not a watchable file tree —
// manual rescan only.
export default createCapturePlugin({
  id: 'capture-cursor',
  name: 'Capture: Cursor (experimental)',
  agentType: 'cursor',
  defaultRoot: os.homedir(),
  sourceExists: (home) => findCursorDbs(home, userDataDir('roaming')).length > 0,
  collect: (home) => {
    const sessions = []
    for (const dbPath of findCursorDbs(home, userDataDir('roaming'))) {
      try {
        sessions.push(...parseCursorDb(dbPath))
      } catch {
        /* skip unreadable dbs */
      }
    }
    return sessions
  }
})
