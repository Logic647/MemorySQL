import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CORE_MIGRATIONS } from '../src/plugins/core-schema/migrations'
import { createIngestService } from '../src/plugins/core-schema/ingest'
import memoryCore from '../src/plugins/memory-core/index'
import { EventBus } from '../src/main/core/event-bus'
import type { PluginContext } from '../src/main/core/plugin-host'

let db: Database.Database
let handlers: Map<string, (payload: unknown) => unknown>

function init(): void {
  const events = new EventBus()
  const memories = createIngestService({ sqlite: db, getSummarizer: () => null, onIngest: () => {} })
  const ctx = {
    id: 'memory-core',
    log: { info: () => {}, warn: () => {}, error: () => {} },
    db: { migrate: () => {}, sqlite: db },
    settings: { get: (_k: string, d: unknown) => d, set: () => {} },
    events,
    ipc: {
      handle: (name: string, h: (payload: unknown) => unknown) => handlers.set(name, h),
      call: async () => {}
    },
    mcp: { registerTool: () => {}, list: () => [] },
    watcher: { watch: () => () => {} },
    summarizer: { registerProvider: () => {}, pickActive: () => null },
    services: { provide: () => {}, use: (name: string) => (name === 'memories' ? memories : null) }
  } as unknown as PluginContext
  memoryCore.init(ctx)
}

beforeEach(() => {
  db = new Database(':memory:')
  for (const m of CORE_MIGRATIONS) db.exec(m.up)
  db.prepare(`INSERT INTO projects (id, path, name, updated_at) VALUES (1, 'C:\\demo', 'demo', 1)`).run()
  handlers = new Map()
  init()
})

afterEach(() => db.close())

describe('memory-core save/delete (scope + lock)', () => {
  it('new manual memory defaults to locked global', () => {
    const r = handlers.get('save')!({ kind: 'fact', content: '手写事实' }) as { id: number }
    const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(r.id) as Record<string, unknown>
    expect(row.scope).toBe('global')
    expect(row.project_id).toBeNull()
    expect(row.locked).toBe(1)
    expect(row.source).toBe('manual')
  })

  it('writes project scope and requires a project', () => {
    expect(() => handlers.get('save')!({ kind: 'fact', content: 'x', scope: 'project' })).toThrow()
    const r = handlers.get('save')!({
      kind: 'decision',
      content: '项目决策',
      scope: 'project',
      projectId: 1
    }) as { id: number }
    const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(r.id) as Record<string, unknown>
    expect(row.scope).toBe('project')
    expect(row.project_id).toBe(1)
    expect(row.locked).toBe(1)
  })

  it('editing an auto memory locks it; delete tombstones it; unlock re-enables curation', () => {
    const id = Number(
      db
        .prepare(
          `INSERT INTO memories (kind, content, source, status, updated_at, device_id, scope, locked)
           VALUES ('fact', '自动记忆', 'llm-curator:global', 'active', 1, 'local', 'global', 0)`
        )
        .run().lastInsertRowid
    )
    handlers.get('save')!({ id, kind: 'decision', content: '用户改过', scope: 'global' })
    let row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Record<string, unknown>
    expect(row.kind).toBe('decision')
    expect(row.content).toBe('用户改过')
    expect(row.locked).toBe(1)

    handlers.get('setLocked')!({ id, locked: false })
    row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Record<string, unknown>
    expect(row.locked).toBe(0)

    handlers.get('delete')!({ id })
    row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Record<string, unknown>
    expect(row.deleted).toBe(1)
  })
})
