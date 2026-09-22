import fs from 'node:fs'
import path from 'node:path'
import type { MemorySQLPlugin, PluginContext } from '../../main/core/plugin-host'
import type { CaptureStatus, RawSession } from '../../shared/types'
import type { IngestService } from '../core-schema/ingest'

/**
 * Shared skeleton for session-capture plugins: status/scanNow IPC, source
 * path override (settings key `sourceRoot`), optional incremental watcher.
 * Individual adapters only supply where to look and how to parse.
 */
export interface CaptureSpec {
  id: string
  name: string
  agentType: string
  /** default source dir (under the user's home unless absolute) */
  defaultRoot: string
  /** collect every RawSession currently on disk */
  collect: (sourceRoot: string) => RawSession[]
  /** whether the source exists at all (drives "未检测到" in the UI) */
  sourceExists?: (sourceRoot: string) => boolean
  /** dirs to watch; defaults to [sourceRoot] (db-backed adapters watch the db folder).
   * A function is resolved at watcher start so late-created stores are picked up. */
  watchPaths?: string[] | (() => string[])
  /**
   * incremental watcher config; omit for file-less adapters.
   * `rescan: true` re-runs collect() on any matching change (SQLite stores)
   * instead of parsing a single file.
   */
  watch?: { match: RegExp; parseFile?: (file: string) => RawSession[]; rescan?: boolean }
}

export function createCapturePlugin(spec: CaptureSpec): MemorySQLPlugin {
  let lastStatus: CaptureStatus = {
    pluginId: spec.id,
    agentType: spec.agentType,
    sourceRoot: '',
    available: false,
    sessionsFound: 0,
    sessionsImported: 0,
    lastScanAt: null,
    lastError: null
  }
  const runtime: { start?: () => void } = {}

  const plugin: MemorySQLPlugin = {
    manifest: {
      id: spec.id,
      name: spec.name,
      version: '0.1.0',
      requires: ['core-schema']
    },

    init(ctx: PluginContext) {
      // a configured root from another machine/install (or a since-moved dir)
      // must not wedge the adapter into "未检测到" — fall back to the default
      const configured = ctx.settings.get<string | undefined>('sourceRoot', undefined)
      const sourceRoot = configured && fs.existsSync(configured) ? configured : spec.defaultRoot
      if (sourceRoot !== configured) ctx.settings.set('sourceRoot', sourceRoot)
      const exists = spec.sourceExists
        ? spec.sourceExists(sourceRoot)
        : fs.existsSync(sourceRoot)
      lastStatus = { ...lastStatus, sourceRoot, available: exists }

      const scan = async (): Promise<CaptureStatus> => {
        try {
          const sessions = spec.collect(sourceRoot)
          const res = await ctx.services.use<IngestService>('ingest').ingestSessions(sessions)
          lastStatus = {
            ...lastStatus,
            available: true,
            sessionsFound: res.scanned,
            sessionsImported: res.imported + res.updated,
            lastScanAt: Date.now(),
            lastError: null
          }
          ctx.log.info(
            `scan ok: ${res.scanned} found, ${res.imported} imported, ${res.updated} updated, ${res.skipped} unchanged`
          )
          return lastStatus
        } catch (err) {
          lastStatus = { ...lastStatus, lastError: String(err) }
          ctx.log.error('scan failed:', err)
          return lastStatus
        }
      }

      ctx.ipc.handle('status', () => lastStatus)
      ctx.ipc.handle('scanNow', () => scan())
      ctx.ipc.handle('setSource', (payload) => {
        const { dir } = (payload ?? {}) as { dir?: string }
        const raw = (dir ?? '').trim()
        if (!raw) throw new Error('目录不能为空')
        const abs = path.resolve(raw)
        if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error('目录不存在')
        ctx.settings.set('sourceRoot', abs)
        return { sourceRoot: abs }
      })

      runtime.start = () => {
        if (!lastStatus.available) {
          ctx.log.info(`source not detected, watcher disabled: ${sourceRoot}`)
          return
        }
        const watchSpec = spec.watch
        if (watchSpec) {
          const resolved = typeof spec.watchPaths === 'function' ? spec.watchPaths() : spec.watchPaths
          // explicit empty list = "nothing to watch yet" (don't fall back to home)
          if (resolved && resolved.length === 0) {
            ctx.log.info('watchPaths empty, watcher deferred until source appears')
            return
          }
          const dirs = resolved && resolved.length > 0 ? resolved : [sourceRoot]
          const rescan = watchSpec.rescan === true
          ctx.watcher.watch(
            dirs,
            (changed) => {
              void (async () => {
                try {
                  let sessions: RawSession[]
                  if (rescan) {
                    sessions = spec.collect(sourceRoot)
                  } else if (watchSpec.parseFile) {
                    sessions = watchSpec.parseFile(changed).filter(Boolean)
                  } else {
                    return
                  }
                  if (sessions.length === 0) return
                  const res = await ctx.services.use<IngestService>('ingest').ingestSessions(sessions)
                  if (res.imported + res.updated > 0) {
                    ctx.log.info(`incremental import from ${path.basename(changed)}`)
                  }
                } catch (err) {
                  ctx.log.warn(`incremental parse failed for ${changed}:`, err)
                }
              })()
            },
            { match: watchSpec.match, debounceMs: 1000 }
          )
          ctx.log.info(`watching ${dirs.join(', ')}`)
        }
      }
    },

    start() {
      runtime.start?.()
    }
  }

  return plugin
}
