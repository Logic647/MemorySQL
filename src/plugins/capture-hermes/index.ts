import fs from 'node:fs'
import path from 'node:path'
import type { MemorySQLPlugin } from '../../main/core/plugin-host'
import type { CaptureStatus, RawMessage, RawSession } from '../../shared/types'
import type { IngestService } from '../core-schema/ingest'
import type { MemoriesService } from '../core-schema'
import { openForeignDb } from '../../main/core/sqlite-ro'
import { failureDetail, healthFrom } from '../_lib/capture-health'
import { segmentSource, splitHermesMemoryFile } from './split'

/**
 * Hermes Agent CN Desktop data layout (user-provided):
 *   <profilesRoot>/state.db                      ← default profile (unused here)
 *   <profilesRoot>/profiles/<name>/state.db      ← SQLite+FTS5 session store
 *   <profilesRoot>/profiles/<name>/memories/MEMORY.md  (environment/gotchas)
 *   <profilesRoot>/profiles/<name>/memories/USER.md    (interaction persona)
 *   <profilesRoot>/profiles/<name>/.env, config.yaml  ← NEVER imported
 *
 * state.db may be locked by the running Hermes instance; we open read-only
 * and fall back to copying db+wal+shm to a temp snapshot.
 */
interface HermesRow {
  id: string
  role: string
  content: string
  tool_name?: string | null
  timestamp?: number | null
}

function openHermesDb(dbPath: string): { db: import('better-sqlite3').Database; cleanup: () => void } {
  return openForeignDb(dbPath)
}

function parseHermesDb(dbPath: string, externalIdPrefix: string): RawSession[] {
  const { db, cleanup } = openHermesDb(dbPath)
  try {
    const sessions = db
      .prepare('SELECT id, source, display_name, model FROM sessions ORDER BY id')
      .all() as Array<{ id: string; source: string; display_name: string | null; model: string | null }>
    const msgStmt = db.prepare(
      'SELECT id, role, content, tool_name, timestamp FROM messages WHERE session_id = ? ORDER BY id'
    )

    const out: RawSession[] = []
    for (const s of sessions) {
      const rows = msgStmt.all(s.id) as unknown as HermesRow[]
      const messages: RawMessage[] = rows
        .filter((r) => ['user', 'assistant', 'tool'].includes(r.role))
        .map((r) => ({
          role: r.role as RawMessage['role'],
          content: r.content ?? '',
          ts: typeof r.timestamp === 'number' ? Math.floor(r.timestamp) : undefined,
          toolName: r.role === 'tool' ? (r.tool_name ?? 'tool') : undefined
        }))
        .filter((m) => m.content.trim().length > 0)
      if (messages.length === 0) continue

      const startedAt = messages.find((m) => m.ts !== undefined)?.ts
      const endedAt = [...messages].reverse().find((m) => m.ts !== undefined)?.ts
      out.push({
        // profile-namespaced: two profiles can share numeric session ids,
        // and (agent_type, external_id) is the dedup/unique key
        externalId: `${externalIdPrefix}/${s.id}`,
        agentType: 'hermes',
        startedAt,
        endedAt,
        messages,
        rawPath: dbPath
      })
    }
    return out
  } finally {
    cleanup()
  }
}

interface HermesSource {
  dbPath: string
  /** namespace for externalIds, e.g. "profiles/daily" or "home" */
  label: string
}

