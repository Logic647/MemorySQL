import { app, BrowserWindow, ipcMain, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveAppEnv, defaultDataDir } from './core/env'
import { connectAgent, agentSnippet } from './core/agent-connect'
import { SettingsStore } from './core/settings'
import { EventBus } from './core/event-bus'
import { Db } from './core/db'
import { PluginHost } from './core/plugin-host'
import summarizerRules from '../plugins/summarizer-rules'
import summarizerLlm from '../plugins/summarizer-llm'
import coreSchema from '../plugins/core-schema'
import captureCodex from '../plugins/capture-codex'
import captureZcode from '../plugins/capture-zcode'
import captureHermes from '../plugins/capture-hermes'
import captureClaudecode from '../plugins/capture-claudecode'
import captureGemini from '../plugins/capture-gemini'
import captureCursor from '../plugins/capture-cursor'
import captureOpencode from '../plugins/capture-opencode'
import mcpServer from '../plugins/mcp-server'
import privacyExport from '../plugins/privacy-export'
import syncArchive from '../plugins/sync-archive'
import memoryCore from '../plugins/memory-core'
import memoryDispatch from '../plugins/memory-dispatch'
import syncFolder from '../plugins/sync-folder'
import projectDevlog from '../plugins/project-devlog'
import semanticSearch from '../plugins/semantic-search'
import coreVault from '../plugins/core-vault'
import captureWatcher from '../plugins/capture-watcher'
import type { MemorySQLPlugin } from './core/plugin-host'
import { setupSpotlight, type SpotlightController } from './spotlight'

type PluginLike = {
  manifest?: { id?: string; name?: string; version?: string }
  init?: (ctx: unknown) => void
}

// Order here is only a hint — the host topologically sorts by manifest.requires.
// summarizer-llm BEFORE rules: the host picks the first *available* provider,
// so a configured LLM wins and everything else falls back to local rules.
const BUILTIN_PLUGINS = [
  summarizerLlm,
  summarizerRules,
  coreSchema,
  coreVault,
  captureCodex,
  captureZcode,
  captureHermes,
  captureClaudecode,
  captureGemini,
  captureCursor,
  captureOpencode,
  captureWatcher,
  mcpServer,
  privacyExport,
  syncArchive,
  memoryCore,
  memoryDispatch,
  syncFolder,
  projectDevlog,
  semanticSearch
]

const HEADLESS_SCAN = process.argv.includes('--scan')
const SYNC_FOLDER = (() => {
  const i = process.argv.indexOf('--sync')
  return i >= 0 ? (process.argv[i + 1] ?? '') : null
})()
const DISPATCH = process.argv.includes('--dispatch')
const GENERATE_DEVLOG = process.argv.includes('--devlog')
const SEMANTIC_REINDEX = process.argv.includes('--reindex')
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
      // archives may carry settings.json (agent paths etc.) — rotate aside
      const stagedSettings = path.join(stagingDir, 'settings.json')
      const settingsPath = path.join(dataDir, 'settings.json')
      if (fs.existsSync(stagedSettings)) {
        if (fs.existsSync(settingsPath)) fs.renameSync(settingsPath, `${settingsPath}.pre-import-${Date.now()}`)
        fs.renameSync(stagedSettings, settingsPath)
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
  settings: SettingsStore
  env: ReturnType<typeof resolveAppEnv>
}> {
  const env = resolveAppEnv()
  processPendingImport(env.dataDir, env.dbPath, env.vaultDir)
  const settings = new SettingsStore(env)
  const db = new Db(env.dbPath)
  const events = new EventBus()
  const host = new PluginHost(env, db, settings, events)
  for (const p of BUILTIN_PLUGINS) host.add(p)
  await loadExternalPlugins(env.dataDir, host)
  await host.startAll()
  return { host, db, events, settings, env }
}

