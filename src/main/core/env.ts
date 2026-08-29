import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'

/**
 * Data layout (self-contained, portable — copy the folder, move the vault):
 *   <dataDir>/memory.db       SQLite (sessions/messages/memories/FTS)
 *   <dataDir>/vault/          Markdown notes (Obsidian-compatible)
 *   <dataDir>/settings.json   app + plugin settings
 */
export interface AppEnv {
  dataDir: string
  dbPath: string
  vaultDir: string
  settingsPath: string
}

export function resolveAppEnv(): AppEnv {
  // app.getAppPath() = project root in dev, resources dir when packaged.
  const dataDir = app.isPackaged
    ? path.join(app.getPath('userData'), 'data')
    : path.join(app.getAppPath(), 'data')
  for (const d of [dataDir, path.join(dataDir, 'vault')]) {
    fs.mkdirSync(d, { recursive: true })
  }
  return {
    dataDir,
    dbPath: path.join(dataDir, 'memory.db'),
    vaultDir: path.join(dataDir, 'vault'),
    settingsPath: path.join(dataDir, 'settings.json')
  }
}
