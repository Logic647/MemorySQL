import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'

/**
 * Data layout (self-contained, portable — copy the folder, move the vault):
 *   <dataDir>/memory.db       SQLite (sessions/messages/memories/FTS)
 *   <dataDir>/vault/          Markdown notes (Obsidian-compatible)
 *   <dataDir>/settings.json   app + plugin settings
 *
 * The user may relocate the whole dir in settings: a one-shot marker file
 * `.datadir-pending` in the DEFAULT location points at the new root and is
 * consumed on the next boot.
 */
export interface AppEnv {
  dataDir: string
  dataDirIsCustom: boolean
  dbPath: string
  vaultDir: string
  settingsPath: string
}

export function defaultDataDir(): string {
  return app.isPackaged
    ? path.join(app.getPath('userData'), 'data')
    : path.join(app.getAppPath(), 'data')
}

export function resolveAppEnv(): AppEnv {
  let dataDir = defaultDataDir()
  let custom = false
  const marker = path.join(dataDir, '.datadir-pending')
  try {
    const parsed = JSON.parse(fs.readFileSync(marker, 'utf-8')) as { target?: string | null }
    fs.rmSync(marker, { force: true })
    if (parsed.target && path.isAbsolute(parsed.target)) {
      dataDir = parsed.target
      custom = true
    }
  } catch {
    /* no marker — default location */
  }
  // explicit env override wins (headless tests / multi-profile)
  if (process.env.MEMORYSQL_DATA_DIR) {
    dataDir = process.env.MEMORYSQL_DATA_DIR
    custom = true
  }
  for (const d of [dataDir, path.join(dataDir, 'vault')]) {
    fs.mkdirSync(d, { recursive: true })
  }
  return {
    dataDir,
    dataDirIsCustom: custom,
    dbPath: path.join(dataDir, 'memory.db'),
    vaultDir: path.join(dataDir, 'vault'),
    settingsPath: path.join(dataDir, 'settings.json')
  }
}
