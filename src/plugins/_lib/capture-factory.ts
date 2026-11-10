import fs from 'node:fs'
import path from 'node:path'
import type { MemorySQLPlugin, PluginContext } from '../../main/core/plugin-host'
import type { CaptureStatus, RawSession } from '../../shared/types'
import type { IngestService } from '../core-schema/ingest'
import { failureDetail, healthFrom } from './capture-health.ts'

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
  /**
   * DB-backed adapters: collect only what changed since `sinceMs` (epoch ms).
   * `watermark` is the newest timestamp this collection covered — return null
   * when the source can't be filtered safely (then the watermark is left alone).
   */
  collectSince?: (
    sourceRoot: string,
    sinceMs: number
  ) => { sessions: RawSession[]; watermark: number | null }
  /** whether the source exists at all (drives "未检测到" in the UI) */
  sourceExists?: (sourceRoot: string) => boolean
  /** dirs to watch; defaults to [sourceRoot] (db-backed adapters watch the db folder).
   * A function is resolved at watcher start (with the effective sourceRoot) so
   * late-created stores and twin roots are picked up. */
  watchPaths?: string[] | ((sourceRoot: string) => string[])
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
    lastError: null,
    health: 'unknown',
    consecutiveFailures: 0,
    lastFailureAt: null,
    lastFailureDetail: null,
    lastSuccessAt: null
  }
  const runtime: { start?: () => void } = {}

  const plugin: MemorySQLPlugin = {
    manifest: {
      id: spec.id,
      name: spec.name,
      version: '0.1.0',
      requires: ['core-schema']
    },

    /**
     * 没有显式 `plugin.<id>.enabled` 时的默认值:源存在才启用。
     * 这样没装某家 agent 的机器上,它不会亮着、也不会挂 watcher;
     * 用户手动开关过的一律以设置为准(宿主优先读显式值)。
     */
    isAvailable: (settings) => {
      const configured = settings.get<string | undefined>(`${spec.id}:sourceRoot`, undefined)
      const root = configured && fs.existsSync(configured) ? configured : spec.defaultRoot
      try {
        return spec.sourceExists ? spec.sourceExists(root) : fs.existsSync(root)
      } catch {
        return true // 探测异常不关插件
      }
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

      /**
       * collect (incrementally once a watermark exists) + the watermark this run covers.
       *
       * `full` 表示这次没用增量水位、把源完整读了一遍 —— 用于一次性回填。
       * 起因:某些字段是后加的(例如子代理会话标记),而增量扫描只重读
       * `time_updated > watermark` 的会话,老会话内容没变就永远不会被重新解析,
       * 新字段永远是默认值。所以每个适配器允许有一次强制全量重扫。
       */
      const collectWithWatermark = (): { sessions: RawSession[]; next: number | null; full: boolean } => {
        const watermark = spec.collectSince ? Number(ctx.settings.get('scanWatermark', 0)) || 0 : 0
        const backfilled = ctx.settings.get<boolean>('fullScanDone', false)
        if (spec.collectSince && watermark > 0 && backfilled) {
          const r = spec.collectSince(sourceRoot, watermark)
          return { sessions: r.sessions, next: r.watermark, full: false }
        }
        const sessions = spec.collect(sourceRoot)
        if (!spec.collectSince) return { sessions, next: null, full: true }
        let maxEnded = 0
        for (const s of sessions) if ((s.endedAt ?? 0) > maxEnded) maxEnded = s.endedAt ?? 0
        return { sessions, next: maxEnded > 0 ? maxEnded * 1000 : null, full: true }
      }

      /** 入库成功后才推进水位(失败则下次重读);秒级时间戳*1000 只会低估、不会漏读 */
      const commitWatermark = (next: number | null): void => {
        if (next === null) return
        const current = Number(ctx.settings.get('scanWatermark', 0)) || 0
        if (next > current) ctx.settings.set('scanWatermark', next)
      }

      const scan = async (): Promise<CaptureStatus> => {
        try {
          const { sessions, next, full } = collectWithWatermark()
          const res = await ctx.services.use<IngestService>('ingest').ingestSessions(sessions)
          commitWatermark(next)
          // 完整读过一遍才允许进入纯增量模式(见 collectWithWatermark 注释)
          if (full && !ctx.settings.get<boolean>('fullScanDone', false)) {
            ctx.settings.set('fullScanDone', true)
          }
          lastStatus = {
            ...lastStatus,
            available: true,
            sessionsFound: res.scanned,
            sessionsImported: res.imported + res.updated,
            lastScanAt: Date.now(),
            lastError: null,
            // a full scan that completes is proof the format is still readable
            health: 'healthy',
            consecutiveFailures: 0,
            lastSuccessAt: Date.now()
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
          const resolved =
            typeof spec.watchPaths === 'function' ? spec.watchPaths(sourceRoot) : spec.watchPaths
          // explicit empty list = "nothing to watch yet" (don't fall back to home)
          if (resolved && resolved.length === 0) {
            ctx.log.info('watchPaths empty, watcher deferred until source appears')
            return
          }
          const dirs = resolved && resolved.length > 0 ? resolved : [sourceRoot]
          const rescan = watchSpec.rescan === true
          // rescan plugins re-parse the whole store, so a single burst of
          // events (db + -wal + -shm in one debounce window) must not run the
          // parse N times back-to-back. Coalesce into one run plus at most one
          // follow-up for events that landed while it was running.
          let rescanInFlight = false
          let rescanQueued = false

          const runIncremental = async (changed: string): Promise<void> => {
            try {
              let sessions: RawSession[]
              let next: number | null = null
              if (rescan) {
                const r = collectWithWatermark()
                sessions = r.sessions
                next = r.next
              } else if (watchSpec.parseFile) {
                sessions = watchSpec.parseFile(changed).filter(Boolean)
              } else {
                return
              }
              if (sessions.length === 0) return
              const res = await ctx.services.use<IngestService>('ingest').ingestSessions(sessions)
              commitWatermark(next)
              if (res.imported + res.updated > 0) {
                ctx.log.info(`incremental import from ${path.basename(changed)}`)
              }
              // 增量捕获成功 = 格式仍读得懂。归零失败计数,让偶发失败不累积成告警
              lastStatus = {
                ...lastStatus,
                health: healthFrom(0, true),
                consecutiveFailures: 0,
                lastSuccessAt: Date.now()
              }
            } catch (err) {
              // 增量失败必须落到状态里:过去这里只写日志,导致上游改格式后
              // 每条新会话都解析失败,而 UI 始终显示「N 条会话 / M 扫描」——
              // 静默失效的根因。
              const n = lastStatus.consecutiveFailures + 1
              lastStatus = {
                ...lastStatus,
                health: healthFrom(n, lastStatus.lastSuccessAt !== null),
                consecutiveFailures: n,
                lastFailureAt: Date.now(),
                lastFailureDetail: failureDetail(err, changed)
              }
              ctx.log.warn(`incremental parse failed (${n}x) for ${changed}:`, err)
            }
          }

          const kick = (changed: string): void => {
            if (rescan) {
              if (rescanInFlight) {
                rescanQueued = true
                return
              }
              rescanInFlight = true
            }
            void runIncremental(changed).finally(() => {
              if (!rescan) return
              rescanInFlight = false
              if (rescanQueued) {
                rescanQueued = false
                kick(changed)
              }
            })
          }

          ctx.watcher.watch(dirs, kick, { match: watchSpec.match, debounceMs: 1000 })
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
