import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { MemorySQLPlugin } from '../../main/core/plugin-host'
import type { CaptureStatus, RawSession } from '../../shared/types'
import type { IngestService } from '../core-schema/ingest'
import { findZcodeRollouts, parseZcodeRollout } from './zcode-parser'

const JSONL_RE = /\.jsonl$/i

let lastStatus: CaptureStatus = {
  pluginId: 'capture-zcode',
  agentType: 'zcode',
  sourceRoot: '',
  available: false,
  sessionsFound: 0,
  sessionsImported: 0,
  lastScanAt: null,
  lastError: null
}

const zcodeRuntime: { start?: () => void } = {}

const plugin: MemorySQLPlugin = {
  manifest: {
    id: 'capture-zcode',
    name: 'Capture: ZCode',
    version: '0.1.0',
    requires: ['core-schema']
  },

  init(ctx) {
    const sourceRoot = ctx.settings.get(
      'sourceRoot',
      path.join(os.homedir(), '.zcode', 'cli', 'rollout')
    )
    lastStatus = { ...lastStatus, sourceRoot, available: fs.existsSync(sourceRoot) }

    const parseFile = (filePath: string): RawSession[] => {
      const text = fs.readFileSync(filePath, 'utf-8')
      return parseZcodeRollout(filePath, text)
    }

    const scan = (): CaptureStatus => {
      try {
        const files = findZcodeRollouts(sourceRoot)
        const ingest = ctx.services.use<IngestService>('ingest')
        const sessions: RawSession[] = []
        for (const f of files) {
          try {
            sessions.push(...parseFile(f))
          } catch (err) {
            ctx.log.warn(`failed to parse ${f}:`, err)
          }
        }
        const res = ingest.ingestSessions(sessions)
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

    zcodeRuntime.start = () => {
      if (!lastStatus.available) {
        ctx.log.warn(`source root missing, watcher disabled: ${sourceRoot}`)
        return
      }
      ctx.watcher.watch(
        [sourceRoot],
        (changed) => {
          try {
            const sessions = parseFile(changed)
            const res = ctx.services.use<IngestService>('ingest').ingestSessions(sessions)
            if (res.imported + res.updated > 0) {
              ctx.log.info(`incremental import from ${path.basename(changed)}`)
            }
          } catch (err) {
            ctx.log.warn(`incremental parse failed for ${changed}:`, err)
          }
        },
        { match: JSONL_RE, debounceMs: 1000 }
      )
      ctx.log.info(`watching ${sourceRoot}`)
    }
  },

  start() {
    zcodeRuntime.start?.()
  }
}

export default plugin
