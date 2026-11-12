import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { CORE_MIGRATIONS } from '../src/plugins/core-schema/migrations'
import { mergeBundle, type SyncBundle } from '../src/plugins/sync-folder/sync-merge'

/**
 * 记忆分层(2026-11-12)与 sync-folder 的交叉验证:
 * bundle 必须携带 scope/项目/锁定/状态,否则项目记忆在另一台机器上
 * 会落成 global、retired 会复活、locked 会被 curator 覆盖。
 */
let db: Database.Database

const bundle = (memories: SyncBundle['memories'], projects: SyncBundle['projects'] = []): SyncBundle => ({
  device: 'dev-A',
  exportedAt: Date.now(),
  since: 0,
  sessions: [],
  messages: [],
  memories,
  projects
})

const localMemory = (content: string): Record<string, unknown> | undefined =>
  db
    .prepare(
      `SELECT kind, content, source, status, locked, scope, project_id, agent_type FROM memories WHERE content = ?`
    )
    .get(content) as Record<string, unknown> | undefined

beforeEach(() => {
  db = new Database(':memory:')
  for (const m of CORE_MIGRATIONS) db.exec(m.up)
})

describe('sync-folder memory scope merge', () => {
  it('项目记忆按 path 落到本地项目,locked/status/agent 随包携带', () => {
    const projectId = Number(
      db
        .prepare(`INSERT INTO projects (path, name, updated_at, device_id) VALUES (?, ?, ?, 'local')`)
        .run('H:\\work\\alpha', 'alpha', Date.now()).lastInsertRowid
    )
    const r = mergeBundle(db, bundle(
      [
        {
          kind: 'fact',
          content: 'alpha 项目使用 SQLite',
          source: 'llm-curator:project:1',
          updated_at: 1000,
          device_id: 'dev-A',
          scope: 'project',
          status: 'active',
          locked: 1,
          agent_type: null,
          project_path: 'H:\\work\\alpha',
          project_name: 'alpha'
        },
        {
          kind: 'fact',
          content: '旧版事实已被取代',
          source: 'project-digest:1',
          updated_at: 900,
          device_id: 'dev-A',
          scope: 'project',
          status: 'retired',
          locked: 0,
          agent_type: null,
          project_path: 'H:\\work\\alpha',
          project_name: 'alpha'
        }
      ],
      [{ path: 'H:\\work\\alpha', name: 'alpha', tech_stack: null, updated_at: 1000 }]
    ))
    expect(r.memoriesAdded).toBe(2)
    expect(r.projectsAdded).toBe(0)

    const kept = localMemory('alpha 项目使用 SQLite')
    expect(kept).toMatchObject({ scope: 'project', project_id: projectId, locked: 1, status: 'active' })
    const retired = localMemory('旧版事实已被取代')
    expect(retired?.status).toBe('retired')
    // retired 不得在对端复活后参与注入/检索
    const fts = db
      .prepare(`SELECT COUNT(*) AS n FROM memories WHERE status = 'active' AND content = '旧版事实已被取代'`)
      .get() as { n: number }
    expect(fts.n).toBe(0)
  })

  it('bundle.projects 段没带的项目按 path 兜底创建', () => {
    const r = mergeBundle(db, bundle([
      {
        kind: 'preference',
        content: 'beta 项目偏好中文注释',
        source: 'llm-curator:project:9',
        updated_at: 1000,
        device_id: 'dev-A',
        scope: 'project',
        status: 'active',
        locked: 0,
        agent_type: null,
        project_path: 'H:\\work\\beta',
        project_name: 'beta'
      }
    ]))
    expect(r.memoriesAdded).toBe(1)
    expect(r.projectsAdded).toBe(1)
    const proj = db
      .prepare(`SELECT id, name FROM projects WHERE path = ?`)
      .get('H:\\work\\beta') as { id: number; name: string }
    expect(proj.name).toBe('beta')
    expect(localMemory('beta 项目偏好中文注释')).toMatchObject({ scope: 'project', project_id: proj.id })
  })

  it('旧版 bundle(无 scope 字段)仍按 global/active 合并,不丢数据', () => {
    const r = mergeBundle(db, bundle([
      {
        kind: 'persona',
        content: '旧版全局画像',
        source: 'manual',
        updated_at: 1000,
        device_id: 'dev-A'
      }
    ]))
    expect(r.memoriesAdded).toBe(1)
    expect(r.projectsAdded).toBe(0)
    expect(localMemory('旧版全局画像')).toMatchObject({ scope: 'global', status: 'active', locked: 0 })
  })

  it('内容相同的记忆不重复写入(content union 不变)', () => {
    db.prepare(
      `INSERT INTO projects (id, path, name, updated_at, device_id) VALUES (1, 'H:\\work\\gamma', 'gamma', 500, 'local')`
    ).run()
    db.prepare(
      `INSERT INTO memories (kind, content, source, status, updated_at, device_id, scope, project_id)
       VALUES ('fact', '同一句话', 'manual', 'active', 500, 'local', 'project', 1)`
    ).run()
    const r = mergeBundle(db, bundle([
      {
        kind: 'fact',
        content: '同一句话',
        source: 'llm-curator:project:1',
        updated_at: 1000,
        device_id: 'dev-A',
        scope: 'project',
        status: 'active',
        locked: 0,
        agent_type: null,
        project_path: 'H:\\work\\gamma',
        project_name: 'gamma'
      }
    ]))
    expect(r.memoriesAdded).toBe(0)
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE content = '同一句话'`).get() as { n: number }).n
    ).toBe(1)
  })
})
