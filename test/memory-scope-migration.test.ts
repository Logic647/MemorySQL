import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { CORE_MIGRATIONS } from '../src/plugins/core-schema/migrations'

describe('memories v9 migration (global/project scope + lock + heat)', () => {
  it('backfills existing rows: project_id set → project, otherwise global', () => {
    const db = new Database(':memory:')
    for (const m of CORE_MIGRATIONS.filter((x) => x.version <= 8)) db.exec(m.up)
    db.prepare(`INSERT INTO projects (id, path, name, updated_at) VALUES (1, 'C:\\demo', 'demo', 1)`).run()
    db.prepare(
      `INSERT INTO memories (kind, content, status, updated_at, project_id) VALUES ('fact', '项目里的旧记忆', 'active', 1, 1)`
    ).run()
    db.prepare(
      `INSERT INTO memories (kind, content, status, updated_at) VALUES ('preference', '全局旧记忆', 'active', 2)`
    ).run()

    const v9 = CORE_MIGRATIONS.find((m) => m.version === 9)
    expect(v9).toBeTruthy()
    db.exec(v9!.up)

    const project = db
      .prepare(`SELECT scope, locked, access_count, last_access_at FROM memories WHERE content = '项目里的旧记忆'`)
      .get() as Record<string, unknown>
    const global = db
      .prepare(`SELECT scope, locked, access_count, last_access_at FROM memories WHERE content = '全局旧记忆'`)
      .get() as Record<string, unknown>
    expect(project).toEqual({ scope: 'project', locked: 0, access_count: 0, last_access_at: null })
    expect(global).toEqual({ scope: 'global', locked: 0, access_count: 0, last_access_at: null })

    // 索引存在(仅验证名称,不依赖 query plan)
    const idx = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memories_scope'`)
      .get() as { name: string } | undefined
    expect(idx?.name).toBe('idx_memories_scope')
    db.close()
  })
})
