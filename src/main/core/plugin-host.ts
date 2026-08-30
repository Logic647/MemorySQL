import type Database from 'better-sqlite3'
import chokidar from 'chokidar'
import type { AppEnv } from './env'
import type { SettingsStore } from './settings'
import type { EventBus } from './event-bus'
import type { Migration } from './db'
import type { RawMessage, AgentType } from '../../shared/types'

// ---------------------------------------------------------------------------
// Public plugin API — every capability a plugin can use flows through
// PluginContext. Nothing outside this surface should be touched by plugins.
// ---------------------------------------------------------------------------

export interface PluginManifest {
  id: string
  name: string
  version: string
  /** ids of other plugins that must init before this one */
  requires?: string[]
}

export interface PluginLogger {
  info(msg: string, ...args: unknown[]): void
  warn(msg: string, ...args: unknown[]): void
  error(msg: string, ...args: unknown[]): void
}

/** Deterministic local summarizer, or an LLM-backed one later. */
export interface SummarizerProvider {
  id: string
  /** false = not usable right now (e.g. missing API key) — pipeline falls back */
  available(): boolean
  summarize(input: {
    agentType: AgentType
    cwd?: string
    messages: RawMessage[]
    currentTitle?: string
  }): Promise<{ title: string; summary: string } | null> | { title: string; summary: string } | null
}

export interface McpToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown
}

export type IpcHandler = (payload: unknown) => Promise<unknown> | unknown
export type UnwatchFn = () => void

export interface WatchOptions {
  /** file globs/extension filter, e.g. /\.(jsonl)$/i */
  match?: RegExp
  ignoreInitial?: boolean
  /** debounce window (ms) before notifying, default 500 */
  debounceMs?: number
}

export interface PluginContext {
  readonly id: string
  readonly log: PluginLogger
  /** self-contained data dir layout (db / vault / settings paths) */
  readonly env: AppEnv
  /** run this plugin's schema migrations (namespaced by plugin id) */
  readonly db: {
    migrate(migrations: Migration[]): void
    sqlite: Database.Database
  }
  readonly settings: {
    get<T>(key: string, defaultValue: T): T
    set(key: string, value: unknown): void
  }
  readonly events: EventBus
  /** register a renderer-callable handler; full channel becomes `<id>:<name>` */
  readonly ipc: {
    handle(name: string, handler: IpcHandler): void
    /** call another plugin's registered channel (plugin-to-plugin) */
    call(channel: string, payload?: unknown): Promise<unknown>
  }
  /** register an MCP tool (host aggregates; mcp-server plugin serves them) */
  readonly mcp: {
    registerTool(def: McpToolDef): void
    /** all tools registered so far (across plugins) */
    list(): McpToolDef[]
  }
  /** filesystem watcher (chokidar wrapper, path-agnostic by design) */
  readonly watcher: {
    watch(targets: string[], onChange: (changedPath: string) => void, opts?: WatchOptions): UnwatchFn
  }
  /** summarizer provider registry — first available provider wins */
  readonly summarizer: {
    registerProvider(provider: SummarizerProvider): void
    /** currently active provider (first registered & available) */
    pickActive(): SummarizerProvider | null
  }
  /** plugin-to-plugin service locator */
  readonly services: {
    provide<T>(name: string, service: T): void
    use<T>(name: string): T
  }
}

export interface MemorySQLPlugin {
  readonly manifest: PluginManifest
  init(ctx: PluginContext): Promise<void> | void
  start?(): Promise<void> | void
  stop?(): Promise<void> | void
}

// ---------------------------------------------------------------------------

interface RegisteredHandler {
  pluginId: string
  handler: IpcHandler
}

export class PluginHost {
  private plugins: MemorySQLPlugin[] = []
  private contexts = new Map<string, PluginContext>()
  private handlers = new Map<string, RegisteredHandler>()
  private mcpTools = new Map<string, McpToolDef & { pluginId: string }>()
  private summarizers: SummarizerProvider[] = []
  private services = new Map<string, { service: unknown; pluginId: string }>()
  private unwatchers: UnwatchFn[] = []
  private started = false
  /** plugins skipped due to being disabled (or depending on a disabled one) */
  private skipped: string[] = []
  private external: MemorySQLPlugin[] = []
  private loadErrorLog: string[] = []

