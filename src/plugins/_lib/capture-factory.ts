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
  /** incremental watcher config; omit for db-backed adapters */
  watch?: { match: RegExp; parseFile: (file: string) => RawSession[] }
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
      const sourceRoot = ctx.settings.get('sourceRoot', spec.defaultRoot)
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
        if (spec.watch) {
          ctx.watcher.watch(
            [sourceRoot],
            (changed) => {
              void (async () => {
                try {
                  const sessions = spec.watch!.parseFile(changed).filter(Boolean)
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
            { match: spec.watch.match, debounceMs: 1000 }
          )
        }
        ctx.log.info(`watching ${sourceRoot}`)
      }
    },

    start() {
      runtime.start?.()
    }
  }

  return plugin
}