async function runHeadlessScan(): Promise<void> {
  const { host, db } = await bootstrap()
  const results: Record<string, unknown> = {}
  if (HEADLESS_SCAN) {
    const channels = new Set(host.listChannels())
    for (const p of BUILTIN_PLUGINS.filter((x) => x.manifest.id.startsWith('capture-'))) {
      const channel = `${p.manifest.id}:scanNow`
      // not every capture-* plugin registers scanNow (e.g. capture-watcher) —
      // skip rather than log a per-run Unknown channel error
      if (!channels.has(channel)) continue
      try {
        results[p.manifest.id] = await host.invoke(channel)
      } catch (err) {
        results[p.manifest.id] = { error: String(err) }
      }
    }
  }
  if (EXPORT_ARCHIVE_DEST !== null) {
    try {
      results['archive'] = await host.invoke('sync-archive:export', { dest: EXPORT_ARCHIVE_DEST || undefined })
    } catch (err) {
      results['archive'] = { error: String(err) }
    }
  }
  if (SYNC_FOLDER !== null) {
    try {
      await host.invoke('sync-folder:configure', { folder: SYNC_FOLDER })
      results['sync'] = await host.invoke('sync-folder:syncNow')
    } catch (err) {
      results['sync'] = { error: String(err) }
    }
  }
  if (DISPATCH) {
    try {
      results['dispatch'] = await host.invoke('memory-dispatch:generate')
    } catch (err) {
      results['dispatch'] = { error: String(err) }
    }
  }
  if (GENERATE_DEVLOG) {
    try {
      results['devlog'] = await host.invoke('project-devlog:generate')
    } catch (err) {
      results['devlog'] = { error: String(err) }
    }
  }
  if (SEMANTIC_REINDEX) {
    try {
      results['semantic'] = await host.invoke('semantic-search:reindex')
    } catch (err) {
      results['semantic'] = { error: String(err) }
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

/**
 * Host-level (infra) channels for the settings UI: plugin enable/disable
 * (applies next launch) and per-plugin namespaced settings.
 */
/**
 * 外部插件:<dataDir>/plugins/<id>/manifest.json + 单文件 CJS main.js。
 * 隔离加载:单个插件失败不影响应用,只记录错误并在设置页展示。
 */
async function loadExternalPlugins(dataDir: string, host: PluginHost): Promise<void> {
  const root = path.join(dataDir, 'plugins')
  if (!fs.existsSync(root)) return
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = path.join(root, entry.name)
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8')) as {
        id?: string
        name?: string
        version?: string
        main?: string
      }
      if (!manifest.id || !/^[a-z0-9_-]+$/.test(manifest.id)) throw new Error('manifest.id 缺失或非法')
      if (!manifest.name || !manifest.version) throw new Error('manifest.name / version 缺失')
      const mainFile = path.resolve(dir, manifest.main ?? 'main.js')
      if (!mainFile.startsWith(path.resolve(dir) + path.sep)) throw new Error('main 不得逃出插件目录')
      if (!fs.existsSync(mainFile)) throw new Error(`入口文件不存在: ${manifest.main ?? 'main.js'}`)
      // Evaluate as CJS via injected module/exports/require — immune to the
      // app's "type":"module" scope, and plugins can require('electron').
      const { createRequire } = await import('node:module')
      const localRequire = createRequire(pathToFileURL(mainFile).href)
      const code = fs.readFileSync(mainFile, 'utf-8')
      const module_ = { exports: {} as Record<string, unknown> }
      // eslint-disable-next-line no-new-func
      const factory = new Function('module', 'exports', 'require', code) as (
        m: typeof module_,
        e: Record<string, unknown>,
        r: NodeJS.Require
      ) => void
      factory(module_, module_.exports, localRequire as unknown as NodeJS.Require)
      const exported = (module_.exports as { default?: unknown }).default ?? module_.exports
      const plugin = exported as PluginLike
      if (!plugin?.manifest?.id || typeof plugin.init !== 'function') {
        throw new Error('缺 default 导出或 init(ctx) 方法')
      }
      if (plugin.manifest.id !== manifest.id) throw new Error('代码 manifest.id 与 manifest.json 不一致')
      host.add(plugin as unknown as MemorySQLPlugin, true)
      console.info(`[plugins] external loaded: ${manifest.id}`)
    } catch (err) {
      const msg = `${entry.name}: ${String(err instanceof Error ? err.message : err)}`
      host.recordLoadError(msg)
      console.error(`[plugins] external load failed — ${msg}`)
    }
  }
}

const hostChannels = new Map<string, (payload: Record<string, unknown>) => unknown>()

