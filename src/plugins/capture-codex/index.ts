import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { MemorySQLPlugin } from '../../main/core/plugin-host'
import type { CaptureStatus, RawSession } from '../../shared/types'
import type { IngestService } from '../core-schema/ingest'
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
  lastError: null
}

const plugin: MemorySQLPlugin = {
  manifest: {
    id: 'capture-codex',
    name: 'Capture: Codex CLI',
    version: '0.1.0',
    requires: ['core-schema']
  },

  init(ctx) {
    const sourceRoot = ctx.settings.get(
      'sourceRoot',
      path.join(os.homedir(), '.codex', 'sessions')
    )
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
        for (const f of files) {
          try {
            const s = parseFile(f)
            if (s) sessions.push(s)
          } catch (err) {
            ctx.log.warn(`failed to parse ${f}:`, err)
          }
        }
        const res = await ingest.ingestSessions(sessions)
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
            } catch (err) {
              ctx.log.warn(`incremental parse failed for ${changed}:`, err)
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
