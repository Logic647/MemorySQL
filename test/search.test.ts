import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { CORE_MIGRATIONS } from '../src/plugins/core-schema/migrations'
import { createSearchService } from '../src/plugins/core-schema/search'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  for (const m of CORE_MIGRATIONS) db.exec(m.up)
  return db
}

const addMemory = (db: Database.Database, content: string, extra = ''): number => {
  const res = db
    .prepare(
      `INSERT INTO memories (kind, content, source, status, updated_at) VALUES ('fact', ?, 'test', 'active', 1) ${extra}`
    )
    .run(content) as { lastInsertRowid: number | bigint }
  return Number(res.lastInsertRowid)
}

describe('search service — memory path', () => {
  it('finds memories by content with kind=memory', () => {
    const db = freshDb()
    const id = addMemory(db, '用户偏好深色主题的编辑器配色')
    const hits = createSearchService(db).searchAll('深色主题')
    const hit = hits.find((h) => h.kind === 'memory')
    expect(hit).toBeDefined()
    expect(hit?.id).toBe(id)
    expect(hit?.snippet).toContain('深色主题')
  })

  it('stays in sync on content update and tombstone (triggers)', () => {
    const db = freshDb()
    const id = addMemory(db, '原始记忆内容片段关于部署流程')
    const search = createSearchService(db)
    expect(search.searchAll('部署流程').some((h) => h.id === id)).toBe(true)

    db.prepare('UPDATE memories SET content = ? WHERE id = ?').run('更新后的记忆是关于回滚策略', id)
    expect(search.searchAll('部署流程').some((h) => h.id === id)).toBe(false)
    expect(search.searchAll('回滚策略').some((h) => h.id === id)).toBe(true)

    db.prepare('UPDATE memories SET deleted = 1 WHERE id = ?').run(id)
    expect(search.searchAll('回滚策略').some((h) => h.id === id)).toBe(false)
  })

  it('excludes retired memories', () => {
    const db = freshDb()
    addMemory(db, '活跃记忆关于测试策略的内容')
    addMemory(db, '退休记忆关于测试策略的内容', '')
    db.prepare(`UPDATE memories SET status = 'retired' WHERE content LIKE '退休%'`).run()
    const hits = createSearchService(db).searchAll('测试策略')
    expect(hits.filter((h) => h.kind === 'memory')).toHaveLength(1)
  })

  it('falls back to LIKE for queries shorter than trigram minimum', () => {
    const db = freshDb()
    const id = addMemory(db, '图谱笔记与双向链接')
    const hits = createSearchService(db).searchAll('图谱')
    expect(hits.some((h) => h.kind === 'memory' && h.id === id)).toBe(true)
  })
})

describe('search service — 笔记已下线', () => {
  it('不再返回 note 类命中(检索只剩会话/消息/记忆)', () => {
    const db = freshDb()
    addMemory(db, '没有笔记表时的记忆内容样例')
    const hits = createSearchService(db).searchAll('记忆内容样例')
    expect(hits.some((h) => h.kind === 'memory')).toBe(true)
    expect(hits.some((h) => (h.kind as string) === 'note')).toBe(false)
  })
})
