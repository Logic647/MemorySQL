import fs from 'node:fs'
import path from 'node:path'
import type { MemorySQLPlugin } from '../../main/core/plugin-host'
import type { MemoriesService } from '../core-schema'

/**
 * 登记式自定义 agent 监听:用户为"非内置支持"的 agent 登记
 * {agent 名, 项目目录, 文件模式}。命中的文件只读导入为记忆
 * (source = custom:<agent>:<file>),与内置适配器同库同搜索。
 */

interface WatchEntry {
  agent: string
  root: string
  /** comma/space separated suffixes: "AGENTS.md, CLAUDE.md, *.jsonl" */
  patterns: string
}

function patternToRegExp(patterns: string): RegExp {
  const parts = patterns
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*')
      return `(^|[/\\\\])${escaped}$`
    })
  return new RegExp(parts.join('|'), 'i')
}

function sanitizeAgent(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-')
}

const plugin: MemorySQLPlugin = {
  manifest: {
    id: 'capture-watcher',
    name: 'Capture: Custom agents (登记式)',
    version: '0.2.0',
    requires: ['core-schema']
  },

  init(ctx) {
    const getEntries = (): WatchEntry[] => ctx.settings.get('entries', [])

    const importFile = (abs: string, agent: string): void => {
      try {
        const content = fs.readFileSync(abs, 'utf-8').trim()
        if (!content) return
        const memories = ctx.services.use<MemoriesService>('memories')
        const res = memories.upsertMemory({
          kind: 'fact',
          content: content.slice(0, 8000),
          source: `custom:${agent}:${abs.split(path.sep).join('/')}`
        })
        if (res.changed) ctx.log.info(`imported ${agent} memory: ${abs}`)
      } catch (err) {
        ctx.log.warn(`failed to import ${abs}:`, err)
      }
    }

    const importRoot = (entry: WatchEntry): void => {
      const re = patternToRegExp(entry.patterns)
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(entry.root, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (e.isFile() && re.test(e.name)) importFile(path.join(entry.root, e.name), entry.agent)
      }
    }

    ctx.ipc.handle('list', () => ({ entries: getEntries() }))

    ctx.ipc.handle('add', (payload) => {
      const { agent, root, patterns } = (payload ?? {}) as {
        agent?: string
        root?: string
        patterns?: string
      }
      const agentName = sanitizeAgent(agent ?? '')
      const rawRoot = (root ?? '').trim()
      if (!agentName) throw new Error('agent 名只能含字母/数字/-/_')
      if (!rawRoot) throw new Error('目录不能为空')
      const abs = path.resolve(rawRoot)
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error('目录不存在')
      const pats = (patterns ?? 'AGENTS.md, CLAUDE.md, MEMORY.md').trim() || 'AGENTS.md, CLAUDE.md, MEMORY.md'
      const entries = getEntries()
      if (entries.some((e) => e.agent === agentName && e.root === abs)) {
        throw new Error('该 agent + 目录已登记')
      }
      const next = [...entries, { agent: agentName, root: abs, patterns: pats }]
      ctx.settings.set('entries', next)
      importRoot(next[next.length - 1])
      watcherRuntime.attach?.(next[next.length - 1])
      return { entries: next }
    })

    ctx.ipc.handle('remove', (payload) => {
      const { agent, root } = (payload ?? {}) as { agent?: string; root?: string }
      const next = getEntries().filter((e) => !(e.agent === agent && e.root === root))
      ctx.settings.set('entries', next)
      return { entries: next }
    })

    watcherRuntime.attach = (entry: WatchEntry): void => {
      const re = patternToRegExp(entry.patterns)
      ctx.watcher.watch([entry.root], (changed) => importFile(changed, entry.agent), {
        match: re,
        debounceMs: 800
      })
    }
    watcherRuntime.entries = getEntries
  },

  start() {
    for (const entry of watcherRuntime.entries?.() ?? []) {
      watcherRuntime.attach?.(entry)
    }
  }
}

const watcherRuntime: {
  attach?: (entry: WatchEntry) => void
  entries?: () => WatchEntry[]
} = {}

export default plugin
