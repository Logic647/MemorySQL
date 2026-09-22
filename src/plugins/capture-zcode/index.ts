import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { MemorySQLPlugin } from '../../main/core/plugin-host'
import type { CaptureStatus, RawSession } from '../../shared/types'
import type { IngestService } from '../core-schema/ingest'
import { parseAgentSqliteSessions } from '../_lib/agent-db-parser'
import { findZcodeRollouts, parseZcodeRollout } from './zcode-parser'

const JSONL_RE = /\.jsonl$/i
// ZCode (opencode lineage) keeps its authoritative session store here;
// the model-io rollout logs are derived API-call traces without reliable cwd
const dbPath = path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite')

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
    version: '0.2.0',
    requires: ['core-schema']
  },

  init(ctx) {
    // legacy fallback source: model-io rollout logs (pre-sqlite ZCode versions)
    const configuredRoot = ctx.settings.get<string | undefined>('sourceRoot', undefined)
    const defaultRoot = path.join(os.homedir(), '.zcode', 'cli', 'rollout')
    const rolloutRoot = configuredRoot && fs.existsSync(configuredRoot) ? configuredRoot : defaultRoot

    const ingest = (): IngestService => ctx.services.use<IngestService>('ingest')

    const scan = async (): Promise<CaptureStatus> => {
      try {
        let sessions: RawSession[] = []
        let source: string
        if (fs.existsSync(dbPath)) {
          source = dbPath
          sessions = parseAgentSqliteSessions(dbPath, 'zcode')
        } else {
          source = rolloutRoot
          for (const f of findZcodeRollouts(rolloutRoot)) {
            try {
              sessions.push(...parseZcodeRollout(f, fs.readFileSync(f, 'utf-8')))
            } catch (err) {
              ctx.log.warn(`failed to parse ${f}:`, err)
            }
          }
        }
        const res = await ingest().ingestSessions(sessions)
        lastStatus = {
          ...lastStatus,
          sourceRoot: source,
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
      if (!fs.existsSync(rolloutRoot)) {
        ctx.log.warn(`source root missing, watcher disabled: ${rolloutRoot}`)
        return
      }
      ctx.watcher.watch(
        [rolloutRoot],
        (changed) => {
          void (async () => {
            try {
              if (!fs.existsSync(dbPath)) {
                // legacy install: import straight from the rollout file
                const sessions = parseZcodeRollout(changed, fs.readFileSync(changed, 'utf-8'))
                await ingest().ingestSessions(sessions)
                return
              }
              // db-backed install: the rollout file name carries the session id —
              // re-import just that session from the authoritative store
              const sessionId = path.basename(changed, '.jsonl').replace(/^model-io-/, '')
              const sessions = parseAgentSqliteSessions(dbPath, 'zcode', sessionId)
              const res = await ingest().ingestSessions(sessions)
              if (res.imported + res.updated > 0) {
                ctx.log.info(`incremental import from ${path.basename(changed)}`)
              }
            } catch (err) {
              ctx.log.warn(`incremental parse failed for ${changed}:`, err)
            }
          })()
        },
        { match: JSONL_RE, debounceMs: 1000 }
      )
      ctx.log.info(`watching ${rolloutRoot}`)
    }
  },

  start() {
    zcodeRuntime.start?.()
  }
}

export default plugin
