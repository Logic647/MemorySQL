import fs from 'node:fs'
import path from 'node:path'
import type { MemorySQLPlugin } from '../../main/core/plugin-host'
import { createSemanticCore, type SemanticCore } from './core'

export interface SemanticStatus {
  enabled: boolean
  available: boolean
  reason?: string
  model?: string
  dims?: number
  rows?: number
}

/**
 * Semantic search (M7): sqlite-vec KNN over active memories + sessions,
 * embedded with fastembed's bge-small-zh-v1.5 — fully local, no cloud.
 *
 * OFF by default: the embedding model (~100MB) downloads on first use, and
 * that download is an explicit user decision (settings.json
 * `semantic:enabled: true`, or the settings page toggle). When disabled or
 * when either native dependency is missing, the plugin degrades to a no-op
 * and `memory_search` runs pure FTS (iron rule 3).
 */
const plugin: MemorySQLPlugin = {
  manifest: {
    id: 'semantic-search',
    name: 'Semantic Search (sqlite-vec + fastembed)',
    version: '0.1.0',
    requires: ['core-schema']
  },

  async init(ctx) {
    // plugin settings are namespaced automatically: this reads the flat key
    // `semantic-search:enabled` in settings.json
    const enabled = ctx.settings.get<boolean>('enabled', false)
    if (!enabled) {
      ctx.ipc.handle('status', (): SemanticStatus => ({ enabled: false, available: false, reason: '未启用(设置 semantic:enabled)' }))
      ctx.log.info('semantic search disabled (semantic-search:enabled=false) — MCP memory_search runs pure FTS')
      return
    }

    let core: SemanticCore
    try {
      // native deps are load-bearing only when enabled; any failure degrades
      const { getLoadablePath } = await import('sqlite-vec')
      // SQLite opens the extension dll with its own C-level file IO, which
      // does not go through Electron's asar fs shim — rewrite to the unpacked
      // copy when running from an asar
      let loadable = getLoadablePath()
      if (loadable.includes('app.asar') && !loadable.includes('app.asar.unpacked')) {
        const unpacked = loadable.replace('app.asar', 'app.asar.unpacked')
        if (fs.existsSync(unpacked)) loadable = unpacked
      }
      ctx.db.sqlite.loadExtension(loadable)
      const { FlagEmbedding, EmbeddingModel } = await import('fastembed')
      const model = EmbeddingModel.BGESmallZH
      const dims = 512
      // lazy singleton: the ~100MB model download happens on the FIRST embed,
      // not at startup. After 15 idle minutes the ONNX session is released
      // (its arena allocator otherwise keeps peak memory from ever returning
      // to the OS); the next search/sync re-loads it lazily.
      let embedder: Awaited<ReturnType<typeof FlagEmbedding.init>> | null = null
      let lastUsed = 0
      let busy = 0
      const getEmbedder = async () => {
        if (!embedder) {
          embedder = await FlagEmbedding.init({
            model,
            cacheDir: path.join(ctx.env.dataDir, 'fastembed-cache')
          })
        }
        return embedder
      }
      const releaseIdle = (): void => {
        if (!embedder || busy > 0 || Date.now() - lastUsed < 15 * 60_000) return
        const fe = embedder
        embedder = null
        // fastembed holds the ort InferenceSession in a private field; release
        // it best-effort so the native arena heap is handed back to the OS
        void (fe as unknown as { session?: { release?: () => Promise<void> } }).session?.release?.().catch(
          () => {}
        )
      }
      const idleTimer = setInterval(releaseIdle, 5 * 60_000)
      idleTimer.unref?.()
      const withEmbedder = async <T>(fn: (fe: Awaited<ReturnType<typeof FlagEmbedding.init>>) => Promise<T>): Promise<T> => {
        busy++
        try {
          const fe = await getEmbedder()
          lastUsed = Date.now()
          return await fn(fe)
        } finally {
          busy--
        }
      }
      core = createSemanticCore({
        sqlite: ctx.db.sqlite,
        dims,
        model: 'bge-small-zh-v1.5',
        embedDocs: async (texts) =>
          withEmbedder(async (fe) => {
            const out: number[][] = []
            for await (const batch of fe.passageEmbed(texts, 32)) out.push(...batch)
            return out
          }),
        embedQuery: (q) => withEmbedder((fe) => fe.queryEmbed(q))
      })
    } catch (err) {
      ctx.log.error('semantic search init failed — staying disabled:', err)
      ctx.ipc.handle('status', (): SemanticStatus => ({
        enabled: true,
        available: false,
        reason: `初始化失败: ${String(err)}`
      }))
      return
    }

    ctx.services.provide<SemanticCore>('semantic-search', core)

    // handoff-dedup: a session very similar to an earlier one is a "relay"
    // continuation — mark similar_to (report-only, UI folds it). Two signals:
    // identical normalized titles (cheap, precise) or cosine >= 0.72.
    const markSimilarity = async (sessionIds: number[]): Promise<void> => {
      for (const sid of sessionIds) {
        try {
          const self = ctx.db.sqlite
            .prepare(`SELECT title, similar_to, project_id FROM sessions WHERE id = ?`)
            .get(sid) as { title: string | null; similar_to: number | null; project_id: number | null } | undefined
          if (!self || self.similar_to != null || !self.title) continue

          const sameTitle = ctx.db.sqlite
            .prepare(
              `SELECT id FROM sessions
               WHERE title = ? AND id != ? AND deleted = 0 AND started_at < (SELECT started_at FROM sessions WHERE id = ?)
               ORDER BY started_at DESC LIMIT 1`
            )
            .get(self.title, sid, sid) as { id: number } | undefined
          if (sameTitle) {
            ctx.db.sqlite.prepare(`UPDATE sessions SET similar_to = ? WHERE id = ?`).run(sameTitle.id, sid)
            continue
          }

          const sims = await core.similarSessions(sid, 4)
          for (const s of sims) {
            // normalized embeddings: L2 d ∈ [0,2] → cosine = 1 - d²/2
            const cosine = 1 - (s.distance * s.distance) / 2
            if (cosine < 0.85) break
            const cand = ctx.db.sqlite
              .prepare(
                `SELECT project_id, started_at FROM sessions WHERE id = ? AND deleted = 0 AND started_at < (SELECT started_at FROM sessions WHERE id = ?)`
              )
              .get(s.refId, sid) as { project_id: number | null; started_at: number | null } | undefined
            if (!cand) continue // a relay always starts AFTER its origin
            if (self.project_id != null && cand.project_id != null && self.project_id !== cand.project_id) continue
            ctx.db.sqlite.prepare(`UPDATE sessions SET similar_to = ? WHERE id = ?`).run(s.refId, sid)
            break
          }
        } catch (err) {
          ctx.log.warn(`similarity mark failed for session ${sid}:`, err)
        }
      }
    }

    const allSessionIds = (): number[] =>
      (
        ctx.db.sqlite
          .prepare(`SELECT id FROM sessions WHERE deleted = 0 AND (title != '' OR summary != '')`)
          .all() as Array<{ id: number }>
      ).map((r) => r.id)

    const refresh = async (): Promise<void> => {
      try {
        const res = await core.sync()
        if (res.embeddedSessions.length > 0) await markSimilarity(res.embeddedSessions)
        if (res.embedded + res.removed > 0) {
          ctx.log.info(`semantic index synced: +${res.embedded}/-${res.removed}, ${res.rows} rows`)
        }
      } catch (err) {
        ctx.log.warn('semantic index sync failed:', err)
      }
    }
    let debounce: ReturnType<typeof setTimeout> | null = null
    const schedule = (): void => {
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => {
        debounce = null
        void refresh()
      }, 30_000)
    }
    ctx.events.on('ingest:result', schedule)
    ctx.events.on('sessions:changed', schedule)

    ctx.ipc.handle('status', async (): Promise<SemanticStatus> => {
      const s = core.stats()
      return { enabled: true, available: true, model: s.model, dims: s.dims, rows: s.rows }
    })
    ctx.ipc.handle('reindex', async () => {
      // manual reindex is explicit: rebuild from every source row — and it
      // backfills relay marks across ALL sessions (only NULL slots:
      // user-curated relays via sessions:setRelay are never wiped; stale
      // auto-marks pointing at deleted sessions are inert in the UI)
      const res = await core.sync({ full: true })
      await markSimilarity(allSessionIds())
      return { ...res, ok: true }
    })

    ctx.log.info('semantic search enabled — model downloads on first sync/search')
  }
}

export default plugin
