import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CORE_MIGRATIONS } from '../src/plugins/core-schema/migrations'
import { createSearchService } from '../src/plugins/core-schema/search'
import { createIngestService } from '../src/plugins/core-schema/ingest'
import { createMcpTools } from '../src/plugins/core-schema/mcp-tools'
import { DIGEST_MIGRATIONS } from '../src/plugins/project-digest/migrations'
import { CURATOR_MIGRATIONS } from '../src/plugins/memory-curator/migrations'
import curatorPlugin from '../src/plugins/memory-curator/index'
import { EventBus } from '../src/main/core/event-bus'
import type { PluginContext } from '../src/main/core/plugin-host'

/**
 * 验收用测试:真实表结构 + 真实插件 + 假 LLM。
 *
 * 跑法:
 *   npx vitest run test/memory-e2e.test.ts --reporter=verbose
 *
 * 它覆盖用户可见的完整链路:
 *   项目总结完成 → memory-curator 自动整理 → 全局/项目记忆写入
 *   → memory_get_context 按「全局记忆 → 项目记忆 → 总结 → 最近进展」注入
 *   → 用户锁定条目不被覆盖、项目过滤不串项目、热度计数生效。
 */
let db: Database.Database
let events: EventBus
let handlers: Map<string, (payload: unknown) => unknown>
let projectId: number
let otherProjectId: number
let oldFactId: number
let lockedId: number

const refine = {
  available: () => true,
  describe: () => 'mock-llm',
  refine: async (_prompt: string, opts?: { system?: string }): Promise<string> => {
    const system = opts?.system ?? ''
    if (system.includes('项目记忆整理器')) {
      return JSON.stringify({
        project: [
          { op: 'add', kind: 'fact', content: '项目使用 SQLite 存储会话', confidence: 0.9 },
          { op: 'update', id: oldFactId, kind: 'fact', content: '更新后的项目事实', confidence: 0.9 }
        ]
      })
    }
    if (system.includes('全局记忆整理器')) {
      return JSON.stringify({
        global: [{ op: 'add', kind: 'preference', content: '用户偏好 TypeScript', confidence: 0.9 }]
      })
    }
    return ''
  }
}

function initCurator(): void {
  const ctx = {
    id: 'memory-curator',
    log: { info: () => {}, warn: () => {}, error: () => {} },
    db: { migrate: () => {}, sqlite: db },
    settings: {
      get: (k: string, d: unknown) =>
        ({
          enabled: true,
          maxProject: 80,
          maxGlobal: 40,
          globalEveryHours: 24
        })[k] ?? d,
      set: () => {}
    },
    events,
    ipc: {
      handle: (name: string, h: (payload: unknown) => unknown) => handlers.set(name, h),
      call: async (channel: string) => {
        if (channel === 'project-digest:status') return { enabled: true }
        throw new Error(`unexpected channel ${channel}`)
      }
    },
    mcp: { registerTool: () => {}, list: () => [] },
    watcher: { watch: () => () => {} },
    summarizer: { registerProvider: () => {}, pickActive: () => null },
    services: {
      provide: () => {},
      use: (name: string) => {
        if (name === 'llm-refine') return refine
        throw new Error(`Service not available: ${name}`)
      }
    }
  } as unknown as PluginContext
  curatorPlugin.init(ctx)
}

function addMemory(input: {
  kind: string
  content: string
  scope: 'global' | 'project'
  projectId?: number | null
  locked?: number
  source?: string
}): number {
  return Number(
    db
      .prepare(
        `INSERT INTO memories
           (kind, content, source, status, updated_at, device_id, scope, project_id, locked, confidence)
         VALUES (?, ?, ?, 'active', ?, 'local', ?, ?, ?, 1)`
      )
      .run(
        input.kind,
        input.content,
        input.source ?? 'test',
        Date.now(),
        input.scope,
        input.projectId ?? null,
        input.locked ?? 0
      ).lastInsertRowid
  )
}

function tools() {
  return createMcpTools({
    sqlite: db,
    search: createSearchService(db),
    memories: createIngestService({ sqlite: db, getSummarizer: () => null, onIngest: () => {} }),
    services: {
      use: () => {
        throw new Error('Service not provided')
      }
    }
  })
}