function findHermesDbs(profilesRoot: string): HermesSource[] {
  const sources: HermesSource[] = []
  const rootDb = path.join(profilesRoot, 'state.db')
  if (fs.existsSync(rootDb)) sources.push({ dbPath: rootDb, label: 'home' })
  const profilesDir = path.join(profilesRoot, 'profiles')
  try {
    for (const e of fs.readdirSync(profilesDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const db = path.join(profilesDir, e.name, 'state.db')
      if (fs.existsSync(db)) sources.push({ dbPath: db, label: `profiles/${e.name}` })
    }
  } catch {
    // no profiles dir — root db only
  }
  return sources
}

function importHermesMemories(
  profilesRoot: string,
  sqlite: import('better-sqlite3').Database,
  memories: MemoriesService
): number {
  let changed = 0
  const profileDirs: string[] = []
  const profilesDir = path.join(profilesRoot, 'profiles')
  try {
    profileDirs.push(
      ...fs
        .readdirSync(profilesDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(profilesDir, e.name))
    )
  } catch {
    /* root only */
  }
  profileDirs.push(profilesRoot) // default profile home

  const allHermesRows = () =>
    sqlite
      .prepare(`SELECT id, source FROM memories WHERE deleted = 0 AND source LIKE 'hermes:%'`)
      .all() as Array<{ id: number; source: string }>
  const tombstone = sqlite.prepare('UPDATE memories SET deleted = 1, updated_at = ? WHERE id = ?')

  for (const dir of profileDirs) {
    const memDir = path.join(dir, 'memories')
    const files: Array<{ file: string; kind: string }> = [
      { file: path.join(memDir, 'MEMORY.md'), kind: 'fact' },
      { file: path.join(memDir, 'USER.md'), kind: 'persona' }
    ]
    for (const { file, kind } of files) {
      if (!fs.existsSync(file)) continue
      const content = fs.readFileSync(file, 'utf-8').trim()
      if (!content) continue
      const rel = path.relative(profilesRoot, file).split(path.sep).join('/')
      const legacySource = `hermes:${rel}`
      const liveKeys = new Set<string>()
      for (const seg of splitHermesMemoryFile(content)) {
        const source = segmentSource(rel, seg)
        liveKeys.add(source)
        const res = memories.upsertMemory({ kind, content: seg, source })
        if (res.changed) changed++
      }
      // the file is the source of truth: tombstone the legacy whole-file row
      // (pre-§-split imports) and segments edited/removed out of the file
      for (const row of allHermesRows()) {
        const isLegacy = row.source === legacySource
        const isStaleSegment = row.source.startsWith(`${legacySource}#`) && !liveKeys.has(row.source)
        if (isLegacy || isStaleSegment) {
          tombstone.run(Date.now(), row.id)
          changed++
        }
      }
    }
  }
  return changed
}

/**
 * Hermes installs register an uninstall entry (installer builds) or live at a
 * drive root (portable layout "<install>\data\hermes-home"). A profilesRoot
 * recorded on another machine must not wedge detection, so probe: configured →
 * registry InstallLocation → every drive root → user home.
 *
 * 实现在 ./resolve-home.ts —— 那里不 import 任何 sqlite / electron,
 * 黑盒检查器才能在纯 Node 下直接复用(曾经因为放在本文件里、而本文件 import 了
 * better-sqlite3,导致黑盒永远报「本机未装」)。这里只做转出,保持既有导出面不变。
 */
// 探测逻辑在 ./resolve-home.ts(不依赖 sqlite / electron,黑盒检查器可直接复用)。
// 既要 re-export 保持既有导出面,也要 import 供本文件内部使用 ——
// `export { x } from` 不会把 x 带进本地作用域。
import { resolveHermesHome } from './resolve-home.ts'
export { resolveHermesHome, stripQuotes } from './resolve-home.ts'

let lastStatus: CaptureStatus = {
  pluginId: 'capture-hermes',
  agentType: 'hermes',
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
    id: 'capture-hermes',
    name: 'Capture: Hermes Agent CN Desktop',
    version: '0.1.0',
    requires: ['core-schema']
  },

  init(ctx) {
    const configured = ctx.settings.get<string | undefined>('profilesRoot', undefined)
    const profilesRoot = resolveHermesHome(configured)
    if (profilesRoot && profilesRoot !== configured) ctx.settings.set('profilesRoot', profilesRoot)
    lastStatus = { ...lastStatus, sourceRoot: profilesRoot ?? configured ?? '', available: !!profilesRoot && fs.existsSync(profilesRoot) }

    const scan = async (): Promise<CaptureStatus> => {
      try {
        const ingest = ctx.services.use<IngestService>('ingest')
        const memories = ctx.services.use<MemoriesService>('memories')
        if (!profilesRoot || !fs.existsSync(profilesRoot)) {
          lastStatus = { ...lastStatus, available: false, lastError: '未找到 Hermes 数据目录' }
          return lastStatus
        }
        const sessions: RawSession[] = []
        const dbFailures: string[] = []
        for (const { dbPath, label } of findHermesDbs(profilesRoot)) {
          try {
            sessions.push(...parseHermesDb(dbPath, label))
          } catch (err) {
            // 库读不出来(典型原因:上游改了 state.db 的表/列)必须让状态体现出来。
            // 过去只写日志,scan 仍返回「成功」,UI 显示正常而实际零捕获 —— 比
            // watcher 静默更隐蔽,因为连 lastError 都不会有。
            dbFailures.push(failureDetail(err, dbPath))
            ctx.log.warn(`failed to read ${dbPath}:`, err)
          }
        }
        const memChanged = importHermesMemories(profilesRoot, ctx.db.sqlite, memories)
        const res = await ingest.ingestSessions(sessions)
        // 全部 db 都读失败 = 本轮零捕获,等同于失败(最典型的 schema 漂移信号)
        const allFailed = dbFailures.length > 0 && sessions.length === 0
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
            ? (dbFailures[0] ?? '未知错误')
            : dbFailures.length > 0
              ? `部分库读取失败: ${dbFailures.join('; ')}`
              : lastStatus.lastFailureDetail,
          lastSuccessAt: allFailed ? lastStatus.lastSuccessAt : Date.now()
        }
        if (allFailed) {
          ctx.log.error(`all ${dbFailures.length} hermes db(s) failed to read — 疑似上游改了 schema`)
        }
        ctx.log.info(
          `scan ok: ${res.scanned} found, ${res.imported} imported, ${res.updated} updated, ${res.skipped} unchanged, ${memChanged} memory files synced`
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
    // No filesystem watcher for Hermes MVP: state.db churns constantly while
    // the agent runs. Rescan is manual / on app start.
  }
}

export default plugin
