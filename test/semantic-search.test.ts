import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { getLoadablePath } from 'sqlite-vec'
import { CORE_MIGRATIONS } from '../src/plugins/core-schema/migrations'
import { createSemanticCore, type SemanticCore } from '../src/plugins/semantic-search/core'

let db: Database.Database

// deterministic char-bigram hashing embedder: same text -> same vector,
// shared bigrams pull vectors closer — good enough to prove the plumbing
function fakeEmbed(texts: string[]): number[][] {
  return texts.map((t) => {
    const v = new Array(16).fill(0)
    const s = t.toLowerCase()
    for (let i = 0; i < s.length - 1; i++) {
      const idx = (s.charCodeAt(i) * 31 + s.charCodeAt(i + 1)) % 16
      v[idx] += 1
    }
    const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1
    return v.map((x) => x / norm)
  })
}

function core(): SemanticCore {
  return createSemanticCore({
    sqlite: db,
    embedDocs: async (texts) => fakeEmbed(texts),
    embedQuery: async (q) => fakeEmbed([q])[0],
    dims: 16,
    model: 'fake-16'
  })
}

beforeEach(() => {
  db = new Database(':memory:')
  // mirror the plugin: vec0 must be loaded before the virtual table exists
  db.loadExtension(getLoadablePath())
  for (const m of CORE_MIGRATIONS) db.exec(m.up)
})

describe('semantic core', () => {
  it('indexes active memories and sessions, skips retired/empty', async () => {
    db.prepare(
      `INSERT INTO memories (kind, content, source, status, updated_at) VALUES ('fact', '部署流程是先构建再上传', 't', 'active', 1)`
    ).run()
    db.prepare(
      `INSERT INTO memories (kind, content, source, status, updated_at) VALUES ('decision', '退休的旧结论', 't', 'retired', 2)`
    ).run()
    db.prepare(
      `INSERT INTO sessions (agent_type, external_id, title, summary, content_hash, updated_at) VALUES ('codex', 's1', '部署自动化改造', '把部署流程脚本化', 'h', 3)`
    ).run()
    const res = await core().sync()
    expect(res.embedded).toBe(2)
    expect(core().stats().rows).toBe(2)
  })

  it('ranks the exact-topic row first', async () => {
    db.prepare(
      `INSERT INTO memories (kind, content, source, status, updated_at) VALUES ('fact', '部署流程是先构建再上传', 't', 'active', 1)`
    ).run()
    db.prepare(
      `INSERT INTO sessions (agent_type, external_id, title, summary, content_hash, updated_at) VALUES ('codex', 's1', '完全无关的会话标题', '别的内容', 'h', 2)`
    ).run()
    const c = core()
    await c.sync()
    const hits = await c.search('部署流程是先构建再上传', 2)
    expect(hits[0]?.kind).toBe('memory')
    expect(hits[0]?.score).toBeGreaterThan(0.99) // identical text -> distance ~0
  })

  it('keeps memory ids and session ids from colliding', async () => {
    // both tables get id 1 — semantic_refs must use its own keyspace
    db.prepare(
      `INSERT INTO memories (kind, content, source, status, updated_at) VALUES ('fact', '记忆一号内容', 't', 'active', 1)`
    ).run()
    db.prepare(
      `INSERT INTO sessions (agent_type, external_id, title, summary, content_hash, updated_at) VALUES ('codex', 's1', '会话一号', '会话一号摘要', 'h', 2)`
    ).run()
    const c = core()
    await c.sync()
    expect(c.stats().rows).toBe(2)
    const memHits = await c.search('记忆一号内容', 2)
    const sesHits = await c.search('会话一号', 2)
    expect(memHits[0]).toMatchObject({ kind: 'memory', refId: 1 })
    expect(sesHits[0]).toMatchObject({ kind: 'session', refId: 1 })
  })

  it('re-embeds changed content and drops deleted sources on sync', async () => {
    const ins = db.prepare(
      `INSERT INTO memories (kind, content, source, status, updated_at) VALUES ('fact', ?, 't', 'active', 1)`
    )
    ins.run('旧的内容关于缓存策略')
    const c = core()
    await c.sync()
    db.prepare('UPDATE memories SET content = ?').run('全新的内容关于限流策略')
    const res2 = await c.sync()
    expect(res2.embedded).toBe(1)
    expect((await c.search('限流策略', 1))[0]?.kind).toBe('memory')
    expect((await c.search('缓存策略', 1)).length).toBeGreaterThan(0) // session absent, but vector of new content differs — just ensure no crash
    db.prepare('DELETE FROM memories').run()
    const res3 = await c.sync()
    expect(res3.removed).toBeGreaterThanOrEqual(1)
    expect(core().stats().rows).toBe(0)
  })
})
