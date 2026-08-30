import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

/**
 * Open another application's SQLite database read-only without disturbing it:
 * try a direct readonly connection (works under WAL concurrency); on any
 * failure fall back to a temp snapshot of db+wal+shm, which is always
 * removed afterwards.
 */
export function openForeignDb(dbPath: string): { db: Database.Database; cleanup: () => void } {
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true })
    db.pragma('busy_timeout = 3000')
    db.prepare('SELECT COUNT(*) FROM sqlite_master').get()
    return { db, cleanup: () => db.close() }
  } catch {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memorysql-foreign-'))
    try {
      for (const suffix of ['', '-wal', '-shm']) {
        const src = `${dbPath}${suffix}`
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmpDir, `state.db${suffix}`))
      }
      const db = new Database(path.join(tmpDir, 'state.db'), { readonly: true, fileMustExist: true })
      return {
        db,
        cleanup: () => {
          db.close()
          fs.rmSync(tmpDir, { recursive: true, force: true })
        }
      }
    } catch (err) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
      throw err
    }
  }
}
