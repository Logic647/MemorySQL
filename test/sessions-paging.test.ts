import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { CORE_MIGRATIONS } from '../src/plugins/core-schema/migrations'
import coreSchema from '../src/plugins/core-schema'

type Handler = (payload?: unknown) => unknown

let db: Database.Database
const handlers = new Map<string, Handler>()

/**
 * Minimal PluginContext stub: only what core-schema's init touches. Handlers
 * are captured so the tests drive the exact IPC surface the renderer uses.
 */
function initPlugin(): void {
  handlers.clear()
  const stub = {
    id: 'core-schema',
    log: { info: (): void => {}, warn: (): void => {}, error: (): void => {} },
    env: {},
    db: {
      migrate: (migrations: Array<{ up: string }>): void => {
        for (const m of migrations) db.exec(m.up)
      },
      sqlite: db
    },
    settings: { get: (_k: string, d: unknown): unknown => d, set: (): void => {} },
    events: { on: (): (() => void) => () => {}, emit: (): void => {} },
    ipc: {
      handle: (name: string, h: Handler): void => {
        handlers.set(name, h)
      },
      call: async (): Promise<unknown> => undefined
    },
    mcp: { registerTool: (): void => {}, list: (): unknown[] => [] },
    watcher: { watch: (): (() => void) => () => {} },
    summarizer: { registerProvider: (): void => {}, pickActive: (): null => null },
    services: { provide: (): void => {}, use: (): never => { throw new Error('not provided') } }
  }
  ;(coreSchema.init as (ctx: unknown) => void)(stub)
}

beforeEach(() => {
  db = new Database(':memory:')
  // schema is applied by the stub's migrate() inside core-schema init,
  // mirroring what the real host does
  initPlugin()
})

function seedSession(id: number, messageCount: number): void {
  db.prepare(
    `INSERT INTO sessions (id, agent_type, external_id, title, summary, content_hash, updated_at)
     VALUES (?, 'codex', 'seed', '分页测试会话', '摘要', 'h', 1)`
  ).run(id)
  const ins = db.prepare(
    `INSERT INTO session_messages (session_id, seq, role, content, ts) VALUES (?, ?, 'user', ?, NULL)`
  )
  const tx = db.transaction((n: number): void => {
    for (let i = 0; i < n; i++) ins.run(id, i, `消息 ${i}`)
  })
  tx(messageCount)
}

describe('sessions:get tail paging', () => {
  it('returns the last page by default and reports hasMore/firstSeq/total', () => {
    seedSession(1, 450)
    const r = handlers.get('sessions:get')!({ id: 1 }) as {
      messages: Array<{ seq: number }>
      total: number
      hasMore: boolean
      firstSeq: number
    }
    expect(r.messages).toHaveLength(200)
    expect(r.messages[0].seq).toBe(250) // tail-first: 250..449
    expect(r.total).toBe(450)
    expect(r.hasMore).toBe(true)
    expect(r.firstSeq).toBe(250)
  })

  it('walks earlier pages with beforeSeq', () => {
    seedSession(1, 450)
    const page2 = handlers.get('sessions:get')!({ id: 1, beforeSeq: 250 }) as {
      messages: Array<{ seq: number }>
      hasMore: boolean
      firstSeq: number
    }
    expect(page2.messages[0].seq).toBe(50)
    expect(page2.messages).toHaveLength(200)
    expect(page2.hasMore).toBe(true)
    const page3 = handlers.get('sessions:get')!({ id: 1, beforeSeq: page2.firstSeq }) as {
      messages: Array<{ seq: number }>
      hasMore: boolean
    }
    expect(page3.messages).toHaveLength(50)
    expect(page3.hasMore).toBe(false)
  })

  it('small sessions come back complete with hasMore=false', () => {
    seedSession(1, 12)
    const r = handlers.get('sessions:get')!({ id: 1 }) as {
      messages: Array<{ seq: number }>
      hasMore: boolean
      total: number
    }
    expect(r.messages).toHaveLength(12)
    expect(r.total).toBe(12)
    expect(r.hasMore).toBe(false)
  })

  it('all=true lifts the cap (privacy export path)', () => {
    seedSession(1, 450)
    const r = handlers.get('sessions:get')!({ id: 1, all: true }) as {
      messages: Array<{ seq: number }>
      hasMore: boolean
    }
    expect(r.messages).toHaveLength(450)
    expect(r.hasMore).toBe(false)
  })
})

describe('memories:list paging', () => {
  it('supports limit/offset and defaults are applied', () => {
    const ins = db.prepare(
      `INSERT INTO memories (kind, content, source, status, updated_at) VALUES ('fact', ?, 't', 'active', ?)`
    )
    for (let i = 0; i < 7; i++) ins.run(`记忆 ${i}`, i)
    const all = handlers.get('memories:list')!() as unknown[]
    expect(all).toHaveLength(7)
    const page = handlers.get('memories:list')!({ limit: 3, offset: 2 }) as unknown[]
    expect(page).toHaveLength(3)
  })
})
