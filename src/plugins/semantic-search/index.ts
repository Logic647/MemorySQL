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
      // not at startup
      let embedder: Awaited<ReturnType<typeof FlagEmbedding.init>> | null = null
      const getEmbedder = async () => {
        if (!embedder) {
          embedder = await FlagEmbedding.init({
            model,
            cacheDir: path.join(ctx.env.dataDir, 'fastembed-cache')
          })
        }
        return embedder
      }
      core = createSemanticCore({
        sqlite: ctx.db.sqlite,
        dims,
        model: 'bge-small-zh-v1.5',
        embedDocs: async (texts) => {
          const fe = await getEmbedder()
          const out: number[][] = []
          for await (const batch of fe.passageEmbed(texts, 32)) out.push(...batch)
          return out
        },
        embedQuery: async (q) => {
          const fe = await getEmbedder()
          return fe.queryEmbed(q)
        }
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

    const refresh = async (): Promise<void> => {
      try {
        const res = await core.sync()
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
      const res = await core.sync()
      return { ...res, ok: true }
    })

    ctx.log.info('semantic search enabled — model downloads on first sync/search')
  }
}

export default plugin
