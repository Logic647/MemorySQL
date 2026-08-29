import { app, BrowserWindow, ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { resolveAppEnv } from './core/env'
import { SettingsStore } from './core/settings'
import { EventBus } from './core/event-bus'
import { Db } from './core/db'
import { PluginHost } from './core/plugin-host'
import summarizerRules from '../plugins/summarizer-rules'
import coreSchema from '../plugins/core-schema'
import captureCodex from '../plugins/capture-codex'
import captureZcode from '../plugins/capture-zcode'
import captureHermes from '../plugins/capture-hermes'
import mcpServer from '../plugins/mcp-server'
import privacyExport from '../plugins/privacy-export'
import syncArchive from '../plugins/sync-archive'

// Order here is only a hint — the host topologically sorts by manifest.requires.
const BUILTIN_PLUGINS = [
  summarizerRules,
  coreSchema,
  captureCodex,
  captureZcode,
  captureHermes,
  mcpServer,
  privacyExport,
  syncArchive
]

const HEADLESS_SCAN = process.argv.includes('--scan')
const EXPORT_ARCHIVE_DEST = (() => {
  const i = process.argv.indexOf('--export-archive')
  return i >= 0 ? (process.argv[i + 1] ?? '') : null
})()

/**
 * A previous run staged an archive import: swap the staged db/vault into
 * place before anything opens them. Renames are same-volume and atomic-ish;
 * the current db is rotated aside, never deleted.
 */
function processPendingImport(dataDir: string, dbPath: string, vaultDir: string): void {
  const markerPath = path.join(dataDir, '.import-pending.json')
  if (!fs.existsSync(markerPath)) return
  try {
    const { stagingDir } = JSON.parse(fs.readFileSync(markerPath, 'utf-8')) as { stagingDir: string }
    const stagedDb = path.join(stagingDir, 'memory.db')
    if (fs.existsSync(stagedDb)) {
      for (const suffix of ['-wal', '-shm']) {
        if (fs.existsSync(dbPath + suffix)) fs.rmSync(dbPath + suffix)
      }
      if (fs.existsSync(dbPath)) fs.renameSync(dbPath, `${dbPath}.pre-import-${Date.now()}`)
      fs.renameSync(stagedDb, dbPath)
      const stagedVault = path.join(stagingDir, 'vault')
      if (fs.existsSync(stagedVault)) {
        fs.rmSync(vaultDir, { recursive: true, force: true })
        fs.renameSync(stagedVault, vaultDir)
      }
    }
    fs.rmSync(markerPath, { force: true })
    fs.rmSync(stagingDir, { recursive: true, force: true })
    console.info('[import] staged archive swapped in')
  } catch (err) {
    console.error('[import] pending import failed:', err)
  }
}

// kept for graceful shutdown on window close
let running: { host: PluginHost; db: Db } | null = null

async function bootstrap(): Promise<{
  host: PluginHost
  db: Db
  events: EventBus
}> {
  const env = resolveAppEnv()
  processPendingImport(env.dataDir, env.dbPath, env.vaultDir)
  const settings = new SettingsStore(env)
  const db = new Db(env.dbPath)
  const events = new EventBus()
  const host = new PluginHost(env, db, settings, events)
  for (const p of BUILTIN_PLUGINS) host.add(p)
  await host.startAll()
  return { host, db, events }
}

async function runHeadlessScan(): Promise<void> {
  const { host, db } = await bootstrap()
  const results: Record<string, unknown> = {}
  for (const pluginId of ['capture-codex', 'capture-zcode', 'capture-hermes']) {
    try {
      results[pluginId] = await host.invoke(`${pluginId}:scanNow`)
    } catch (err) {
      results[pluginId] = { error: String(err) }
    }
  }
  if (EXPORT_ARCHIVE_DEST !== null) {
    try {
      results['archive'] = await host.invoke('sync-archive:export', { dest: EXPORT_ARCHIVE_DEST || undefined })
    } catch (err) {
      results['archive'] = { error: String(err) }
    }
  }
  try {
    results['stats'] = await host.invoke('core-schema:stats:overview')
  } catch {
    /* ignore */
  }
  console.log('=== MemorySQL headless scan ===')
  console.log(JSON.stringify(results, null, 2))
  await host.stopAll()
  db.close()
  app.exit(0)
}

function createWindow(host: PluginHost, events: EventBus): BrowserWindow {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    title: 'MemorySQL',
    backgroundColor: '#101418',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })

  events.on('sessions:changed', () => {
    if (!win.isDestroyed()) win.webContents.send('push:sessions:changed')
  })

  ipcMain.handle('memorysql:invoke', (_event, channel: string, payload: unknown) => {
    return host.invoke(channel, payload)
  })
  ipcMain.handle('memorysql:channels', () => host.listChannels())
  ipcMain.handle('memorysql:mcp-tools', () => host.mcpToolDefs().map((t) => t.name))

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(path.join(import.meta.dirname, '../renderer/index.html'))
  }
  return win
}

app.whenReady().then(async () => {
  try {
    if (HEADLESS_SCAN) {
      await runHeadlessScan()
      return
    }
    const boot = await bootstrap()
    running = { host: boot.host, db: boot.db }
    createWindow(boot.host, boot.events)
  } catch (err) {
    console.error('Fatal bootstrap error:', err)
    app.exit(1)
  }
})

app.on('window-all-closed', () => {
  void (async () => {
    try {
      await running?.host.stopAll()
      running?.db.close()
    } catch (err) {
      console.error('shutdown error:', err)
    } finally {
      app.quit()
    }
  })()
})
