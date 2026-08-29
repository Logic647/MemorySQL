import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import type { MemorySQLPlugin } from '../../main/core/plugin-host'
import type { CaptureStatus, RawMessage, RawSession } from '../../shared/types'
import type { IngestService } from '../core-schema/ingest'
import type { MemoriesService } from '../core-schema'

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

function openReadonlySnapshot(dbPath: string): Database.Database {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memorysql-hermes-'))
  for (const suffix of ['', '-wal', '-shm']) {
    const src = `${dbPath}${suffix}`
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmpDir, `state.db${suffix}`))
  }
  return new Database(path.join(tmpDir, 'state.db'), { readonly: true, fileMustExist: true })
}

function openHermesDb(dbPath: string): Database.Database {
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true })
    db.pragma('busy_timeout = 3000')
    // touch a table to force any lock issue to surface early
    db.prepare('SELECT COUNT(*) FROM sessions').get()
    return db
  } catch {
    return openReadonlySnapshot(dbPath)
  }
}

function parseHermesDb(dbPath: string): RawSession[] {
  const db = openHermesDb(dbPath)
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
        externalId: s.id,
        agentType: 'hermes',
        startedAt,
        endedAt,
        messages,
        rawPath: dbPath
      })
    }
    return out
  } finally {
    db.close()
  }
}

function findHermesDbs(profilesRoot: string): string[] {
  const dbs: string[] = []
  const rootDb = path.join(profilesRoot, 'state.db')
  if (fs.existsSync(rootDb)) dbs.push(rootDb)
  const profilesDir = path.join(profilesRoot, 'profiles')
  try {
    for (const e of fs.readdirSync(profilesDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const db = path.join(profilesDir, e.name, 'state.db')
      if (fs.existsSync(db)) dbs.push(db)
    }
  } catch {
    // no profiles dir — root db only
  }
  return dbs
}

function importHermesMemories(profilesRoot: string, memories: MemoriesService): number {
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
      const res = memories.upsertMemory({ kind, content, source: `hermes:${rel}` })
      if (res.changed) changed++
    }
  }
  return changed
}

let lastStatus: CaptureStatus = {
  pluginId: 'capture-hermes',
  agentType: 'hermes',
  sourceRoot: '',
  available: false,
  sessionsFound: 0,
  sessionsImported: 0,
  lastScanAt: null,
  lastError: null
}

const plugin: MemorySQLPlugin = {
  manifest: {
    id: 'capture-hermes',
    name: 'Capture: Hermes Agent CN Desktop',
    version: '0.1.0',
    requires: ['core-schema']
  },

  init(ctx) {
    const profilesRoot = ctx.settings.get(
      'profilesRoot',
      'D:\\Hermes Agent CN Desktop\\data\\hermes-home'
    )
    lastStatus = { ...lastStatus, sourceRoot: profilesRoot, available: fs.existsSync(profilesRoot) }

    const scan = (): CaptureStatus => {
      try {
        const ingest = ctx.services.use<IngestService>('ingest')
        const memories = ctx.services.use<MemoriesService>('memories')
        const sessions: RawSession[] = []
        for (const dbPath of findHermesDbs(profilesRoot)) {
          try {
            sessions.push(...parseHermesDb(dbPath))
          } catch (err) {
            ctx.log.warn(`failed to read ${dbPath}:`, err)
          }
        }
        const memChanged = importHermesMemories(profilesRoot, memories)
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
