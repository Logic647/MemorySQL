import fs from 'node:fs'
import path from 'node:path'
import type { MemorySQLPlugin } from '../../main/core/plugin-host'
import { parseNote } from './note-parser'
import { VAULT_MIGRATIONS } from './migrations'

/**
 * core-vault: Markdown notes in the vault (Obsidian-compatible folder),
 * with [[wikilink]] backlinks, tags, FTS and a live filesystem watcher.
 * The .md file is the source of truth — the db only indexes it.
 */
const MD_RE = /\.md$/i

const plugin: MemorySQLPlugin = {
  manifest: {
    id: 'core-vault',
    name: 'Core Vault (notes)',
    version: '0.1.0'
  },

  init(ctx) {
    ctx.db.migrate(VAULT_MIGRATIONS)
    const vault = ctx.env.vaultDir

    const relOf = (abs: string): string => path.relative(vault, abs).split(path.sep).join('/')
    const absOf = (rel: string): string => path.join(vault, ...rel.split('/'))

    const findId = ctx.db.sqlite.prepare('SELECT id FROM notes WHERE rel_path = ? AND deleted = 0')
    const ftsDel = ctx.db.sqlite.prepare('DELETE FROM notes_fts WHERE rowid = ?')
    const ftsIns = ctx.db.sqlite.prepare('INSERT INTO notes_fts (rowid, title, content) VALUES (?, ?, ?)')
    const delNote = ctx.db.sqlite.prepare('UPDATE notes SET deleted = 1, updated_at = ? WHERE rel_path = ?')

    /** index one file (or tombstone it when missing) */
    const indexFile = (abs: string): void => {
      const rel = relOf(abs)
      if (rel.startsWith('..') || path.isAbsolute(rel)) return
      if (!fs.existsSync(abs)) {
        const row = findId.get(rel) as { id: number } | undefined
        if (row) {
          ftsDel.run(row.id)
          delNote.run(Date.now(), rel)
        }
        return
      }
      const content = fs.readFileSync(abs, 'utf-8')
      const meta = parseNote(content, path.basename(abs, '.md'))
      const now = Date.now()
      const existing = findId.get(rel) as { id: number } | undefined
      let id: number
      if (existing) {
        ctx.db.sqlite
          .prepare('UPDATE notes SET title = ?, links = ?, tags = ?, updated_at = ?, deleted = 0 WHERE rel_path = ?')
          .run(meta.title, JSON.stringify(meta.links), JSON.stringify(meta.tags), now, rel)
        id = existing.id
        ftsDel.run(id)
      } else {
        id = Number(
          (
            ctx.db.sqlite
              .prepare(
                'INSERT INTO notes (rel_path, title, links, tags, updated_at, device_id) VALUES (?, ?, ?, ?, ?, ?)'
              )
              .run(rel, meta.title, JSON.stringify(meta.links), JSON.stringify(meta.tags), now, 'local') as {
              lastInsertRowid: number | bigint
            }
          ).lastInsertRowid
        )
      }
      ftsIns.run(id, meta.title, content)
    }

    const scanVault = (): number => {
      let count = 0
      const walk = (dir: string): void => {
        let entries: fs.Dirent[]
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const e of entries) {
          const full = path.join(dir, e.name)
          if (e.isDirectory()) walk(full)
          else if (e.isFile() && MD_RE.test(e.name)) {
            indexFile(full)
            count++
          }
        }
      }
      walk(vault)
      ctx.log.info(`vault indexed: ${count} notes`)
      return count
    }

    // ---- IPC -------------------------------------------------------------
    ctx.ipc.handle('notes:list', () =>
      ctx.db.sqlite
        .prepare(
          `SELECT id, rel_path AS relPath, title, tags, updated_at AS updatedAt
           FROM notes WHERE deleted = 0 ORDER BY updated_at DESC`
        )
        .all()
    )

    ctx.ipc.handle('notes:get', (payload) => {
      const { id } = (payload ?? {}) as { id?: number }
      const note = ctx.db.sqlite
        .prepare('SELECT id, rel_path AS relPath, title, tags FROM notes WHERE id = ? AND deleted = 0')
        .get(id) as { id: number; relPath: string; title: string; tags: string } | undefined
      if (!note) throw new Error('note not found')
      const content = fs.readFileSync(absOf(note.relPath), 'utf-8')
      return { note: { ...note, tags: JSON.parse(note.tags) as string[] }, content }
    })

    ctx.ipc.handle('notes:save', (payload) => {
      const { id, content } = (payload ?? {}) as { id?: number; content?: string }
      if (!id || typeof content !== 'string') throw new Error('notes:save requires id + content')
      const note = ctx.db.sqlite
        .prepare('SELECT rel_path FROM notes WHERE id = ? AND deleted = 0')
        .get(id) as { rel_path: string } | undefined
      if (!note) throw new Error('note not found')
      const abs = absOf(note.rel_path)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, content, 'utf-8') // file is the source of truth
      indexFile(abs)
      ctx.events.emit('sessions:changed')
      return { ok: true }
    })

    ctx.ipc.handle('notes:create', (payload) => {
      const { title } = (payload ?? {}) as { title?: string }
      const safe = (title ?? '').trim().replace(/[\\/:*?"<>|]/g, '_')
      if (!safe) throw new Error('标题不能为空')
      const rel = `${safe}.md`
      const abs = absOf(rel)
      if (fs.existsSync(abs)) throw new Error(`笔记已存在: ${rel}`)
      fs.writeFileSync(abs, `# ${safe}\n\n`, 'utf-8')
      indexFile(abs)
      const row = findId.get(rel) as { id: number }
      ctx.events.emit('sessions:changed')
      return { id: row.id, relPath: rel }
    })

    ctx.ipc.handle('notes:delete', (payload) => {
      const { id } = (payload ?? {}) as { id?: number }
      const note = ctx.db.sqlite
        .prepare('SELECT rel_path FROM notes WHERE id = ? AND deleted = 0')
        .get(id) as { rel_path: string } | undefined
      if (!note) throw new Error('note not found')
      fs.rmSync(absOf(note.rel_path), { force: true })
      indexFile(absOf(note.rel_path)) // tombstones via missing-file path
      return { ok: true }
    })

    ctx.ipc.handle('notes:search', (payload) => {
      const { q, limit = 30 } = (payload ?? {}) as { q?: string; limit?: number }
      const query = (q ?? '').trim()
      if (query.length < 3) return []
      const rows = ctx.db.sqlite
        .prepare(
          `SELECT n.id, n.title, snippet(notes_fts, 1, '«', '»', '…', 8) AS snip
           FROM notes_fts f JOIN notes n ON n.id = f.rowid
           WHERE notes_fts MATCH ? AND n.deleted = 0 LIMIT ?`
        )
        .all(`"${query.replace(/"/g, '""')}"`, limit) as Array<{ id: number; title: string; snip: string }>
      return rows
    })

    ctx.ipc.handle('notes:backlinks', (payload) => {
      const { id } = (payload ?? {}) as { id?: number }
      const target = ctx.db.sqlite
        .prepare('SELECT title FROM notes WHERE id = ? AND deleted = 0')
        .get(id) as { title: string } | undefined
      if (!target) return []
      const needle = target.title.toLowerCase()
      const rows = ctx.db.sqlite
        .prepare('SELECT id, title, links FROM notes WHERE deleted = 0 AND id != ?')
        .all(id) as Array<{ id: number; title: string; links: string }>
      return rows
        .filter((r) => (JSON.parse(r.links) as string[]).some((l) => l.toLowerCase() === needle))
        .map((r) => ({ id: r.id, title: r.title }))
    })

    ctx.ipc.handle('notes:graph', () => {
      const notes = ctx.db.sqlite
        .prepare('SELECT id, title FROM notes WHERE deleted = 0')
        .all() as Array<{ id: number; title: string }>
      const byTitle = new Map(notes.map((n) => [n.title.toLowerCase(), n.id]))
      const edges: Array<{ from: number; to: number }> = []
      const seen = new Set<string>()
      for (const n of notes) {
        const row = ctx.db.sqlite.prepare('SELECT links FROM notes WHERE id = ?').get(n.id) as {
          links: string
        }
        for (const link of JSON.parse(row.links) as string[]) {
          const to = byTitle.get(link.toLowerCase())
          if (to !== undefined && to !== n.id) {
            const key = `${Math.min(n.id, to)}-${Math.max(n.id, to)}`
            if (!seen.has(key)) {
              seen.add(key)
              edges.push({ from: n.id, to })
            }
          }
        }
      }
      return { nodes: notes, edges }
    })

    vaultRuntime.start = () => {
      scanVault()
      ctx.watcher.watch([vault], (changed) => indexFile(changed), { match: MD_RE, debounceMs: 400 })
      ctx.log.info(`watching vault: ${vault}`)
    }
  },

  start() {
    vaultRuntime.start?.()
  }
}

const vaultRuntime: { start?: () => void } = {}

export default plugin
