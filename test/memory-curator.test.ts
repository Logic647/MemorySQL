import Database from 'better-sqlite3'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { CORE_MIGRATIONS } from '../src/plugins/core-schema/migrations'
import { CURATOR_MIGRATIONS } from '../src/plugins/memory-curator/migrations'
import {
  applyCuration,
  buildGlobalCurationPrompt,
  buildProjectCurationPrompt,
  heatScore,
  parseGlobalOps,
  parseProjectOps,
  projectSystemPrompt,
  type CuratorMemoryRow
} from '../src/plugins/memory-curator/curate'

let db: Database.Database
let projectId: number

function addMemory(input: {
  id?: number
  kind?: string
  content: string
  scope?: 'global' | 'project'
  project?: number | null
  locked?: number
  confidence?: number
  access?: number
  lastAccess?: number | null
  updated?: number
}): number {
  const id = db
    .prepare(
      `INSERT INTO memories
         (id, kind, content, source, confidence, status, updated_at, device_id, deleted, scope, project_id, locked, access_count, last_access_at)
       VALUES (?, ?, ?, 'test', ?, 'active', ?, 'local', 0, ?, ?, ?, ?, ?)`
    )
    .run(
      input.id ?? null,
      input.kind ?? 'fact',
      input.content,
      input.confidence ?? 1,
      input.updated ?? Date.now(),
      input.scope ?? 'project',
      input.project === undefined ? projectId : input.project,
      input.locked ?? 0,
      input.access ?? 0,
      input.lastAccess ?? null
    ).lastInsertRowid
  return Number(id)
}

const rowOf = (id: number): Record<string, unknown> =>
  db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Record<string, unknown>

beforeEach(() => {
  db = new Database(':memory:')
  for (const m of CORE_MIGRATIONS) db.exec(m.up)
  for (const m of CURATOR_MIGRATIONS) db.exec(m.up)
  projectId = Number(
    db
      .prepare(`INSERT INTO projects (path, name, updated_at) VALUES (?, 'demo', ?)`)
      .run('C:\\demo', Date.now()).lastInsertRowid
  )
})

afterEach(() => {
  db.close()
})

describe('heatScore', () => {
  it('访问次数与新鲜度都会提升热度', () => {
    const now = 1_800_000_000_000
    const cold = heatScore({ updated_at: now - 10 * 86_400_000, access_count: 0 }, now)
    const fresh = heatScore({ updated_at: now, access_count: 0 }, now)
    const hot = heatScore({ updated_at: now, access_count: 20 }, now)
    expect(fresh).toBeGreaterThan(cold)
    expect(hot).toBeGreaterThan(fresh)
  })
})

describe('parseProjectOps / parseGlobalOps', () => {
  it('解析 fenced JSON,只接受合法 kind/id,并按上限截断 add', () => {
    const allowed = new Set([1, 2])
    const text =
      '好的:\n```json\n' +
      JSON.stringify({
        project: [
          { op: 'add', kind: 'fact', content: '新事实', confidence: 0.8 },
          { op: 'update', id: 1, kind: 'decision', content: '修正后的决策' },
          { op: 'retire', id: 2, reason: '被取代' },
          { op: 'update', id: 999, kind: 'fact', content: '越界 id' },
          { op: 'add', kind: 'bogus', content: '非法 kind' }
        ]
      }) +
      '\n```'
    const ops = parseProjectOps(text, allowed)
    expect(ops).toHaveLength(3)
    expect(ops[0]).toMatchObject({ op: 'add', kind: 'fact' })
    expect(ops[1]).toMatchObject({ op: 'update', id: 1 })
    expect(ops[2]).toMatchObject({ op: 'retire', id: 2 })
    // 只有合法 allowed id 才允许 update/retire
    expect(ops.some((o) => o.id === 999)).toBe(false)
  })

  it('add 超过 8 条时只保留前 8 条;全局最多 4 条', () => {
    const adds = Array.from({ length: 12 }, (_, i) => ({
      op: 'add',
      kind: 'fact',
      content: `事实 ${i}`
    }))
    expect(parseProjectOps(JSON.stringify({ project: adds }), new Set())).toHaveLength(8)
    expect(parseGlobalOps(JSON.stringify({ global: adds }), new Set())).toHaveLength(4)
  })
})

