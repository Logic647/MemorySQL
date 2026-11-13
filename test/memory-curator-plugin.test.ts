import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CORE_MIGRATIONS } from '../src/plugins/core-schema/migrations'
import { DIGEST_MIGRATIONS } from '../src/plugins/project-digest/migrations'
import { CURATOR_MIGRATIONS } from '../src/plugins/memory-curator/migrations'
import curatorPlugin from '../src/plugins/memory-curator/index'
import { EventBus } from '../src/main/core/event-bus'
import type { PluginContext } from '../src/main/core/plugin-host'

let db: Database.Database
let events: EventBus
let settings: Map<string, unknown>
let handlers: Map<string, (payload: unknown) => unknown>
let projectMemoryId: number
let lockedMemoryId: number

let refineCalls: Array<{ prompt: string; opts?: { system?: string; maxTokens?: number; timeoutMs?: number } }> = []
let refineImpl: (
  prompt: string,
  opts?: { system?: string; maxTokens?: number; timeoutMs?: number }
) => Promise<string>

const defaultRefine = async (
  _prompt: string,
  opts?: { system?: string }
): Promise<string> => {
  const system = opts?.system ?? ''
  if (system.includes('项目记忆整理器')) {
    return JSON.stringify({
      project: [
        { op: 'add', kind: 'fact', content: '新项目事实', confidence: 0.8 },
        { op: 'update', id: projectMemoryId, kind: 'fact', content: '更新后的项目事实', confidence: 0.9 }
      ]
    })
  }
  if (system.includes('全局记忆整理器')) {
    return JSON.stringify({
      global: [{ op: 'add', kind: 'preference', content: '新全局偏好', confidence: 0.8 }]
    })
  }
  return ''
}

const refine = {
  available: () => true,
  describe: () => 'mock',
  refine: async (
    prompt: string,
    opts?: { system?: string; maxTokens?: number; timeoutMs?: number }
  ): Promise<string> => {
    refineCalls.push({ prompt, opts })
    return refineImpl(prompt, opts)
  }
}