  recordLoadError(message: string): void {
    this.loadErrorLog.push(message)
  }

  loadErrors(): string[] {
    return [...this.loadErrorLog]
  }

  externalPlugins(): MemorySQLPlugin[] {
    return this.external
  }

  constructor(
    private readonly env: AppEnv,
    private readonly db: { migrate(pluginId: string, migrations: Migration[]): void; sqlite: Database.Database },
    private readonly settings: SettingsStore,
    private readonly events: EventBus
  ) {}

  /** Register built-in plugins; external directory loading arrives in M4. */
  add(plugin: MemorySQLPlugin, external = false): void {
    if (this.started) throw new Error('PluginHost already started')
    if (this.plugins.some((p) => p.manifest.id === plugin.manifest.id)) {
      throw new Error(`Duplicate plugin id: ${plugin.manifest.id}`)
    }
    this.plugins.push(plugin)
    if (external) this.external.push(plugin)
  }

  /** Topologically sort by manifest.requires, then init + start.
   * A plugin whose init/start throws is disabled for this run (recorded as a
   * load error) instead of taking the whole app down. */
  async startAll(): Promise<void> {
    const order = this.topoSort()
    const failedInit = new Set<string>()
    for (const plugin of order) {
      const ctx = this.createContext(plugin)
      this.contexts.set(plugin.manifest.id, ctx)
      try {
        await plugin.init(ctx)
      } catch (err) {
        failedInit.add(plugin.manifest.id)
        this.loadErrorLog.push(`${plugin.manifest.id}: init 失败 — ${String(err)}`)
        console.error(`[plugin-host] init failed for ${plugin.manifest.id}:`, err)
      }
    }
    for (const plugin of order) {
      if (failedInit.has(plugin.manifest.id)) continue
      try {
        await plugin.start?.()
      } catch (err) {
        this.loadErrorLog.push(`${plugin.manifest.id}: start 失败 — ${String(err)}`)
        console.error(`[plugin-host] start failed for ${plugin.manifest.id}:`, err)
      }
    }
    this.started = true
  }

  async stopAll(): Promise<void> {
    const order = this.topoSort().reverse()
    for (const plugin of order) {
      await plugin.stop?.()
    }
    for (const un of this.unwatchers.splice(0)) un()
    this.started = false
  }

  /** Entry point for renderer invokes. Channels are `<pluginId>:<name>`. */
  async invoke(channel: string, payload?: unknown): Promise<unknown> {
    const h = this.handlers.get(channel)
    if (!h) throw new Error(`Unknown channel: ${channel}`)
    return await h.handler(payload)
  }

  listChannels(): string[] {
    return [...this.handlers.keys()]
  }

  mcpToolDefs(): Array<McpToolDef & { pluginId: string }> {
    return [...this.mcpTools.values()]
  }

  /** ids of plugins not started this run (disabled or dependency-disabled) */
  skippedPlugins(): string[] {
    return [...this.skipped]
  }

  /** Topologically sort by manifest.requires, skipping disabled plugins
   * (settings key `plugin.<id>.enabled`). Dependents of a disabled plugin
   * are disabled too (cascading). */
  private topoSort(): MemorySQLPlugin[] {
    this.skipped = []
    const isDisabled = (id: string): boolean =>
      this.settings.get(`plugin.${id}.enabled`, true as boolean) === false
    const byId = new Map(this.plugins.map((p) => [p.manifest.id, p]))
    const visited = new Set<string>()
    const skippedIds = new Set<string>()
    const visiting = new Set<string>()
    const order: MemorySQLPlugin[] = []

    const visit = (id: string): void => {
      if (visiting.has(id)) throw new Error(`Circular plugin dependency at: ${id}`)
      if (visited.has(id)) return
      visiting.add(id)
      const plugin = byId.get(id)
      if (!plugin || isDisabled(id)) {
        // absent or disabled → cascade-skips dependents
        visited.add(id)
        skippedIds.add(id)
        visiting.delete(id)
        if (isDisabled(id)) this.skipped.push(`${id} (已禁用)`)
        return
      }
      for (const dep of plugin.manifest.requires ?? []) visit(dep)
      const unmet = (plugin.manifest.requires ?? []).filter(
        (dep) => skippedIds.has(dep)
      )
      visiting.delete(id)
      visited.add(id)
      if (unmet.length > 0) {
        skippedIds.add(id)
        this.skipped.push(`${id} (依赖未启用: ${unmet.join(', ')})`)
        return
      }
      order.push(plugin)
    }
    for (const p of this.plugins) visit(p.manifest.id)
    if (this.skipped.length > 0) {
      console.warn('[plugin-host] disabled/skipped plugins:', this.skipped.join('; '))
    }
    return order
  }