const call = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
  const tool = tools().find((t) => t.name === name)
  if (!tool) throw new Error(`missing tool ${name}`)
  return String(await tool.handler(args))
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  db = new Database(':memory:')
  for (const m of CORE_MIGRATIONS) db.exec(m.up)
  for (const m of DIGEST_MIGRATIONS) db.exec(m.up)
  for (const m of CURATOR_MIGRATIONS) db.exec(m.up)
  events = new EventBus()
  handlers = new Map()

  projectId = Number(
    db
      .prepare(`INSERT INTO projects (path, name, updated_at, tech_stack) VALUES (?, ?, ?, ?)`)
      .run('C:\\demo\\memory-e2e', 'memory-e2e', Date.now(), 'TypeScript + SQLite').lastInsertRowid
  )
  otherProjectId = Number(
    db
      .prepare(`INSERT INTO projects (path, name, updated_at) VALUES (?, ?, ?)`)
      .run('C:\\demo\\other-project', 'other-project', Date.now()).lastInsertRowid
  )
  db.prepare(
    `INSERT INTO sessions (agent_type, external_id, project_id, title, summary, started_at, last_message_at, message_count, tool_call_count, content_hash, updated_at)
     VALUES ('zcode', 'demo-s1', ?, '实现记忆整理', '完成了项目总结到记忆的链路', ?, ?, 12, 3, 'h-demo-1', ?)`
  ).run(
    projectId,
    Math.floor(Date.now() / 1000) - 3600,
    Math.floor(Date.now() / 1000) - 1800,
    Date.now()
  )
  db.prepare(
    `INSERT INTO session_messages (session_id, seq, role, content, ts) VALUES (1, 0, 'user', '帮我加项目/全局记忆', ?)`
  ).run(Math.floor(Date.now() / 1000))
  db.prepare(
    `INSERT INTO project_digests
       (project_id, period_start, period_end, summary, recent, per_session, todos, decisions, model, sessions_covered, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '[]', ?, ?, 'llm:mock', 1, ?, ?)`
  ).run(
    projectId,
    Math.floor(Date.now() / 1000) - 7200,
    Math.floor(Date.now() / 1000) - 1800,
    '项目总览: 本地优先知识库,TypeScript + SQLite。',
    '最近进展: 实现了 digest 拆分,修了 memory_get_context 的项目记忆注入。',
    JSON.stringify([{ content: '补测试', status: 'open' }]),
    JSON.stringify(['使用 SQLite 作为权威存储']),
    Date.now(),
    Date.now()
  )

  addMemory({ kind: 'persona', content: '用户是后端工程师', scope: 'global', locked: 1 })
  addMemory({ kind: 'preference', content: '偏好中文注释', scope: 'global' })
  oldFactId = addMemory({ kind: 'fact', content: '旧项目事实', scope: 'project', projectId })
  addMemory({ kind: 'fact', content: '本项目 SQLite 专属事实', scope: 'project', projectId })
  addMemory({ kind: 'fact', content: '全局 SQLite 约定', scope: 'global' })
  lockedId = addMemory({
    kind: 'decision',
    content: '用户手写项目决策:不要自动改这条',
    scope: 'project',
    projectId,
    locked: 1,
    source: 'manual'
  })
  addMemory({
    kind: 'fact',
    content: '别的项目 SQLite 专属事实,不应出现在本项目的上下文',
    scope: 'project',
    projectId: otherProjectId
  })
  initCurator()
})

afterEach(() => {
  db.close()
})

describe('memory e2e(总结 → 自动整理 → 注入)', () => {
  it('项目总结完成后自动整理项目/全局记忆,并按记忆→总结顺序注入', async () => {
    events.emit('digest:completed', { projectId, digestId: 1 })
    await wait(300)

    // 项目/全局记忆自动写入
    const projectRows = db
      .prepare(`SELECT id, content, source, scope, project_id, status, locked FROM memories WHERE scope = 'project' AND project_id = ?`)
      .all(projectId) as Array<Record<string, unknown>>
    expect(projectRows.some((r) => r.content === '项目使用 SQLite 存储会话')).toBe(true)
    expect(projectRows.some((r) => r.content === '更新后的项目事实')).toBe(true)
    expect(projectRows.find((r) => r.id === lockedId)?.content).toBe(
      '用户手写项目决策:不要自动改这条'
    )
    const added = projectRows.find((r) => r.content === '项目使用 SQLite 存储会话')
    expect(added?.source).toBe(`llm-curator:project:${projectId}`)
    expect(added?.status).toBe('active')

    const globalNew = db
      .prepare(`SELECT content, source, scope FROM memories WHERE content = '用户偏好 TypeScript'`)
      .get() as Record<string, unknown> | undefined
    expect(globalNew).toMatchObject({ source: 'llm-curator:global', scope: 'global' })

    // 注入顺序与内容
    const ctx = await call('memory_get_context', { project: 'memory-e2e' })
    expect(ctx).toContain('## 全局记忆')
    expect(ctx).toContain('用户是后端工程师')
    expect(ctx).toContain('用户偏好 TypeScript')
    expect(ctx).toContain('## 项目记忆: memory-e2e')
    expect(ctx).toContain('项目使用 SQLite 存储会话')
    expect(ctx).toContain('用户手写项目决策')
    expect(ctx).toContain('## 项目总结')
    expect(ctx).toContain('项目总览: 本地优先知识库')
    expect(ctx).toContain('最近进展:')
    expect(ctx).toContain('实现了 digest 拆分')
    expect(ctx).not.toContain('别的项目专属事实')

    const gi = ctx.indexOf('## 全局记忆')
    const pi = ctx.indexOf('## 项目记忆:')
    const si = ctx.indexOf('## 项目总结')
    const ri = ctx.indexOf('最近进展:')
    expect(gi).toBeGreaterThanOrEqual(0)
    expect(gi).toBeLessThan(pi)
    expect(pi).toBeLessThan(si)
    expect(si).toBeLessThan(ri)

    // 注入会累加热度
    const touched = db
      .prepare(`SELECT access_count, last_access_at FROM memories WHERE content = '项目使用 SQLite 存储会话'`)
      .get() as { access_count: number; last_access_at: number | null }
    expect(touched.access_count).toBeGreaterThan(0)
    expect(touched.last_access_at).not.toBeNull()
  })

  it('项目过滤的记忆搜索只返回本项目记忆 + 全局记忆', () => {
    const hits = createSearchService(db).searchAll('SQLite', 20, {
      kinds: ['memory'],
      projectIds: [projectId]
    })
    const contents = hits.map((h) => h.snippet)
    expect(contents.some((c) => c.includes('本项目') && c.includes('SQLite'))).toBe(true)
    expect(contents.some((c) => c.includes('别的项目'))).toBe(false)
    expect(hits.some((h) => h.scope === 'global')).toBe(true)
  })
})
