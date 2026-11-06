import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CORE_MIGRATIONS } from '../src/plugins/core-schema/migrations'
import { createIngestService, type IngestService } from '../src/plugins/core-schema/ingest'
import type { RawMessage, RawSession } from '../src/shared/types'

let db: Database.Database
let ingest: IngestService
let tmp: string

function session(messages: RawMessage[], over: Partial<RawSession> = {}): RawSession {
  return { agentType: 'zcode', externalId: 's1', title: 't', cwd: tmp, messages, ...over }
}

const msg = (content: string, over: Partial<RawMessage> = {}): RawMessage => ({
  role: 'user',
  content,
  ...over
})

const rows = (): Array<{ id: number; seq: number; content: string }> =>
  db
    .prepare('SELECT id, seq, content FROM session_messages WHERE session_id = 1 ORDER BY seq')
    .all() as Array<{ id: number; seq: number; content: string }>

const ftsHits = (q: string): number =>
  (db.prepare('SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH ?').get(q) as {
    n: number
  }).n

beforeEach(async () => {
  db = new Database(':memory:')
  for (const m of CORE_MIGRATIONS) db.exec(m.up)
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-diff-'))
  ingest = createIngestService({ sqlite: db, getSummarizer: () => null, onIngest: () => {} })
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('ingest message-level diff', () => {
  it('appending one message keeps the existing rows (no full rewrite)', async () => {
    await ingest.ingestSessions([session([msg('alpha'), msg('bravo'), msg('charlie')])])
    const before = rows()
    expect(before).toHaveLength(3)

    const res = await ingest.ingestSessions([
      session([msg('alpha'), msg('bravo'), msg('charlie'), msg('delta')])
    ])
    expect(res).toMatchObject({ updated: 1, skipped: 0 })

    const after = rows()
    expect(after).toHaveLength(4)
    // prefix rowids survived: only the tail was rewritten
    expect(after.slice(0, 3).map((r) => r.id)).toEqual(before.map((r) => r.id))
    expect(after[3].content).toBe('delta')
    expect(after.map((r) => r.seq)).toEqual([0, 1, 2, 3])
  })

  it('rewrites from the first changed message and leaves the prefix alone', async () => {
    await ingest.ingestSessions([session([msg('alpha'), msg('bravo'), msg('charlie')])])
    const before = rows()

    await ingest.ingestSessions([session([msg('alpha'), msg('bravo2'), msg('charlie')])])

    const after = rows()
    expect(after[0].id).toBe(before[0].id)
    expect(after[1].content).toBe('bravo2')
    expect(after[2].content).toBe('charlie')
    // old FTS entry for the edited body is gone, new one present
    expect(ftsHits('bravo2')).toBe(1)
  })

  it('shrinking the session deletes only the removed tail', async () => {
    await ingest.ingestSessions([session([msg('alpha'), msg('bravo'), msg('charlie')])])
    const before = rows()

    await ingest.ingestSessions([session([msg('alpha')])])

    const after = rows()
    expect(after).toHaveLength(1)
    expect(after[0].id).toBe(before[0].id)
    expect(ftsHits('bravo')).toBe(0)
    expect(ftsHits('charlie')).toBe(0)
  })

  it('keeps ts / tool_name / meta when the diff is only in metadata', async () => {
    await ingest.ingestSessions([
      session([msg('alpha'), msg('tool out', { role: 'tool', toolName: 'bash', meta: { exit: 0 } })])
    ])
    await ingest.ingestSessions([
      session([
        msg('alpha'),
        msg('tool out', { role: 'tool', toolName: 'bash', meta: { exit: 0 } }),
        msg('new')
      ])
    ])
    const row = db
      .prepare('SELECT tool_name, meta FROM session_messages WHERE seq = 1')
      .get() as { tool_name: string; meta: string }
    expect(row.tool_name).toBe('bash')
    expect(JSON.parse(row.meta)).toEqual({ exit: 0 })
  })

  it('marks content_hash changed sessions as updated and keeps message_count in sync', async () => {
    await ingest.ingestSessions([session([msg('alpha')])])
    await ingest.ingestSessions([session([msg('alpha'), msg('bravo')])])
    const s = db
      .prepare('SELECT message_count FROM sessions WHERE external_id = ?')
      .get('s1') as { message_count: number }
    expect(s.message_count).toBe(2)
  })

  it('skips entirely when the session is unchanged', async () => {
    await ingest.ingestSessions([session([msg('alpha'), msg('bravo')])])
    const res = await ingest.ingestSessions([session([msg('alpha'), msg('bravo')])])
    expect(res).toMatchObject({ skipped: 1, updated: 0 })
  })
})
