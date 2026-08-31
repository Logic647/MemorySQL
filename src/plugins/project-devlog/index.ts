import fs from 'node:fs'
import path from 'node:path'
import type { MemorySQLPlugin } from '../../main/core/plugin-host'
import { buildDevlogMd, type DevlogMemory, type DevlogSession } from './generate'

interface ProjectRow {
  id: number
  name: string
  path: string | null
  tech_stack: string | null
}

/**
 * Auto DEVLOG: keeps one generated Markdown log per project in
 * vault/devlog/, assembled from captured sessions (timeline) and memories
 * (decisions / pending progress). Written into the vault, so core-vault's
 * watcher indexes it automatically — the loop "project files <-> knowledge
 * base" starts here. Regeneration is fully rule-based and idempotent.
 */
const plugin: MemorySQLPlugin = {
  manifest: {
    id: 'project-devlog',
    name: 'Project Devlog (auto)',
    version: '0.1.0',
    requires: ['core-schema']
  },

  init(ctx) {
    let debounce: ReturnType<typeof setTimeout> | null = null

    const safeName = (name: string): string =>
      name.replace(/[\\/:*?"<>|\n\r]/g, '_').slice(0, 60) || 'project'

    const collect = (projectId: number) => {
      const sqlite = ctx.db.sqlite
      const project = sqlite
        .prepare('SELECT id, name, path, tech_stack FROM projects WHERE id = ? AND deleted = 0')
        .get(projectId) as ProjectRow | undefined
      if (!project) return null
      const sessions = sqlite
        .prepare(
          `SELECT id, agent_type, title, summary, started_at, message_count FROM sessions
           WHERE deleted = 0 AND project_id = ?
           ORDER BY COALESCE(started_at, updated_at) DESC`
        )
        .all(projectId) as DevlogSession[]
      const activeMemories = sqlite
        .prepare(
          `SELECT kind, content FROM memories
           WHERE status = 'active' AND deleted = 0 AND kind IN ('decision','fact','preference')
           ORDER BY updated_at DESC LIMIT 15`
        )
        .all() as DevlogMemory[]
      const pendingProgress = sqlite
        .prepare(
          `SELECT kind, content FROM memories
           WHERE status = 'candidate' AND deleted = 0 AND source LIKE 'agent:mcp:log_progress%'
           ORDER BY updated_at DESC LIMIT 8`
        )
        .all() as DevlogMemory[]
      return { project, sessions, activeMemories, pendingProgress }
    }

    const generateFor = (projectIds: number[]): string[] => {
      const dir = path.join(ctx.env.vaultDir, 'devlog')
      fs.mkdirSync(dir, { recursive: true })
      const files: string[] = []
      for (const id of projectIds) {
        const data = collect(id)
        if (!data) continue
        const md = buildDevlogMd({
          project: data.project,
          sessions: data.sessions,
          activeMemories: data.activeMemories,
          pendingProgress: data.pendingProgress,
          generatedAt: new Date()
        })
        const file = path.join(dir, `${safeName(data.project.name)}.md`)
        fs.writeFileSync(file, md, 'utf-8')
        files.push(file)
      }
      return files
    }

    const projectIdsOf = (keyword?: string): number[] => {
      const sqlite = ctx.db.sqlite
      if (keyword) {
        const rows = sqlite
          .prepare(
            `SELECT id FROM projects WHERE deleted = 0 AND (name LIKE ? OR path LIKE ?)`
          )
          .all(`%${keyword}%`, `%${keyword}%`) as Array<{ id: number }>
        return rows.map((r) => r.id)
      }
      return (
        sqlite
          .prepare('SELECT id FROM projects WHERE deleted = 0 AND EXISTS (SELECT 1 FROM sessions s WHERE s.project_id = projects.id AND s.deleted = 0)')
          .all() as Array<{ id: number }>
      ).map((r) => r.id)
    }

    ctx.ipc.handle('generate', (payload) => {
      const { project } = (payload ?? {}) as { project?: string }
      const ids = projectIdsOf(project?.trim() || undefined)
      if (ids.length === 0) return { files: [], message: '没有可生成日志的项目' }
      const files = generateFor(ids)
      ctx.log.info(`devlog generated for ${files.length} project(s): ${files.join(', ')}`)
      return { files }
    })

    // auto-refresh after ingest, debounced — a scan touches many sessions
    // but one regeneration per quiet period is enough
    ctx.events.on('ingest:result', (...args: unknown[]) => {
      const sessionIds = args[0] as number[]
      if (sessionIds.length === 0) return
      const ids = (
        ctx.db.sqlite
          .prepare(
            `SELECT DISTINCT project_id FROM sessions
             WHERE id IN (${sessionIds.map(() => '?').join(',')}) AND project_id IS NOT NULL`
          )
          .all(...sessionIds) as Array<{ project_id: number }>
      ).map((r) => r.project_id)
      if (ids.length === 0) return
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => {
        debounce = null
        try {
          const files = generateFor(ids)
          if (files.length > 0) ctx.log.info(`devlog auto-updated: ${files.length} file(s)`)
        } catch (err) {
          ctx.log.error('devlog auto-generation failed:', err)
        }
      }, 20_000)
    })
  }
}

export default plugin
