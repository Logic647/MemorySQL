import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CORE_MIGRATIONS } from '../src/plugins/core-schema/migrations'
import { DIGEST_MIGRATIONS } from '../src/plugins/project-digest/migrations'
import digestPlugin from '../src/plugins/project-digest/index'
import { EventBus } from '../src/main/core/event-bus'
import type { PluginContext } from '../src/main/core/plugin-host'

/**
 * 项目总结的「不追活会话」回归:
 * 真实事故 —— 启动补跑在用户刚开始对话时触发,消化循环每轮都重读同一场
 * 仍在写入的会话,每轮等满 LLM 超时再回落规则,8 轮 × 45s 全在用户聊天时跑。
 * 现在:①每个会话的 last_message_at 必须早于 cutoff(自动=quietMinutes,
 * 手动=2 分钟);②同一触发内已消化的会话不再回读;③LLM 失败一次即停止
 * 在本轮触发里重试。
 */
let db: Database.Database
let events: EventBus
let handlers: Map<string, (payload: unknown) => unknown>
let settings: Map<string, unknown>
let vaultDir: string
let refineCalls = 0
let refineMode: 'absent' | 'throw' = 'absent'

const nowSec = (): number => Math.floor(Date.now() / 1000)

function initPlugin(): void {
  const ctx = {
    id: 'project-digest',
    log: { info: () => {}, warn: () => {}, error: () => {} },
    db: { migrate: () => {}, sqlite: db },
    settings: {
      get: (k: string, d: unknown) => (settings.has(k) ? settings.get(k) : d),
      set: (k: string, v: unknown) => settings.set(k, v)
    },
    events,
    ipc: {
      handle: (name: string, h: (payload: unknown) => unknown) => handlers.set(name, h),
      call: async () => {
        throw new Error('unexpected ipc.call')
      }
    },
    mcp: { registerTool: () => {}, list: () => [] },
    watcher: { watch: () => () => {} },
    summarizer: { registerProvider: () => {}, pickActive: () => null },
    services: {
      provide: () => {},
      use: (name: string) => {
        if (name !== 'llm-refine') throw new Error(`Service not available: ${name}`)
        if (refineMode === 'absent') throw new Error('Service not available: llm-refine')
        return {
          available: () => true,
          describe: () => 'mock',
          refine: async () => {
            refineCalls++
            throw new Error('This operation was aborted')
          }
        }
      }
    },
    env: { vaultDir }
  } as unknown as PluginContext
  digestPlugin.init(ctx)
}

function addProject(id: number, name: string): void {
  db.prepare(`INSERT INTO projects (id, path, name, updated_at) VALUES (?, ?, ?, ?)`).run(
    id,
    `C:\\demo\\${name}`,
    name,
    Date.now()
  )
}

function addSession(id: number, projectId: number, lastAtSec: number): void {
  db.prepare(
    `INSERT INTO sessions
       (id, agent_type, external_id, project_id, cwd, started_at, ended_at, last_message_at,
        title, summary, content_hash, message_count, tool_call_count, updated_at)
     VALUES (?, 'zcode', ?, ?, 'C:\\demo', ?, ?, ?, ?, ?, ?, 2, 0, ?)`
  ).run(
    id,
    `ext-${id}`,
    projectId,
    lastAtSec - 600,
    lastAtSec,
    lastAtSec,
    `会话 ${id}`,
    `摘要 ${id}`,
    `hash-${id}`,
    Date.now()
  )
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  db = new Database(':memory:')
  for (const m of CORE_MIGRATIONS) db.exec(m.up)
  for (const m of DIGEST_MIGRATIONS) db.exec(m.up)
  events = new EventBus()
  handlers = new Map()
  settings = new Map<string, unknown>([
    ['enabled', true],
    ['quietMinutes', 120]
  ])
  refineCalls = 0
  refineMode = 'absent'
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memorysql-digest-test-'))
})

afterEach(() => {
  db.close()
  fs.rmSync(vaultDir, { recursive: true, force: true })
})

const runNow = async (projectId: number): Promise<void> => {
  await handlers.get('runNow')!({ projectId })
  await wait(400)
}

describe('project-digest 触发逻辑', () => {
  it('手动立即总结只消化已安静的会话,不总结正在写入的那一场', async () => {
    addProject(1, 'demo')
    addSession(1, 1, nowSec() - 3600) // 旧会话:可总结
    addSession(2, 1, nowSec() - 30) // 正在聊:不应进总结
    initPlugin()

    await runNow(1)

    const digests = db
      .prepare(`SELECT sessions_covered, period_end FROM project_digests WHERE project_id = 1`)
      .all() as Array<{ sessions_covered: number; period_end: number }>
    expect(digests).toHaveLength(1)
    expect(digests[0].sessions_covered).toBe(1)
    expect(digests[0].period_end).toBe(nowSec() - 3600)
  })

  it('只有活会话时立即总结不会生成 digest', async () => {
    addProject(1, 'demo')
    addSession(2, 1, nowSec() - 30)
    initPlugin()

    await runNow(1)

    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM project_digests`).get() as { n: number }).n
    ).toBe(0)
  })

  it('多轮消化中 LLM 失败一次后不再逐轮重试(规则回落)', async () => {
    addProject(1, 'demo')
    // 25 个安静会话 → 20 + 5 两批;旧实现第二批还会再等一次 LLM 超时
    for (let i = 1; i <= 25; i++) addSession(i, 1, nowSec() - 7200 - i * 60)
    refineMode = 'throw'
    initPlugin()

    await runNow(1)

    const rows = db
      .prepare(`SELECT sessions_covered, model FROM project_digests WHERE project_id = 1 ORDER BY id`)
      .all() as Array<{ sessions_covered: number; model: string }>
    expect(refineCalls).toBe(1)
    expect(rows.map((r) => r.sessions_covered)).toEqual([20, 5])
    expect(rows.every((r) => r.model === 'rules')).toBe(true)
  })

  it('启动补跑跳过还在写入的项目', async () => {
    addProject(1, 'demo')
    addSession(2, 1, nowSec() - 30)
    vi.useFakeTimers()
    try {
      initPlugin()
      // 启动 3 分钟后的补跑定时器
      await vi.advanceTimersByTimeAsync(3 * 60_000 + 200)
      expect(
        (db.prepare(`SELECT COUNT(*) AS n FROM project_digests`).get() as { n: number }).n
      ).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