describe('applyCuration', () => {
  it('add/update/retire 生效,并写入 scope/project/source', () => {
    const updateId = addMemory({ content: '旧事实', kind: 'fact' })
    const retireId = addMemory({ content: '过时决策', kind: 'decision' })
    const res = applyCuration(db, {
      scope: 'project',
      projectId,
      ops: [
        { op: 'add', kind: 'preference', content: '偏好 A', confidence: 0.8 },
        { op: 'update', id: updateId, kind: 'fact', content: '新事实', confidence: 0.9 },
        { op: 'retire', id: retireId, reason: '被取代' }
      ],
      cap: 80
    })
    expect(res).toMatchObject({ added: 1, updated: 1, retired: 1 })
    const added = db
      .prepare(`SELECT * FROM memories WHERE content = '偏好 A'`)
      .get() as Record<string, unknown>
    expect(added.scope).toBe('project')
    expect(added.project_id).toBe(projectId)
    expect(added.source).toBe(`llm-curator:project:${projectId}`)
    expect(added.status).toBe('active')
    expect(rowOf(updateId).content).toBe('新事实')
    expect(rowOf(retireId).status).toBe('retired')
  })

  it('用户锁定的条目不会被 update/retire,新增同内容也不会覆盖', () => {
    const lockedId = addMemory({ content: '用户手写', locked: 1 })
    const res = applyCuration(db, {
      scope: 'project',
      projectId,
      ops: [
        { op: 'update', id: lockedId, kind: 'fact', content: 'LLM 想改' },
        { op: 'retire', id: lockedId },
        { op: 'add', kind: 'fact', content: '用户手写' }
      ],
      cap: 80
    })
    expect(res.skipped).toBe(3)
    expect(rowOf(lockedId).content).toBe('用户手写')
    expect(rowOf(lockedId).status).toBe('active')
    expect(db.prepare(`SELECT COUNT(*) n FROM memories WHERE content = '用户手写'`).get()).toEqual({ n: 1 })
  })

  it('超过上限时优先保留 locking/画像,淘汰低热度条目', () => {
    addMemory({ content: 'locking', locked: 1, kind: 'fact', updated: Date.now() - 30 * 86_400_000 })
    const oldId = addMemory({ content: '旧低热度', kind: 'fact', updated: Date.now() - 60 * 86_400_000 })
    const hotId = addMemory({
      content: '高热度',
      kind: 'fact',
      updated: Date.now() - 60 * 86_400_000,
      access: 50,
      lastAccess: Date.now()
    })
    const res = applyCuration(db, {
      scope: 'project',
      projectId,
      ops: [],
      cap: 2
    })
    expect(res.retired).toBeGreaterThanOrEqual(1)
    expect(rowOf(oldId).status).toBe('retired')
    expect(rowOf(hotId).status).toBe('active')
  })
})

describe('prompt builders', () => {
  const digest = {
    id: 7,
    summary: '项目总览',
    recent: '最近改了 a.ts',
    todos: [{ content: '补测试', status: 'open' }],
    decisions: ['用 SQLite'],
    createdAt: Date.now()
  }
  const mem = (over: Partial<CuratorMemoryRow> & { id: number }): CuratorMemoryRow => {
    const { id, ...rest } = over
    return {
      id,
      kind: 'fact',
      content: `记忆 ${id}`,
      locked: 0,
      confidence: 1,
      updated_at: Date.now(),
      access_count: 0,
      last_access_at: null,
      ...rest
    }
  }

  it('项目 prompt 带 digest recent/决策/待办/已有 id/locked 标记', () => {
    const prompt = buildProjectCurationPrompt({
      project: { id: 1, name: 'demo', path: 'C:\\demo', techStack: 'TS' },
      digest,
      projectMemories: [mem({ id: 3, locked: 1 })],
      globalMemories: [mem({ id: 9 })]
    })
    expect(prompt).toContain('最近改了 a.ts')
    expect(prompt).toContain('补测试')
    expect(prompt).toContain('用 SQLite')
    expect(prompt).toContain('"id":3')
    expect(prompt).toContain('"locked":true')
    expect(projectSystemPrompt()).toContain('全局记忆不要在这里输出')
  })

  it('全局 prompt 列出项目记忆并要求跨项目提炼', () => {
    const prompt = buildGlobalCurationPrompt({
      projectMemories: [{ ...mem({ id: 1 }), projectName: 'demo' }],
      globalMemories: [mem({ id: 2 })]
    })
    expect(prompt).toContain('demo')
    expect(prompt).toContain('跨项目')
    expect(prompt).toContain('"id":2')
  })
})
