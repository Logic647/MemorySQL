import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CORE_MIGRATIONS } from '../src/plugins/core-schema/migrations'
import { createIngestService, type IngestService } from '../src/plugins/core-schema/ingest'
import type { RawSession } from '../src/shared/types'

let db: Database.Database
let ingest: IngestService
let tmp: string
let projA: string
let projB: string

function session(over: Partial<RawSession> & { externalId: string }): RawSession {
  return {
    agentType: 'zcode',
    title: 'title-orig',
    cwd: projA,
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' }
    ],
    ...over
  }
}

beforeEach(() => {
  db = new Database(':memory:')
  for (const m of CORE_MIGRATIONS) db.exec(m.up)
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-sync-'))
  projA = path.join(tmp, 'demo')
  projB = path.join(tmp, 'money')
  fs.mkdirSync(projA, { recursive: true })
  fs.mkdirSync(projB, { recursive: true })
  ingest = createIngestService({ sqlite: db, getSummarizer: () => null, onIngest: () => {} })
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const get = (externalId: string): Record<string, unknown> =>
  db.prepare('SELECT * FROM sessions WHERE external_id = ?').get(externalId) as Record<string, unknown>

const projectOf = (externalId: string): { id: number; path: string; name: string } =>
  db
    .prepare(
      `SELECT p.id, p.path, p.name FROM sessions s JOIN projects p ON p.id = s.project_id
       WHERE s.external_id = ?`
    )
    .get(externalId) as { id: number; path: string; name: string }

describe('ingest rename/cwd sync (content_hash gate)', () => {
  it('imports once, then skips when nothing changed', async () => {
    const first = await ingest.ingestSessions([session({ externalId: 's1' })])
    expect(first).toMatchObject({ imported: 1, updated: 0, skipped: 0 })
    const second = await ingest.ingestSessions([session({ externalId: 's1' })])
    expect(second).toMatchObject({ imported: 0, updated: 0, skipped: 1 })
  })

  it('syncs external title rename even when messages are unchanged', async () => {
    await ingest.ingestSessions([session({ externalId: 's1', title: 'old name' })])
    const res = await ingest.ingestSessions([session({ externalId: 's1', title: 'new name' })])
    expect(res).toMatchObject({ updated: 1, skipped: 0 })
    expect(get('s1').title).toBe('new name')
    // FTS follows the title (trigram needs >=3 chars)
    const hit = db
      .prepare('SELECT rowid FROM sessions_fts WHERE sessions_fts MATCH ?')
      .get('new name') as { rowid: number } | undefined
    expect(hit?.rowid).toBe(get('s1').id)
  })

  it('does not clobber a user-locked local title', async () => {
    const r = await ingest.ingestSessions([session({ externalId: 's1', title: 'external' })])
    const id = r.sessionIds[0]
    db.prepare('UPDATE sessions SET title = ?, title_locked = 1 WHERE id = ?').run('我的改名', id)
    await ingest.ingestSessions([session({ externalId: 's1', title: 'external renamed' })])
    expect(get('s1').title).toBe('我的改名')
  })

  it('adopts a renamed project folder instead of forking a duplicate group', async () => {
    await ingest.ingestSessions([session({ externalId: 's1', cwd: projA })])
    const oldProject = projectOf('s1')
    expect(oldProject.name).toBe('demo')

    // folder renamed on disk: old path gone, agent reports the new path
    fs.rmSync(projA, { recursive: true, force: true })
    const res = await ingest.ingestSessions([session({ externalId: 's1', cwd: projB })])
    expect(res).toMatchObject({ updated: 1 })

    const p = projectOf('s1')
    expect(p.path).toBe(projB)
    expect(p.name).toBe('money')
    // same row reused — no orphan "demo" project left behind
    expect(p.id).toBe(oldProject.id)
    const count = db.prepare('SELECT COUNT(*) AS n FROM projects WHERE deleted = 0').get() as { n: number }
    expect(count.n).toBe(1)
  })

  it('re-homes sibling sessions still on the old path when the folder is renamed', async () => {
    // two sessions under demo; only the second gets a fresh cwd from the agent
    await ingest.ingestSessions([
      session({ externalId: 'keep', cwd: projA }),
      session({ externalId: 'mover', cwd: projA })
    ])
    fs.rmSync(projA, { recursive: true, force: true })
    await ingest.ingestSessions([session({ externalId: 'mover', cwd: projB })])

    const keep = get('keep')
    expect(keep.cwd).toBe(projB)
    expect(keep.project_id).toBe(projectOf('mover').id)
    // subsequent scans with a stale agent cwd (old path gone) keep the re-homed path
    const again = await ingest.ingestSessions([session({ externalId: 'keep', cwd: projA })])
    expect(again.skipped + again.updated).toBe(1)
    expect(get('keep').cwd).toBe(projB)
  })

  it('keeps a live same-name project when a different folder shares the basename', async () => {
    const otherParent = path.join(tmp, 'elsewhere')
    fs.mkdirSync(otherParent, { recursive: true })
    const otherDemo = path.join(otherParent, 'demo')
    fs.mkdirSync(otherDemo, { recursive: true })
    await ingest.ingestSessions([session({ externalId: 's1', cwd: otherDemo })])

    // projA is a distinct live folder also named demo
    await ingest.ingestSessions([session({ externalId: 's2', cwd: projA })])
    const p1 = projectOf('s1')
    const p2 = projectOf('s2')
    expect(p1.id).not.toBe(p2.id)
    expect(p1.path).toBe(otherDemo)
    expect(p2.path).toBe(projA)
  })
})
