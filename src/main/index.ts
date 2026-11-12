import { app, BrowserWindow, ipcMain, nativeTheme, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveAppEnv, defaultDataDir } from './core/env'
import { withinRoot } from './core/safe-path'
import {
  DISPATCH,
  EXPORT_ARCHIVE_DEST,
  GENERATE_DEVLOG,
  HEADLESS_SCAN,
  LAUNCH_HIDDEN,
  RUN_DIGEST,
  SEMANTIC_REINDEX,
  SYNC_FOLDER
} from './core/cli-args'
import { connectAgent, agentSnippet } from './core/agent-connect'
import { resolveRulesTargets, writeRules } from './core/rules-writer'
import { AGENT_BY_ID } from '../shared/upstream-agents'
import {
  THEME_KEY,
  normalizeThemeSetting,
  resolveTheme,
  themeBackground,
  titleBarColors
} from './core/theme'
import type { ResolvedTheme, ThemeSetting, ThemeState } from './core/theme'
import { SettingsStore } from './core/settings'
import { EventBus } from './core/event-bus'
import { Db } from './core/db'
import { PluginHost } from './core/plugin-host'
import summarizerRules from '../plugins/summarizer-rules'
import summarizerLlm from '../plugins/summarizer-llm'
import coreSchema from '../plugins/core-schema'
import coreLauncher from '../plugins/core-launcher'
import captureCodex from '../plugins/capture-codex'
import captureZcode from '../plugins/capture-zcode'
import captureHermes from '../plugins/capture-hermes'
import captureClaudecode from '../plugins/capture-claudecode'
import captureQwencode from '../plugins/capture-qwencode'
import captureKimicli from '../plugins/capture-kimicli'
import captureCodebuddy from '../plugins/capture-codebuddy'
import captureWorkbuddy from '../plugins/capture-workbuddy'
import captureQoder from '../plugins/capture-qoder'
import captureGemini from '../plugins/capture-gemini'
import captureCursor from '../plugins/capture-cursor'
import captureOpencode from '../plugins/capture-opencode'
import captureDsh from '../plugins/capture-dsh'
import captureGoose from '../plugins/capture-goose'
import captureDroid from '../plugins/capture-droid'
import captureCline from '../plugins/capture-cline'
import capturePi from '../plugins/capture-pi'
import captureOmp from '../plugins/capture-omp'
import captureOmo from '../plugins/capture-omo'
import captureGrok from '../plugins/capture-grok'
import captureMinimax from '../plugins/capture-minimax'
import captureDeveco from '../plugins/capture-deveco'
import captureMimocode from '../plugins/capture-mimocode'
import captureCopilot from '../plugins/capture-copilot'
import mcpServer from '../plugins/mcp-server'
import privacyExport from '../plugins/privacy-export'
import syncArchive from '../plugins/sync-archive'
import memoryCore from '../plugins/memory-core'
import memoryDispatch from '../plugins/memory-dispatch'
import syncFolder from '../plugins/sync-folder'
import projectDevlog from '../plugins/project-devlog'
import projectDigest from '../plugins/project-digest'
import memoryCurator from '../plugins/memory-curator'
import semanticSearch from '../plugins/semantic-search'
import captureWatcher from '../plugins/capture-watcher'
import importChat from '../plugins/import-chat'
import type { MemorySQLPlugin } from './core/plugin-host'
import { BUILTIN_PLUGIN_IDS } from '../shared/builtin-plugins'
import { setupSpotlight, type SpotlightController } from './spotlight'
import {
  applyUpdaterEvent,
  probeGitHubRelease,
  type UpdaterState
} from './core/update-check'

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
  coreLauncher,
  captureCodex,
  captureZcode,
  captureHermes,
  captureClaudecode,
  captureQwencode,
  captureKimicli,
  captureCodebuddy,
  captureWorkbuddy,
  captureQoder,
  captureGemini,
  captureCursor,
  captureOpencode,
  captureDsh,
  captureGoose,
  captureDroid,
  captureCline,
  capturePi,
  captureOmp,
  captureOmo,
  captureGrok,
  captureMinimax,
  captureDeveco,
  captureMimocode,
  captureCopilot,
  captureWatcher,
  importChat,
  mcpServer,
  privacyExport,
  syncArchive,
  memoryCore,
  memoryDispatch,
  syncFolder,
  projectDevlog,
  projectDigest,
  memoryCurator,
  semanticSearch
]