  private createContext(plugin: MemorySQLPlugin): PluginContext {
    const id = plugin.manifest.id
    const log: PluginLogger = {
      info: (m, ...a) => console.info(`[${id}]`, m, ...a),
      warn: (m, ...a) => console.warn(`[${id}]`, m, ...a),
      error: (m, ...a) => console.error(`[${id}]`, m, ...a)
    }
    const watchTargets = new Set<string>()
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const host = this

    const ctx: PluginContext = {
      id,
      log,
      env: this.env,
      db: {
        migrate: (migrations) => this.db.migrate(id, migrations),
        sqlite: this.db.sqlite
      },
      settings: {
        get: <T,>(key: string, defaultValue: T) => this.settings.get(`${id}:${key}`, defaultValue),
        set: (key, value) => this.settings.set(`${id}:${key}`, value)
      },
      events: this.events,
      ipc: {
        handle: (name, handler) => {
          const channel = `${id}:${name}`
          if (this.handlers.has(channel)) throw new Error(`IPC channel already registered: ${channel}`)
          this.handlers.set(channel, { pluginId: id, handler })
        },
        call: async (channel, payload) => await this.invoke(channel, payload)
      },
      mcp: {
        registerTool: (def) => {
          // MCP tool names must match ^[a-zA-Z0-9_-]+$ — serve the raw name,
          // keep the plugin-prefixed key internally for ownership/uniqueness
          for (const existing of this.mcpTools.values()) {
            if (existing.name === def.name) {
              throw new Error(`MCP tool name already registered: ${def.name}`)
            }
          }
          this.mcpTools.set(`${id}.${def.name}`, { ...def, pluginId: id })
        },
        list: () =>
          [...this.mcpTools.values()].map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            handler: t.handler
          }))
      },
      watcher: {
        watch: (targets, onChange, opts) => {
          targets.forEach((t) => watchTargets.add(t))
          const matcher = opts?.match
          const debounceMs = opts?.debounceMs ?? 500
          let timer: NodeJS.Timeout | null = null
          let pending = new Set<string>()
          const w = chokidar.watch(targets, {
            ignoreInitial: opts?.ignoreInitial ?? true
          })
          const notify = (p: string): void => {
            // chokidar fires file events on 'add'/'change'; directories come as
            // 'addDir' which we don't subscribe to, but filter defensively.
            if (matcher && !matcher.test(p)) return
            if (watchTargets.has(p)) return
            pending.add(p)
            if (timer) clearTimeout(timer)
            timer = setTimeout(() => {
              const paths = [...pending]
              pending = new Set()
              for (const path of paths) onChange(path)
            }, debounceMs)
          }
          w.on('add', notify).on('change', notify).on('unlink', notify)
          const unwatch: UnwatchFn = () => {
            if (timer) clearTimeout(timer)
            void w.close()
            host.unwatchers = host.unwatchers.filter((u) => u !== unwatch)
          }
          this.unwatchers.push(unwatch)
          return unwatch
        }
      },
      summarizer: {
        registerProvider: (provider) => {
          this.summarizers.push(provider)
        },
        pickActive: () => this.summarizers.find((p) => p.available()) ?? null
      },
      services: {
        provide: <T,>(name: string, service: T) => {
          if (this.services.has(name)) throw new Error(`Service already provided: ${name}`)
          this.services.set(name, { service, pluginId: id })
        },
        use: <T,>(name: string) => {
          const entry = this.services.get(name)
          if (!entry) throw new Error(`Service not available (check manifest.requires): ${name}`)
          return entry.service as T
        }
      }
    }
    return ctx
  }

  /** Pick the first available summarizer provider (registration order). */
  activeSummarizer(): SummarizerProvider | null {
    return this.summarizers.find((p) => p.available()) ?? null
  }
}
