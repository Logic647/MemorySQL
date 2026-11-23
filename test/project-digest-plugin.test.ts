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
let refinePrompts: string[] = []

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
          refine: async (prompt: string) => {
            refineCalls++
            refinePrompts.push(String(prompt))
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
  refinePrompts = []
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
    // 固定时间戳,避免测试跑到秒边界时 nowSec() 变化导致差 1 秒
    const oldTs = nowSec() - 3600
    const liveTs = nowSec() - 30
    addSession(1, 1, oldTs) // 旧会话:可总结
    addSession(2, 1, liveTs) // 正在聊:不应进总结
    initPlugin()

    await runNow(1)

    const digests = db
      .prepare(`SELECT sessions_covered, period_end FROM project_digests WHERE project_id = 1`)
      .all() as Array<{ sessions_covered: number; period_end: number }>
    expect(digests).toHaveLength(1)
    expect(digests[0].sessions_covered).toBe(1)
    expect(digests[0].period_end).toBe(oldTs)
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

  /**
   * harness 注入的系统文本在库里也是 user 角色(2026-11-22 真库实测):总结素材
   * 的「首条用户消息」曾取到 `# Environment…`,LLM 从来看不到用户真正要什么。
   * 断言的是发给 LLM 的 prompt(捕获后抛错走规则回落,digest 仍落库)。
   */
  it('总结素材的首条用户消息跳过 harness 注入,取真实输入', async () => {
    addProject(1, 'demo')
    const oldTs = nowSec() - 3600
    addSession(1, 1, oldTs)
    const ins = db.prepare(
      `INSERT INTO session_messages (session_id, seq, role, content, ts) VALUES (1, ?, ?, ?, ?)`
    )
    ins.run(0, 'user', '# Environment\nYou have been invoked in the following environment:', oldTs - 600)
    ins.run(1, 'assistant', '好的,开始处理。', oldTs - 500)
    ins.run(2, 'user', '帮我把语义检索默认关掉', oldTs - 400)
    refineMode = 'throw'
    initPlugin()

    await runNow(1)

    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM project_digests`).get() as { n: number }).n
    ).toBe(1)
    expect(refineCalls).toBe(1)
    expect(refinePrompts[0]).toContain('帮我把语义检索默认关掉')
    expect(refinePrompts[0]).not.toContain('# Environment')
  })
})

/**
 * 安静期起算点(2026-11-23 实测事故):定时器过去按「入库事件时刻 + quietMinutes」
 * 排,而批量入库可能比消息晚 20+ 分钟;结果 digest 在用户重新开口的前一分钟跑完,
 * 观感是「刚开始说话/刚入库就总结」。现在按「项目最后一条消息 + quietMinutes」
 * 定点,到点还要复核一次,期间又开口就顺延。
 */
describe('安静期起算点', () => {
  const digestCount = (): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM project_digests`).get() as { n: number }).n

  it('已安静满期的会话:迟到的入库事件不应再等 quietMinutes,几秒内就总结', async () => {
    addProject(1, 'demo')
    addSession(1, 1, nowSec() - 7200) // 2 小时前就安静了
    vi.useFakeTimers()
    try {
      initPlugin()
      events.emit('ingest:result', [1]) // 批量入库现在才把它送进来
      await vi.advanceTimersByTimeAsync(6_000)
      expect(digestCount()).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('项目仍活跃:quietMinutes 内不总结;等待期间又开口则顺延', async () => {
    addProject(1, 'demo')
    addSession(1, 1, nowSec() - 7200) // 老会话,本来可总结
    vi.useFakeTimers()
    try {
      initPlugin()
      addSession(2, 1, nowSec()) // 用户刚开口
      events.emit('ingest:result', [2])
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(digestCount()).toBe(0) // 离安静满期还早
      // 到点前又开口一次 → 闹钟顺延
      await vi.advanceTimersByTimeAsync(60 * 60_000)
      addSession(3, 1, nowSec())
      events.emit('ingest:result', [3])
      await vi.advanceTimersByTimeAsync(30 * 60_000)
      expect(digestCount()).toBe(0) // 原本第二次该在 130min,顺延后还不到
      // 安静满期后照常跑
      await vi.advanceTimersByTimeAsync(150 * 60_000)
      expect(digestCount()).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('子代理会话入库不排项目总结(也不重置闹钟)', async () => {
    addProject(1, 'demo')
    db.prepare(
      `INSERT INTO sessions
         (id, agent_type, external_id, project_id, cwd, started_at, ended_at, last_message_at,
          title, summary, content_hash, message_count, tool_call_count, updated_at, is_subagent)
       VALUES (9, 'zcode', 'sub-9', 1, 'C:\\demo', ?, ?, ?, '子代理', '', 'h9', 2, 0, ?, 1)`
    ).run(nowSec() - 60, nowSec() - 60, nowSec() - 60, Date.now())
    vi.useFakeTimers()
    try {
      initPlugin()
      events.emit('ingest:result', [9])
      await vi.advanceTimersByTimeAsync(6_000)
      expect(digestCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