function initPlugin(): void {
  const ctx = {
    id: 'memory-curator',
    log: { info: () => {}, warn: () => {}, error: () => {} },
    db: { migrate: () => {}, sqlite: db },
    settings: {
      get: (k: string, d: unknown) => (settings.has(k) ? settings.get(k) : d),
      set: (k: string, v: unknown) => settings.set(k, v)
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

beforeEach(() => {
  db = new Database(':memory:')
  for (const m of CORE_MIGRATIONS) db.exec(m.up)
  for (const m of DIGEST_MIGRATIONS) db.exec(m.up)
  for (const m of CURATOR_MIGRATIONS) db.exec(m.up)
  events = new EventBus()
  settings = new Map<string, unknown>([
    ['enabled', true],
    ['maxProject', 80],
    ['maxGlobal', 40],
    ['globalEveryHours', 24]
  ])
  handlers = new Map<string, (payload: unknown) => unknown>()
  refineCalls = []
  refineImpl = defaultRefine

  db.prepare(`INSERT INTO projects (id, path, name, updated_at) VALUES (1, 'C:\\demo', 'demo', 1)`).run()
  projectMemoryId = Number(
    db
      .prepare(
        `INSERT INTO memories (kind, content, source, status, updated_at, device_id, scope, project_id, locked)
         VALUES ('fact', '旧项目事实', 'test', 'active', 1, 'local', 'project', 1, 0)`
      )
      .run().lastInsertRowid
  )
  lockedMemoryId = Number(
    db
      .prepare(
        `INSERT INTO memories (kind, content, source, status, updated_at, device_id, scope, project_id, locked)
         VALUES ('decision', '用户手写项目决策', 'manual', 'active', 1, 'local', 'project', 1, 1)`
      )
      .run().lastInsertRowid
  )
  db.prepare(
    `INSERT INTO memories (kind, content, source, status, updated_at, device_id, scope, locked)
     VALUES ('preference', '旧全局偏好', 'test', 'active', 1, 'local', 'global', 0)`
  ).run()
  // 旧候选链路:规则提炼候选应被自动整理接管(retire),收工汇报候选要保留
  // (它还是项目总结「待确认进度」的素材)
  db.prepare(
    `INSERT INTO memories (kind, content, source, status, updated_at, device_id, scope, project_id)
     VALUES ('fact', '规则提炼的旧候选', 'distill:zcode:1', 'candidate', 1, 'local', 'project', 1)`
  ).run()
  db.prepare(
    `INSERT INTO memories (kind, content, source, status, updated_at, device_id, scope, project_id)
     VALUES ('fact', '收工汇报候选', 'agent:mcp:log_progress', 'candidate', 1, 'local', 'project', 1)`
  ).run()
  db.prepare(
    `INSERT INTO project_digests
       (project_id, period_start, period_end, summary, recent, per_session, todos, decisions, model, sessions_covered, created_at, updated_at)
     VALUES (1, 1, 2, '项目总览', '最近改了 a.ts', '[]', '[]', '[]', 'llm:mock', 2, ?, ?)`
  ).run(Date.now(), Date.now())
  initPlugin()
})

afterEach(() => {
  db.close()
})

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('memory-curator plugin', () => {
  it('digest:completed 触发项目整理,自动生效且不动用户锁定条目', async () => {
    events.emit('digest:completed', { projectId: 1, digestId: 1 })
    await wait(150)
    const projectRows = db
      .prepare(`SELECT id, kind, content, source, locked, status FROM memories WHERE scope = 'project' AND project_id = 1`)
      .all() as Array<Record<string, unknown>>
    expect(projectRows.some((r) => r.content === '新项目事实')).toBe(true)
    expect(projectRows.some((r) => r.content === '更新后的项目事实')).toBe(true)
    const locked = projectRows.find((r) => r.id === lockedMemoryId)
    expect(locked?.content).toBe('用户手写项目决策')
    expect(locked?.locked).toBe(1)
    const added = projectRows.find((r) => r.content === '新项目事实')
    expect(added?.source).toBe('llm-curator:project:1')
    expect(added?.status).toBe('active')
    // 规则提炼候选被自动整理接管;收工汇报候选保留(仍是总结素材)
    const distilled = projectRows.find((r) => r.content === '规则提炼的旧候选')
    expect(distilled?.status).toBe('retired')
    const progress = projectRows.find((r) => r.content === '收工汇报候选')
    expect(progress?.status).toBe('candidate')
    // 状态表记录 digest id,重复事件不会再次调用
    const state = db.prepare(`SELECT * FROM memory_curation_state WHERE project_id = 1`).get() as Record<string, unknown>
    expect(state.last_digest_id).toBe(1)
  })

  it('项目整理后按间隔触发全局汇总', async () => {
    events.emit('digest:completed', { projectId: 1, digestId: 1 })
    await wait(250)
    const global = db
      .prepare(`SELECT * FROM memories WHERE scope = 'global' AND content = '新全局偏好'`)
      .get() as Record<string, unknown> | undefined
    expect(global).toBeTruthy()
    expect(global?.source).toBe('llm-curator:global')
    const state = db.prepare(`SELECT * FROM memory_curation_state WHERE project_id = 0`).get() as Record<string, unknown>
    expect(state.last_run_at).toBeTruthy()
  })

  it('status IPC 返回项目/全局状态与 LLM 可用性', async () => {
    const status = await handlers.get('status')!({}) as {
      enabled: boolean
      llmReady: boolean
      projects: Array<{ projectId: number; memoryCount: number }>
      global: { memoryCount: number }
    }
    expect(status.enabled).toBe(true)
    expect(status.llmReady).toBe(true)
    expect(status.projects[0]).toMatchObject({ projectId: 1, memoryCount: 2 })
    expect(status.global.memoryCount).toBe(1)
  })

  it('LLM abort/超时自动重试一次,整理带 120s 超时与更大 token 预算', async () => {
    let first = true
    refineImpl = async (prompt, opts) => {
      if ((opts?.system ?? '').includes('项目记忆整理器') && first) {
        first = false
        throw new Error('This operation was aborted')
      }
      return defaultRefine(prompt, opts)
    }
    events.emit('digest:completed', { projectId: 1, digestId: 1 })
    // 首次失败后 curator 等 1.5s 再重试
    await wait(2500)

    const added = db.prepare(`SELECT status FROM memories WHERE content = '新项目事实'`).get() as
      | { status: string }
      | undefined
    expect(added?.status).toBe('active')
    const projectCalls = refineCalls.filter((c) => (c.opts?.system ?? '').includes('项目记忆整理器'))
    expect(projectCalls.length).toBeGreaterThanOrEqual(2)
    expect(projectCalls[0].opts?.timeoutMs).toBe(120_000)
    expect(projectCalls[0].opts?.maxTokens).toBe(5000)
    const state = db
      .prepare(`SELECT last_error, status FROM memory_curation_state WHERE project_id = 1`)
      .get() as { last_error: string | null; status: string }
    expect(state.last_error).toBeNull()
    expect(state.status).toBe('idle')
  })

  it('模型回「没有需要变更的记忆」按无变更处理,不记失败也不重试', async () => {
    refineImpl = async (_prompt, opts) => {
      if ((opts?.system ?? '').includes('项目记忆整理器')) return '没有需要变更的记忆。'
      return JSON.stringify({ global: [] })
    }
    events.emit('digest:completed', { projectId: 1, digestId: 1 })
    await wait(300)

    const projectCalls = refineCalls.filter((c) => (c.opts?.system ?? '').includes('项目记忆整理器'))
    expect(projectCalls).toHaveLength(1)
    const state = db
      .prepare(`SELECT last_error, last_digest_id FROM memory_curation_state WHERE project_id = 1`)
      .get() as { last_error: string | null; last_digest_id: number | null }
    expect(state.last_error).toBeNull()
    expect(state.last_digest_id).toBe(1)
  })

  it('输出不是 JSON 时用严格提示重试一次', async () => {
    let n = 0
    refineImpl = async (_prompt, opts) => {
      if ((opts?.system ?? '').includes('项目记忆整理器')) {
        n++
        if (n === 1) return '好的,我先分析一下这份总结……'
        return JSON.stringify({ project: [{ op: 'add', kind: 'fact', content: '严格重试后的记忆' }] })
      }
      return JSON.stringify({ global: [] })
    }
    events.emit('digest:completed', { projectId: 1, digestId: 1 })
    await wait(500)

    const added = db
      .prepare(`SELECT status FROM memories WHERE content = '严格重试后的记忆'`)
      .get() as { status: string } | undefined
    expect(added?.status).toBe('active')
    const projectCalls = refineCalls.filter((c) => (c.opts?.system ?? '').includes('项目记忆整理器'))
    expect(projectCalls).toHaveLength(2)
    expect(projectCalls[1].opts?.system).toContain('上一次输出无法解析')
  })
})