// shared/builtin-plugins.ts 是设置页分组与单测的对齐基准;启动时核对一次,
// 不一致只报日志(开发期可见),避免两份清单悄悄漂移
{
  const ids = BUILTIN_PLUGINS.map((p) => p.manifest.id).sort().join(',')
  const want = [...BUILTIN_PLUGIN_IDS].sort().join(',')
  if (ids !== want) {
    console.error('[plugins] BUILTIN_PLUGINS 与 shared/builtin-plugins.ts 不一致:\n  main  :', ids, '\n  shared:', want)
  }
}

// 命令行参数解析集中在 core/cli-args(路径类参数在那里做存在性校验)

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

async function bootstrap(opts: { deferStart?: boolean } = {}): Promise<{
  host: PluginHost
  db: Db
  events: EventBus
  settings: SettingsStore
  env: ReturnType<typeof resolveAppEnv>
}> {
  const env = resolveAppEnv()
  processPendingImport(env.dataDir, env.dbPath, env.vaultDir)
  const settings = new SettingsStore(env)
  activeSettings = settings
  // 主题必须在建窗口之前定好:窗口底色/标题栏用的是解析后的值,
  // 晚一步就会先闪一帧深色(浅色主题下尤其明显)
  nativeTheme.themeSource = normalizeThemeSetting(settings.get(THEME_KEY, 'system'))
  const db = new Db(env.dbPath)
  const events = new EventBus()
  const host = new PluginHost(env, db, settings, events)
  for (const p of BUILTIN_PLUGINS) host.add(p)
  await loadExternalPlugins(env.dataDir, host)
  // init 只注册 IPC/服务(渲染层首帧要用);start 才建 watcher/HTTP 监听,
  // GUI 路径把它推到窗口创建之后再跑(headless 仍在这里跑完)
  await host.initAll()
  if (!opts.deferStart) await host.startAll()
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
  if (RUN_DIGEST) {
    try {
      // 显式 CLI 执行 = 用户意图:绕过 project-digest:enabled 总开关
      results['digest'] = await host.invoke('project-digest:runAll')
    } catch (err) {
      results['digest'] = { error: String(err) }
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
    // 插件目录名来自 readdir,仍显式校验边界:任何越界项直接跳过
    const dir = withinRoot(root, path.join(root, entry.name), '外部插件目录')
    try {
      const manifestPath = withinRoot(dir, path.join(dir, 'manifest.json'), '插件清单')
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
        id?: string
        name?: string
        version?: string
        main?: string
      }
      if (!manifest.id || !/^[a-z0-9_-]+$/.test(manifest.id)) throw new Error('manifest.id 缺失或非法')
      if (!manifest.name || !manifest.version) throw new Error('manifest.name / version 缺失')
      const mainFile = withinRoot(dir, path.resolve(dir, manifest.main ?? 'main.js'), '插件入口')
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

/** live updater state, surfaced to the renderer via memorysql:host:updateStatus
 * and the push:update-status event — the OS toast from electron-updater is
 * easy to miss, so the app shell + Settings page render this instead. */
let updaterState: UpdaterState = {}

function setUpdater(ev: Parameters<typeof applyUpdaterEvent>[1]): void {
  updaterState = applyUpdaterEvent(updaterState, ev)
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('push:update-status', { ...updaterState })
  }
}

type AppUpdater = (typeof import('electron-updater'))['autoUpdater']

/**
 * electron-updater's CJS entry defines every export via
 * `Object.defineProperty(exports, name, { get })` — a shape Node's
 * cjs-module-lexer cannot detect, so the ESM namespace has NO named exports
 * and `const { autoUpdater } = await import('electron-updater')` yields
 * undefined (the updater actually lives on `default`, i.e. module.exports).
 */
async function loadUpdater(): Promise<AppUpdater> {
  const mod = (await import('electron-updater')) as unknown as {
    autoUpdater?: AppUpdater
    default?: { autoUpdater?: AppUpdater }
  }
  const au = mod.autoUpdater ?? mod.default?.autoUpdater
  if (!au) throw new Error('electron-updater 模块加载异常')
  return au
}

let autoUpdaterWired: AppUpdater | null = null
/** bootstrap 创建的 SettingsStore(updater 需要读 `updater:feed`) */
let activeSettings: SettingsStore | null = null

/**
 * 更新包下载源:默认就是 GitHub(电子更新器读打包时写入的 app-update.yml,
 * 也就是 electron-builder 的 publish 配置)。
 *
 * 2026-11-10 曾试过改成阿里云镜像(`watch.logic-yjb.top/updates`),实测
 * **下载速度反而更慢**(ECS 带宽中转),用户要求换回 GitHub —— 镜像路由保留在
 * tools/upstream-watch/server.mjs 里备查,但客户端不再默认使用。
 *
 * 设置键 `updater:feed` 仍可显式指定一个 generic 镜像地址(自建代理时用);
 * 自定义地址失败会自动回退 GitHub provider,不让更新彻底失联。
 */
function updaterFeedUrl(): string | null {
  const raw = activeSettings?.get<unknown>('updater:feed', undefined)
  if (typeof raw === 'string' && /^https?:\/\//.test(raw)) return raw.replace(/\/+$/, '')
  return null
}

/** 自定义 feed(若配置)失败时回退 GitHub provider;默认直接走 GitHub。 */
async function checkWithFeed(au: AppUpdater, feed: string | null): Promise<unknown> {
  if (feed) {
    try {
      au.setFeedURL({ provider: 'generic', url: feed })
      return await au.checkForUpdates()
    } catch (err) {
      setUpdater({
        type: 'error',
        message: `自定义更新源检查失败,回退 GitHub:${String(err instanceof Error ? err.message : err)}`
      })
      au.setFeedURL({ provider: 'github', owner: 'Logic647', repo: 'MemorySQL' })
    }
  }
  return await au.checkForUpdates()
}

function wireAutoUpdater(au: AppUpdater): void {
  if (autoUpdaterWired) return
  autoUpdaterWired = au
  // 0.7.5 起:发现新版只提示,由用户点「下载更新」再下(autoDownload=false)。
  au.autoDownload = false
  au.on('update-available', (info: { version?: string }) => {
    setUpdater({ type: 'available', version: info?.version })
  })
  au.on('update-not-available', (info: { version?: string }) => {
    setUpdater({ type: 'not-available', version: info?.version })
  })
  au.on('download-progress', (p: { percent?: number; transferred?: number; total?: number }) => {
    setUpdater({
      type: 'progress',
      percent: Number(p?.percent ?? 0),
      transferred: Number(p?.transferred ?? 0),
      total: Number(p?.total ?? 0)
    })
  })
  au.on('update-downloaded', (info: { version?: string }) => {
    setUpdater({ type: 'downloaded', version: info?.version })
  })
  au.on('error', (err: Error) => {
    setUpdater({ type: 'error', message: String(err?.message ?? err) })
  })
}

/**
 * Startup check: availability through api.github.com (reliable route),
 * download through electron-updater once a newer release is confirmed.
 * Every failure lands in updaterState instead of a swallowed promise.
 */
async function startupUpdateCheck(): Promise<void> {
  let probeOk = false
  try {
    const r = await probeGitHubRelease(app.getVersion())
    if (r.available) setUpdater({ type: 'probe-available', version: r.version ?? '' })
    else setUpdater({ type: 'probe-not-available' })
    probeOk = true
  } catch (err) {
    setUpdater({ type: 'probe-error', message: String(err instanceof Error ? err.message : err) })
  }
  try {
    const au = await loadUpdater()
    wireAutoUpdater(au)
    // only pay the github.com/downloads route when there is something to fetch;
    // a probe failure still tries it as the fallback availability source
    if (!probeOk || updaterState.available) {
      await checkWithFeed(au, updaterFeedUrl())
    }
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err)
    // probe-confirmed availability is kept by the reducer; this only surfaces
    // the download-path failure (or a cold check failure when probe also failed)
    setUpdater({ type: 'error', message: msg })
  }
}

/** 当前解析后的主题(nativeTheme 已按 themeSource 计算系统偏好) */
function currentResolvedTheme(setting: ThemeSetting): ResolvedTheme {
  return resolveTheme(setting, nativeTheme.shouldUseDarkColors)
}

/** 把主题应用到单个窗口:底色防闪 + Windows 标题栏覆盖层配色 */
function applyWindowTheme(win: BrowserWindow, theme: ResolvedTheme): void {
  if (win.isDestroyed()) return
  try {
    win.setBackgroundColor(themeBackground(theme))
  } catch {
    // 某些平台/窗口状态下不支持;底色只是防闪,失败不影响功能
  }
  if (process.platform === 'linux') return // Linux 无 WCO 覆盖层
  try {
    win.setTitleBarOverlay({ ...titleBarColors(theme), height: 46 })
  } catch {
    // 非 WCO 窗口会抛;忽略
  }
}

/** 主题的当前状态(设置值 + 解析后的实际主题) */
function currentThemeState(settings: SettingsStore): ThemeState {
  const setting = normalizeThemeSetting(settings.get(THEME_KEY, 'system'))
  return { setting, effective: currentResolvedTheme(setting) }
}

/** 把主题同步给所有窗口:窗口底色/标题栏 + 渲染层 data-theme */
function broadcastTheme(state: ThemeState): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue
    applyWindowTheme(w, state.effective)
    try {
      w.webContents.send('push:theme', state)
    } catch {
      // 窗口正在销毁:忽略
    }
  }
}

