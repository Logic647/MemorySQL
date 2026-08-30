import fs from 'node:fs'
import path from 'node:path'
import type { MemorySQLPlugin } from '../../main/core/plugin-host'
import type { MemoriesService } from '../core-schema'

/**
 * Watches user-registered project directories and imports agent memory
 * conventions files (AGENTS.md / CLAUDE.md / MEMORY.md) into the knowledge
 * base as memories. READ-ONLY on project files — this is a capture adapter,
 * dispatch writes go to vault/dispatch only.
 */
const MEMORY_FILE_RE = /(^|[/\\])(AGENTS|CLAUDE|MEMORY)\.md$/i

const plugin: MemorySQLPlugin = {
  manifest: {
    id: 'capture-watcher',
    name: 'Capture: Project files',
    version: '0.1.0',
    requires: ['core-schema']
  },

  init(ctx) {
    const getRoots = (): string[] => ctx.settings.get('watchRoots', [])

    const importFile = (abs: string): void => {
      try {
        const content = fs.readFileSync(abs, 'utf-8').trim()
        if (!content) return
        const memories = ctx.services.use<MemoriesService>('memories')
        const rel = ctx.env.dataDir ? abs : abs // stable identity = path
        const res = memories.upsertMemory({
          kind: 'fact',
          content: content.slice(0, 8000),
          source: `project:${rel.split(path.sep).join('/')}`
        })
        if (res.changed) ctx.log.info(`imported project memory: ${abs}`)
      } catch (err) {
        ctx.log.warn(`failed to import ${abs}:`, err)
      }
    }

    const importRoot = (root: string): void => {
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(root, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (e.isFile() && MEMORY_FILE_RE.test(e.name)) importFile(path.join(root, e.name))
      }
    }

    ctx.ipc.handle('list', () => ({
      roots: getRoots(),
      projects: ctx.db.sqlite
        .prepare('SELECT id, name, path FROM projects WHERE deleted = 0 ORDER BY updated_at DESC LIMIT 20')
        .all()
    }))

    ctx.ipc.handle('addRoot', (payload) => {
      const { root } = (payload ?? {}) as { root?: string }
      const abs = path.resolve((root ?? '').trim())
      if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
        throw new Error('目录不存在')
      }
      const roots = getRoots()
      if (!roots.includes(abs)) {
        ctx.settings.set('watchRoots', [...roots, abs])
        importRoot(abs)
        watcherRuntime.attach?.(abs)
      }
      return { roots: getRoots() }
    })

    ctx.ipc.handle('removeRoot', (payload) => {
      const { root } = (payload ?? {}) as { root?: string }
      ctx.settings.set(
        'watchRoots',
        getRoots().filter((r) => r !== root)
      )
      return { roots: getRoots() }
    })

    watcherRuntime.attach = (root: string): void => {
      ctx.watcher.watch([root], (changed) => importFile(changed), {
        match: MEMORY_FILE_RE,
        debounceMs: 800
      })
    }
    watcherRuntime.importRoot = importRoot
    watcherApi.roots = getRoots
    watcherApi.log = ctx.log
  },

  start() {
    const roots = watcherApi.roots?.() ?? []
    for (const root of roots) {
      if (fs.existsSync(root)) watcherRuntime.importRoot?.(root)
      watcherRuntime.attach?.(root)
    }
    if (roots.length > 0) watcherApi.log?.info(`watching ${roots.length} project roots`)
  }
}

const watcherRuntime: { attach?: (root: string) => void; importRoot?: (root: string) => void } = {}
const watcherApi: {
  roots?: () => string[]
  log?: { info(msg: string, ...args: unknown[]): void }
} = {}

export default plugin
