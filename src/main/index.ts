import { app, BrowserWindow, ipcMain } from 'electron'
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

// Order here is only a hint — the host topologically sorts by manifest.requires.
const BUILTIN_PLUGINS = [summarizerRules, coreSchema, captureCodex, captureZcode, captureHermes]

const HEADLESS_SCAN = process.argv.includes('--scan')

// kept for graceful shutdown on window close
let running: { host: PluginHost; db: Db } | null = null

async function bootstrap(): Promise<{
  host: PluginHost
  db: Db
  events: EventBus
}> {
  const env = resolveAppEnv()
  const settings = new SettingsStore(env)
  const db = new Db(env.dbPath)
  const events = new EventBus()
  const host = new PluginHost(db, settings, events)
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