function registerHostChannels(
  host: PluginHost,
  settings: SettingsStore,
  env: ReturnType<typeof resolveAppEnv>,
  db: Db,
  spotlight: SpotlightController
): void {
  // 外观主题:主进程是真相源(nativeTheme),渲染层只负责把结果写到
  // <html data-theme>。读 = 返回当前值;写 = 落盘 + 立即广播给所有窗口。
  hostChannels.set('memorysql:host:theme', (payload) => {
    const { theme } = (payload ?? {}) as { theme?: unknown }
    if (theme === undefined) return currentThemeState(settings)
    const setting = normalizeThemeSetting(theme)
    settings.set(THEME_KEY, setting)
    nativeTheme.themeSource = setting
    const state: ThemeState = { setting, effective: currentResolvedTheme(setting) }
    broadcastTheme(state)
    return state
  })
  hostChannels.set('memorysql:host:plugins', () => ({
    plugins: [
      ...BUILTIN_PLUGINS.map((p) => ({
        id: p.manifest.id,
        name: p.manifest.name,
        version: p.manifest.version,
        // 生效值:显式设置 > 插件的 isAvailable 探测(捕获类没源时默认关)
        enabled: host.isPluginEnabled(p.manifest.id),
        external: false
      })),
      ...host.externalPlugins().map((p) => ({
        id: p.manifest.id,
        name: p.manifest.name,
        version: p.manifest.version,
        enabled: host.isPluginEnabled(p.manifest.id),
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
  // 「写入使用规则」:往 agent 认的规则文件里追加带标记的工作协议(幂等,可逆)。
  // 目标路径由台账 rules 字段决定(金丝雀/源码/官方文档测定过,不许猜)。
  hostChannels.set('memorysql:host:rulesTargets', (payload) => {
    const { agent, projectDir } = (payload ?? {}) as { agent?: string; projectDir?: string }
    const entry = agent ? AGENT_BY_ID.get(String(agent)) : undefined
    if (!entry?.rules) throw new Error(`agent 不支持或未登记规则文件: ${agent}`)
    return resolveRulesTargets(entry.id, entry.rules, { projectDir })
  })
  hostChannels.set('memorysql:host:rulesWrite', (payload) => {
    const { agent, projectDir } = (payload ?? {}) as { agent?: string; projectDir?: string }
    const entry = agent ? AGENT_BY_ID.get(String(agent)) : undefined
    if (!entry?.rules) throw new Error(`agent 不支持或未登记规则文件: ${agent}`)
    return writeRules(entry.id, entry.rules, { projectDir })
  })
  // 连接向导:一键为检测到的 agent 写入 MCP 配置(幂等,写入前备份)
  hostChannels.set('memorysql:host:agentConnect', (payload) => {    const { agent } = (payload ?? {}) as { agent?: string }
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
    // availability goes through the api.github.com releases endpoint (same
    // feed the changelog uses) — the updater's own check fetches latest.yml
    // from github.com/downloads, a different, frequently blocked route
    try {
      const r = await probeGitHubRelease(app.getVersion())
      if (r.available) {
        setUpdater({ type: 'probe-available', version: r.version ?? '' })
        // 只确认可用性;下载由用户点「下载更新」触发(autoDownload=false)
        try {
          const au = await loadUpdater()
          wireAutoUpdater(au)
          await checkWithFeed(au, updaterFeedUrl())
        } catch {
          /* probe already confirmed; electron-updater path is best-effort */
        }
        return { available: true, version: r.version }
      }
      setUpdater({ type: 'probe-not-available' })
      return { available: false, reason: '已是最新版本' }
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err)
      setUpdater({ type: 'probe-error', message })
      return { available: false, reason: `检查失败: ${message}` }
    }
  })
  hostChannels.set('memorysql:host:updateNow', async () => {
    if (!app.isPackaged) throw new Error('开发模式不支持')
    // 连点两次会并发触发两轮 check+download(electron-updater 会报 download 进行中)
    if (updaterState.downloading) return { ok: true, downloading: true }
    try {
      const autoUpdater = await loadUpdater()
      wireAutoUpdater(autoUpdater)
      // autoDownload=false → 先 check 拿 updateInfo,再显式 downloadUpdate。
      // 进度/完成继续走 push:update-status;完成后再由用户确认安装。
      const r = (await checkWithFeed(autoUpdater, updaterFeedUrl())) as
        | {
            updateInfo?: unknown
            isUpdateAvailable?: boolean
            downloadPromise?: Promise<unknown> | null
          }
        | undefined
      // 探测(api.github.com)可能早于更新源的 latest.yml 同步。此时 check 的结果是
      // «没有可用更新»,硬调 downloadUpdate 会抛 "Please check update first"。
      if (r && r.isUpdateAvailable === false) {
        const message = '更新源尚未同步到该版本,请稍后再试(或稍后重启应用)'
        setUpdater({ type: 'error', message })
        return { ok: false, reason: message }
      }
      setUpdater({ type: 'download-start' })
      if (r?.downloadPromise) {
        void r.downloadPromise.catch(() => {})
      } else {
        void autoUpdater.downloadUpdate().catch((err: unknown) => {
          setUpdater({ type: 'error', message: String(err instanceof Error ? err.message : err) })
        })
      }
      return { ok: true, downloading: true }
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err)
      setUpdater({ type: 'error', message })
      throw err
    }
  })
  hostChannels.set('memorysql:host:updateInstallNow', async () => {
    if (!app.isPackaged) throw new Error('开发模式不支持')
    const autoUpdater = await loadUpdater()
    // quitAndInstall tears down the app synchronously — answer the IPC first
    setImmediate(() => autoUpdater.quitAndInstall())
    return { ok: true, installing: true }
  })
  hostChannels.set('memorysql:host:updateStatus', () => ({ ...updaterState }))
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

function createWindow(host: PluginHost, events: EventBus, settings: SettingsStore): BrowserWindow {
  const theme = currentResolvedTheme(normalizeThemeSetting(settings.get(THEME_KEY, 'system')))
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    // --hidden (login item): stay in the tray only; tray click / hotkey shows
    show: !LAUNCH_HIDDEN,
    title: 'MemorySQL',
    icon: path.join(app.getAppPath(), 'build', 'icon.png'),
    backgroundColor: themeBackground(theme),
    autoHideMenuBar: true,
    // integrated title bar: native white strip removed; system window
    // controls overlay the dark topbar instead (Windows / macOS only; Linux window
    // managers typically do not support WCO and titleBarStyle: 'hidden' leaves the
    // window frameless without controls or draggable caption)
    ...(process.platform === 'linux'
      ? {}
      : {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: { ...titleBarColors(theme), height: 46 }
        }),
    webPreferences: {
      preload: withinRoot(
        path.dirname(import.meta.dirname),
        path.join(path.dirname(import.meta.dirname), 'preload', 'index.cjs'),
        '预加载脚本'
      ),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })

  events.on('sessions:changed', () => {
    if (!win.isDestroyed()) win.webContents.send('push:sessions:changed')
  })

  // project-digest 状态推送:总结开始/完成时刷新会话页的项目徽标
  events.on('digest:changed', (...args: unknown[]) => {
    if (!win.isDestroyed()) win.webContents.send('push:digest', args[0] ?? null)
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
      RUN_DIGEST ||
      SEMANTIC_REINDEX
    ) {
      await runHeadlessScan()
      return
    }
    // GUI mode is single-instance: a second launch would double the memory and
    // fight over the MCP port — focus the existing window instead. Headless
    // runs (--scan/--sync/…) intentionally bypass the lock so they can run
    // alongside a live app.
    if (!app.requestSingleInstanceLock()) {
      app.exit(0)
      return
    }
    app.on('second-instance', () => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (w.isMinimized()) w.restore()
        w.show()
        w.focus()
      }
    })
    const boot = await bootstrap({ deferStart: true })
    running = { host: boot.host, db: boot.db }
    const win = createWindow(boot.host, boot.events, boot.settings)
    const spotlight = setupSpotlight({ win, settings: boot.settings })
    registerHostChannels(boot.host, boot.settings, boot.env, boot.db, spotlight)
    // 系统主题变化(设置=跟随系统时)以及任何外部改动,统一走同一条广播
    nativeTheme.on('updated', () => broadcastTheme(currentThemeState(boot.settings)))
    // 插件 start 阶段(watcher / MCP 监听 / 语义栈)推迟到窗口创建之后:
    // 实测它们串行起来要 300-500ms(其中 ~/.gemini 全树 chokidar 377ms),
    // 而窗口与首帧只需要 init 阶段注册好的 IPC 通道。
    void boot.host.startAll().catch((err) => {
      console.error('[bootstrap] plugin start failed:', err)
    })
    // Startup capture scan: sessions written while the app was off should show
    // up on launch, not only after a manual 立即扫描.
    //
    // It must not compete with the first paint: each adapter parses its whole
    // store synchronously (measured ≈1.5 s for 5 enabled adapters), so starting
    // it right away pushed the renderer's initial sessions:list IPC behind it
    // and the window sat on a "no sessions" state. Wait for the renderer to
    // finish loading, give it a beat to issue its first queries, then scan
    // piecewise with an event-loop yield between adapters.
    let startupScanStarted = false
    const startStartupScan = (): void => {
      if (startupScanStarted) return
      startupScanStarted = true
      void (async () => {
        try {
          const channels = new Set(boot.host.listChannels())
          for (const p of BUILTIN_PLUGINS.filter((x) => x.manifest.id.startsWith('capture-'))) {
            const channel = `${p.manifest.id}:scanNow`
            if (!channels.has(channel)) continue
            try {
              await boot.host.invoke(channel)
            } catch {
              /* per-plugin failure is non-fatal */
            }
            // yield between adapters so IPC/paint can interleave with the scan
            await new Promise<void>((resolve) => setImmediate(resolve))
          }
        } catch {
          /* scan is best-effort */
        }
      })()
    }
    win.webContents.once('did-finish-load', () => {
      setTimeout(startStartupScan, 2000).unref?.()
    })
    // fallback: a window that never reports load (headless/hidden start) must
    // still pick up offline sessions
    setTimeout(startStartupScan, 15000).unref?.()
    app.once('will-quit', () => spotlight.dispose())
    if (app.isPackaged) {
      void startupUpdateCheck().catch((err) => {
        setUpdater({
          type: 'probe-error',
          message: String(err instanceof Error ? err.message : err)
        })
      })
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
