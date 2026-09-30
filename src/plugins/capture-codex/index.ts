import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { MemorySQLPlugin } from '../../main/core/plugin-host'
import type { CaptureStatus, RawSession } from '../../shared/types'
import type { IngestService } from '../core-schema/ingest'
import { failureDetail, healthFrom } from '../_lib/capture-health'
import { findCodexRollouts, parseCodexRollout } from './codex-parser'

const JSONL_RE = /\.jsonl$/i

// single built-in instance state
let lastStatus: CaptureStatus = {
  pluginId: 'capture-codex',
  agentType: 'codex',
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

const plugin: MemorySQLPlugin = {
  manifest: {
    id: 'capture-codex',
    name: 'Capture: Codex CLI',
    version: '0.1.0',
    requires: ['core-schema']
  },

  init(ctx) {
    // a configured root recorded on another machine must not wedge detection
    const configured = ctx.settings.get<string | undefined>('sourceRoot', undefined)
    const defaultRoot = path.join(os.homedir(), '.codex', 'sessions')
    const sourceRoot = configured && fs.existsSync(configured) ? configured : defaultRoot
    if (sourceRoot !== configured) ctx.settings.set('sourceRoot', sourceRoot)
    lastStatus = { ...lastStatus, sourceRoot, available: fs.existsSync(sourceRoot) }

    const parseFile = (filePath: string): RawSession | null => {
      const text = fs.readFileSync(filePath, 'utf-8')
      return parseCodexRollout(filePath, text)
    }

    const scan = async (): Promise<CaptureStatus> => {
      try {
        const files = findCodexRollouts(sourceRoot)
        const ingest = ctx.services.use<IngestService>('ingest')
        const sessions: RawSession[] = []
        const parseFailures: string[] = []
        for (const f of files) {
          try {
            const s = parseFile(f)
            if (s) sessions.push(s)
          } catch (err) {
            // 单文件解析失败 = 上游格式漂移的信号,不能只写日志
            parseFailures.push(failureDetail(err, f))
            ctx.log.warn(`failed to parse ${f}:`, err)
          }
        }
        const res = await ingest.ingestSessions(sessions)
        const allFailed = parseFailures.length > 0 && sessions.length === 0
        const n = lastStatus.consecutiveFailures + (allFailed ? 1 : 0)
        lastStatus = {
          ...lastStatus,
          available: true,
          sessionsFound: res.scanned,
          sessionsImported: res.imported + res.updated,
          lastScanAt: Date.now(),
          lastError: null,
          health: allFailed ? healthFrom(n, lastStatus.lastSuccessAt !== null) : 'healthy',
          consecutiveFailures: allFailed ? n : 0,
          lastFailureAt: allFailed ? Date.now() : lastStatus.lastFailureAt,
          lastFailureDetail: allFailed
            ? (parseFailures[0] ?? '未知错误')
            : parseFailures.length > 0
              ? `部分文件解析失败: ${parseFailures.join('; ')}`
              : lastStatus.lastFailureDetail,
          lastSuccessAt: allFailed ? lastStatus.lastSuccessAt : Date.now()
        }
        if (allFailed) {
          ctx.log.error('all codex rollouts failed to parse — 疑似上游改了格式')
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

    codexRuntime.start = () => {
      if (!lastStatus.available) {
        ctx.log.warn(`source root missing, watcher disabled: ${sourceRoot}`)
        return
      }
      ctx.watcher.watch(
        [sourceRoot],
        (changed) => {
          void (async () => {
            try {
              const s = parseFile(changed)
              if (s) {
                const res = await ctx.services.use<IngestService>('ingest').ingestSessions([s])
                if (res.imported + res.updated > 0) {
                  ctx.log.info(`incremental import from ${path.basename(changed)}`)
                }
              }
              lastStatus = {
                ...lastStatus,
                health: healthFrom(0, true),
                consecutiveFailures: 0,
                lastSuccessAt: Date.now()
              }
            } catch (err) {
              // 同 capture-factory:增量失败必须落到状态,不能只写日志
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
          })()
        },
        { match: JSONL_RE, debounceMs: 1000 }
      )
      ctx.log.info(`watching ${sourceRoot}`)
    }
  },

  start() {
    codexRuntime.start?.()
  }
}

/** lets init() wire start()-time behavior without mutating the plugin object */
const codexRuntime: { start?: () => void } = {}

export default plugin