function registerHostChannels(
  host: PluginHost,
  settings: SettingsStore,
  env: ReturnType<typeof resolveAppEnv>,
  db: Db,
  spotlight: SpotlightController
): void {
  hostChannels.set('memorysql:host:plugins', () => ({
    plugins: [
      ...BUILTIN_PLUGINS.map((p) => ({
        id: p.manifest.id,
        name: p.manifest.name,
        version: p.manifest.version,
        enabled: settings.get(`plugin.${p.manifest.id}.enabled`, true),
        external: false
      })),
      ...host.externalPlugins().map((p) => ({
        id: p.manifest.id,
        name: p.manifest.name,
        version: p.manifest.version,
        enabled: settings.get(`plugin.${p.manifest.id}.enabled`, true),
        external: true
      }))
    ],
    skipped: host.skippedPlugins(),
    loadErrors: host.loadErrors(),
    pluginsDir: path.join(env.dataDir, 'plugins')
  }))
  hostChannels.set('memorysql:host:pluginEnable', (payload) => {
    const { id, enabled } = (payload ?? {}) as { id?: string; enabled?: boolean }
    if (typeof id !== 'string' || !id || typeof enabled !== 'boolean') {
      throw new Error('pluginEnable requires {id: string, enabled: boolean}')
    }
    settings.set(`plugin.${id}.enabled`, enabled)
    return { ok: true, restartNeeded: true }
  })
  hostChannels.set('memorysql:host:pluginSetting', (payload) => {
    const { id, key, value } = (payload ?? {}) as { id?: string; key?: string; value?: unknown }
    if (typeof id !== 'string' || !id || typeof key !== 'string' || !key) {
      throw new Error('pluginSetting requires {id, key, value}')
    }
    settings.set(`${id}:${key}`, value)
    return { ok: true, restartNeeded: true }
  })
  // 连接向导:一键为检测到的 agent 写入 MCP 配置(幂等,写入前备份)
  hostChannels.set('memorysql:host:agentConnect', (payload) => {
    const { agent } = (payload ?? {}) as { agent?: string }
    const port = Number(settings.get('mcp-server:port', 8642)) || 8642
    return connectAgent(String(agent ?? ''), port, process.env.APPDATA, process.env.LOCALAPPDATA)
  })
  hostChannels.set('memorysql:host:agentSnippet', (payload) => {
    const { agent } = (payload ?? {}) as { agent?: string }
    const port = Number(settings.get('mcp-server:port', 8642)) || 8642
    return agentSnippet(String(agent ?? ''), port, process.env.APPDATA, process.env.LOCALAPPDATA)
  })
  hostChannels.set('memorysql:host:openPluginsDir', () => {
    void shell.openPath(path.join(env.dataDir, 'plugins'))
    return { ok: true }
  })
  // ---- curated paths + about page ---------------------------------------
  hostChannels.set('memorysql:host:paths', () => {
    const backupDir = String(settings.get('sync-archive:backupDir', '') || '').trim() || path.join(env.dataDir, 'backups')
    const dispatchDir = String(settings.get('memory-dispatch:dispatchDir', '') || '').trim() || path.join(env.vaultDir, 'dispatch')
    return {
      dataDir: env.dataDir,
      backupsDir: backupDir,
      dispatchDir,
      devlogDir: path.join(env.vaultDir, 'devlog'),
      pluginsDir: path.join(env.dataDir, 'plugins')
    }
  })
  hostChannels.set('memorysql:host:openPath', (payload) => {
    const p = String((payload as { path?: string })?.path ?? '')
    if (!p.startsWith(env.dataDir) && !p.startsWith(env.vaultDir)) {
      throw new Error('只允许打开数据目录内的路径')
    }
    if (!fs.existsSync(p)) throw new Error(`目录不存在: ${p}`)
    void shell.openPath(p)
    return { ok: true }
  })
  hostChannels.set('memorysql:host:openExternal', (payload) => {
    const url = String((payload as { url?: string })?.url ?? '')
    if (!/^https?:\/\//.test(url) && !url.startsWith('mailto:')) {
      throw new Error('仅允许 http(s)/mailto 链接')
    }
    void shell.openExternal(url)
    return { ok: true }
  })
  hostChannels.set('memorysql:host:appInfo', () => ({
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    packaged: app.isPackaged
  }))
  hostChannels.set('memorysql:host:checkUpdate', async () => {
    if (!app.isPackaged) return { available: false, reason: '开发模式不检查更新' }
    try {
      const { autoUpdater } = await import('electron-updater')
      const result = await autoUpdater.checkForUpdates()
      const next = result?.updateInfo?.version
      if (next && next !== app.getVersion()) {
        return { available: true, version: next }
      }
      return { available: false, reason: '已是最新版本' }
    } catch (err) {
      return { available: false, reason: `检查失败: ${String(err instanceof Error ? err.message : err)}` }
    }
  })
  hostChannels.set('memorysql:host:updateNow', async () => {
    if (!app.isPackaged) throw new Error('开发模式不支持')
    const { autoUpdater } = await import('electron-updater')
    await autoUpdater.downloadUpdate()
    setImmediate(() => autoUpdater.quitAndInstall())
    return { ok: true, relaunching: true }
  })
  hostChannels.set('memorysql:host:releases', async () => {
    try {
      const res = await fetch('https://api.github.com/repos/Logic647/MemorySQL/releases?per_page=10', {
        headers: { 'User-Agent': 'memorysql-app' },
        signal: AbortSignal.timeout(8000)
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const list = (await res.json()) as Array<{ tag_name: string; published_at: string | null; body: string | null }>
      return {
        releases: list.map((r) => ({
          tag: r.tag_name,
          date: r.published_at,
          notes: (r.body ?? '').slice(0, 1200)
        }))
      }
    } catch (err) {
      return { releases: [], error: String(err instanceof Error ? err.message : err) }
    }
  })
  // spotlight (tray + global hotkey) helpers, used by the ?spotlight=1 window
  hostChannels.set('memorysql:host:openSession', (payload) => {
    const { id } = (payload ?? {}) as { id?: number }
    spotlight.openSessionInMain(Number(id))
    return { ok: true }
  })
  hostChannels.set('memorysql:host:hideSpotlight', () => {
    spotlight.hide()
    return { ok: true }
  })
  // storage relocation: snapshot db into the target, copy vault+settings,
  // drop a one-shot marker and relaunch. The old dir is left untouched.
  hostChannels.set('memorysql:host:dataDir', (payload: { dir?: string; reset?: boolean }) => {
    const defaultDir = defaultDataDir()
    if (payload?.reset) {
      fs.writeFileSync(
        path.join(defaultDir, '.datadir-pending'),
        JSON.stringify({ target: null }),
        'utf-8'
      )
      app.relaunch()
      app.exit(0)
      return { ok: true, relaunching: true }
    }
    const target = path.resolve((payload?.dir ?? '').trim())
    if (!target || target === path.resolve(env.dataDir)) throw new Error('请选择一个不同的目录')
    if (path.resolve(target) === path.resolve(defaultDir) && env.dataDirIsCustom === false) {
      throw new Error('该目录已是默认位置')
    }
    fs.mkdirSync(path.join(target, 'vault'), { recursive: true })
    db.sqlite.exec(`VACUUM INTO '${path.join(target, 'memory.db').replace(/'/g, "''")}'`)
    fs.cpSync(env.vaultDir, path.join(target, 'vault'), { recursive: true })
    if (fs.existsSync(env.settingsPath)) fs.copyFileSync(env.settingsPath, path.join(target, 'settings.json'))
    fs.writeFileSync(
      path.join(defaultDir, '.datadir-pending'),
      JSON.stringify({ target }),
      'utf-8'
    )
    app.relaunch()
    app.exit(0)
    return { ok: true, relaunching: true }
  })
}

function createWindow(host: PluginHost, events: EventBus): BrowserWindow {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    title: 'MemorySQL',
    icon: path.join(app.getAppPath(), 'build', 'icon.png'),
    backgroundColor: '#101418',
    autoHideMenuBar: true,
    // integrated title bar: native white strip removed; system window
    // controls overlay the dark topbar instead
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0a0e16',
      symbolColor: '#d8e2ee',
      height: 46
    },
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
    // host (infra) channels share the renderer bridge but bypass plugin space
    if (typeof channel === 'string' && channel.startsWith('memorysql:host:')) {
      const handler = hostChannels.get(channel)
      if (!handler) throw new Error(`Unknown channel: ${channel}`)
      return handler((payload ?? {}) as Record<string, unknown>)
    }
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
    if (
      HEADLESS_SCAN ||
      SYNC_FOLDER !== null ||
      EXPORT_ARCHIVE_DEST !== null ||
      DISPATCH ||
      GENERATE_DEVLOG ||
      SEMANTIC_REINDEX
    ) {
      await runHeadlessScan()
      return
    }
    const boot = await bootstrap()
    running = { host: boot.host, db: boot.db }
    const win = createWindow(boot.host, boot.events)
    const spotlight = setupSpotlight({ win, settings: boot.settings })
    registerHostChannels(boot.host, boot.settings, boot.env, boot.db, spotlight)
    app.once('will-quit', () => spotlight.dispose())
    if (app.isPackaged) {
      // update feed = GitHub Releases latest.yml; silent offline failure is fine
      try {
        const { autoUpdater } = await import('electron-updater')
        autoUpdater.autoDownload = true
        void autoUpdater.checkForUpdatesAndNotify().catch(() => {})
      } catch {
        /* updater is optional */
      }
    }
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
