import type { MemorySQLPlugin } from '../../main/core/plugin-host'
import type { MemoriesService } from '../core-schema'

/** Memory CRUD for the UI. File-backed memories (hermes:*) are managed by
 * their capture plugins; this handles everything else (agent/manual). */
const VALID_KINDS = new Set(['fact', 'preference', 'persona', 'decision'])

const plugin: MemorySQLPlugin = {
  manifest: {
    id: 'memory-core',
    name: 'Memory Core (CRUD)',
    version: '0.1.0',
    requires: ['core-schema']
  },

  init(ctx) {
    ctx.ipc.handle('save', (payload) => {
      const { id, kind, content } = (payload ?? {}) as {
        id?: number
        kind?: string
        content?: string
      }
      if (kind && !VALID_KINDS.has(kind)) throw new Error(`invalid kind: ${kind}`)
      const text = (content ?? '').trim()
      if (!text) throw new Error('content 不能为空')
      const sqlite = ctx.db.sqlite
      if (id) {
        sqlite
          .prepare('UPDATE memories SET kind = ?, content = ?, updated_at = ? WHERE id = ? AND deleted = 0')
          .run(kind ?? 'fact', text, Date.now(), id)
        return { id }
      }
      const res = ctx.services.use<MemoriesService>('memories').addMemory({
        kind: kind ?? 'fact',
        content: text,
        source: 'manual'
      })
      return res
    })

    ctx.ipc.handle('delete', (payload) => {
      const { id } = (payload ?? {}) as { id?: number }
      if (!id) throw new Error('delete requires id')
      ctx.db.sqlite
        .prepare('UPDATE memories SET deleted = 1, updated_at = ? WHERE id = ?')
        .run(Date.now(), id)
      return { ok: true }
    })

    ctx.ipc.handle('setStatus', (payload) => {
      const { id, status } = (payload ?? {}) as { id?: number; status?: string }
      if (!id || !status || !['candidate', 'active', 'retired'].includes(status)) {
        throw new Error('setStatus requires id + status(candidate|active|retired)')
      }
      ctx.db.sqlite
        .prepare('UPDATE memories SET status = ?, updated_at = ? WHERE id = ?')
        .run(status, Date.now(), id)
      return { ok: true }
    })
  }
}

export default plugin
