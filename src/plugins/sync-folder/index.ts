import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { MemorySQLPlugin } from '../../main/core/plugin-host'
import { mergeBundle, type SyncBundle } from './sync-merge'

/**
 * Incremental two-way sync through a user-chosen folder that a cloud drive
 * (OneDrive/坚果云/Synology Drive…) replicates between machines. No server.
 * Push: writes one bundle file per sync under <folder>/memorysql-sync/<deviceId>/.
 * Pull: merges every other device's bundles not yet imported (ledger-capped).
 * MVP semantics: union by natural key + LWW — deletions do not propagate.
 */
const plugin: MemorySQLPlugin = {
  manifest: {
    id: 'sync-folder',
    name: 'Sync: Folder (incremental)',
    version: '0.1.0'
  },

  init(ctx) {
    // stable per-install device identity
    let deviceId = ctx.settings.get('deviceId', '')
    if (!deviceId) {
      deviceId = `dev-${crypto.randomBytes(4).toString('hex')}`
      ctx.settings.set('deviceId', deviceId)
    }
    ctx.db.sqlite
      .prepare('INSERT OR IGNORE INTO devices (id, name, created_at) VALUES (?, ?, ?)')
      .run(deviceId, process.env.COMPUTERNAME ?? 'unknown', Date.now())

    const getFolder = (): string => ctx.settings.get('folder', '')

    ctx.ipc.handle('status', () => ({
      deviceId,
      folder: getFolder(),
      lastSyncAt: ctx.settings.get('lastSyncAt', 0),
      plaintextAck: ctx.settings.get<boolean>('plaintextAck', false)
    }))

    ctx.ipc.handle('configure', (payload) => {
      const { folder } = (payload ?? {}) as { folder?: string }
      ctx.settings.set('folder', (folder ?? '').trim())
      return { folder: getFolder() }
    })

    ctx.ipc.handle('syncNow', () => {
      // iron rule 2 gate: cloud sync writes plaintext into a third-party
      // synced folder — the user must acknowledge this explicitly, once
      if (ctx.settings.get<boolean>('plaintextAck', false) !== true) {
        throw new Error('云同步明文未确认：请在设置→同步与备份中勾选「云同步不做脱敏」确认后再同步')
      }
      const folder = getFolder()
      if (!folder) throw new Error('请先在设置中配置同步文件夹')
      const root = path.join(folder, 'memorysql-sync')
      const ownDir = path.join(root, deviceId)
      fs.mkdirSync(ownDir, { recursive: true })

      const lastSyncAt = Number(ctx.settings.get('lastSyncAt', 0))
      const since = Math.max(0, lastSyncAt - 60_000) // 1min overlap for clock skew

      // ---- push ---------------------------------------------------------
      const sessions = ctx.db.sqlite
        .prepare(
          `SELECT agent_type, external_id, cwd, started_at, ended_at, title, summary,
                  content_hash, message_count, tool_call_count, updated_at
           FROM sessions WHERE updated_at > ? AND deleted = 0`
        )
        .all(since) as SyncBundle['sessions']
      const sessionIds = new Map(
        (
          ctx.db.sqlite
            .prepare(
              `SELECT id, agent_type || char(0) || external_id AS key FROM sessions
               WHERE updated_at > ? AND deleted = 0`
            )
            .all(since) as Array<{ id: number; key: string }>
        ).map((r) => [r.key, r.id])
      )
      const messages: SyncBundle['messages'] = []
      const msgStmt = ctx.db.sqlite.prepare(
        'SELECT seq, role, content, ts, tool_name FROM session_messages WHERE session_id = ? ORDER BY seq'
      )
      for (const s of sessions) {
        const id = sessionIds.get(`${s.agent_type}\u0000${s.external_id}`)
        if (id === undefined) continue
        for (const m of msgStmt.all(id) as Array<Record<string, unknown>>) {
          messages.push({
            session_key: `${s.agent_type}\u0000${s.external_id}`,
            seq: m.seq as number,
            role: m.role as string,
            content: m.content as string,
            ts: (m.ts as number | null) ?? null,
            tool_name: (m.tool_name as string | null) ?? null
          })
        }
      }
      const memories = ctx.db.sqlite
        .prepare(
          `SELECT kind, content, source, updated_at, device_id FROM memories WHERE updated_at > ? AND deleted = 0`
        )
        .all(since) as SyncBundle['memories']
      const projects = ctx.db.sqlite
        .prepare(
          `SELECT path, name, tech_stack, updated_at FROM projects WHERE updated_at > ? AND deleted = 0`
        )
        .all(since) as SyncBundle['projects']

      const bundle: SyncBundle = {
        device: deviceId,
        exportedAt: Date.now(),
        since,
        sessions,
        messages,
        memories,
        projects
      }
      const bundleName = `bundle-${Date.now()}.json`
      fs.writeFileSync(
        path.join(ownDir, bundleName),
        JSON.stringify(bundle),
        'utf-8'
      )

      // ---- pull ---------------------------------------------------------
      const imported: string[] = ctx.settings.get('importedFiles', [])
      const importedSet = new Set(imported)
      const report = {
        filesPulled: 0,
        sessionsAdded: 0,
        sessionsUpdated: 0,
        memoriesAdded: 0,
        projectsAdded: 0,
        projectsUpdated: 0
      }
      if (fs.existsSync(root)) {
        for (const deviceDir of fs.readdirSync(root, { withFileTypes: true })) {
          if (!deviceDir.isDirectory() || deviceDir.name === deviceId) continue
          const absDir = path.join(root, deviceDir.name)
          for (const file of fs.readdirSync(absDir).filter((f) => f.endsWith('.json')).sort()) {
            const marker = `${deviceDir.name}/${file}`
            if (importedSet.has(marker)) continue
            try {
              const remote = JSON.parse(fs.readFileSync(path.join(absDir, file), 'utf-8')) as SyncBundle
              const r = mergeBundle(ctx.db.sqlite, remote)
              report.filesPulled++
              report.sessionsAdded += r.sessionsAdded
              report.sessionsUpdated += r.sessionsUpdated
              report.memoriesAdded += r.memoriesAdded
              report.projectsAdded += r.projectsAdded
              report.projectsUpdated += r.projectsUpdated
              importedSet.add(marker)
            } catch (err) {
              ctx.log.warn(`failed to merge ${marker}:`, err)
            }
          }
        }
      }
      // cap the ledger
      const ledger = [...importedSet]
      // rolling ledger: keep the most recent 2000 so old bundles never replay
      ctx.settings.set('importedFiles', ledger.slice(-2000))

      ctx.settings.set('lastSyncAt', Date.now())
      if (report.sessionsAdded + report.sessionsUpdated + report.memoriesAdded > 0) {
        ctx.events.emit('sessions:changed')
      }
      ctx.log.info(`sync done: pushed ${bundleName}, pulled ${report.filesPulled} files`)
      return { pushed: bundleName, ...report }
    })
  }
}

export default plugin
