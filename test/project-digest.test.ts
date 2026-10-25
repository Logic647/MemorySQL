import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CORE_MIGRATIONS } from '../src/plugins/core-schema/migrations'
import { DIGEST_MIGRATIONS } from '../src/plugins/project-digest/migrations'
import plugin from '../src/plugins/project-digest/index'
import {
  buildDigestMd,
  buildDigestPrompt,
  buildRulesDigest,
  DIGEST_SOFT_CHAR_CAP,
  parseDigestResponse,
  shouldRunCatchup,
  type DigestSessionInput,
  type DigestTodo
} from '../src/plugins/project-digest/digest'
import { Db } from '../src/main/core/db'
import { EventBus } from '../src/main/core/event-bus'
import type { PluginContext } from '../src/main/core/plugin-host'

// ---------------------------------------------------------------------------
// 纯逻辑:prompt / 解析 / 规则降级 / 补跑判定 / 渲染
// ---------------------------------------------------------------------------

const sess = (over: Partial<DigestSessionInput> & { id: number }): DigestSessionInput => ({
  agentType: 'codex',
  title: `会话 ${over.id}`,
  summary: '目标: x\n结果: y',
  messageCount: 12,
  toolCallCount: 3,
  ts: 1_760_000_000 + over.id * 3600,
  firstUser: '帮我修登录报错',
  lastAssistant: '已修复,原因是 token 过期未刷新',
  ...over
})

describe('buildDigestPrompt', () => {
  it('包含上一版总结/待办与会话字段', () => {
    const prev = {
      summary: '上一版:完成了 A',
      todos: [
        { content: '做 B', status: 'open' },
        { content: 'A', status: 'done' }
      ] as DigestTodo[]
    }
    const p = buildDigestPrompt('demo', [sess({ id: 1 }), sess({ id: 2 })], prev)
    expect(p).toContain('项目: demo')
    expect(p).toContain('上一版:完成了 A')
    expect(p).toContain('[ ] 做 B')
    expect(p).toContain('[x] A')
    expect(p).toContain('#1 · codex')
    expect(p).toContain('帮我修登录报错')
    expect(p).toContain('已修复,原因是 token 过期未刷新')
  })

  it('首次总结没有上一版段落', () => {
    const p = buildDigestPrompt('demo', [sess({ id: 1 })], null)
    expect(p).toContain('首次总结')
    expect(p).not.toContain('上一版总结')
  })

  it('超软上限时逐级丢弃会话正文(先丢助手回复)', () => {
    const big = Array.from({ length: 12 }, (_, i) =>
      sess({ id: i + 1, lastAssistant: 'A'.repeat(3000), firstUser: 'U'.repeat(2000), summary: 'S'.repeat(2000) })
    )
    const p = buildDigestPrompt('demo', big, null)
    expect(p.length).toBeLessThanOrEqual(DIGEST_SOFT_CHAR_CAP)
    // 降级掩码下连正文都该被丢掉,但标题永远保留
    expect(p).toContain('标题: 会话 12')
    expect(p).not.toContain('A'.repeat(500))
  })
})

describe('parseDigestResponse(括号配平容错)', () => {
  it('严格 JSON 直接过', () => {
    const r = parseDigestResponse('{"summary":"ok","todos":[{"content":"t","status":"open"}],"decisions":["d"],"candidates":[]}')
    expect(r?.summary).toBe('ok')
    expect(r?.todos[0].status).toBe('open')
  })

  it('markdown 围栏 + 前后解释文字都能抠出 JSON', () => {
    const text = '好的,以下是总结:\n```json\n{"summary":"s1","todos":[],"decisions":[],"candidates":[]}\n```\n希望有帮助'
    expect(parseDigestResponse(text)?.summary).toBe('s1')
  })

  it('字符串里含花括号不破坏配平', () => {
    const text = '噪声 {"summary":"含 { 花括号 } 的文本","todos":[],"decisions":[],"candidates":[]}'
    expect(parseDigestResponse(text)?.summary).toBe('含 { 花括号 } 的文本')
  })

  it('两段 JSON 取第一段可解析的', () => {
    const text = '{"summary":"first","todos":[],"decisions":[],"candidates":[]} {"summary":"second"}'
    expect(parseDigestResponse(text)?.summary).toBe('first')
  })

  it('todo 状态归一 + 候选 kind 回落 fact', () => {
    const r = parseDigestResponse(
      '{"summary":"s","todos":[{"content":"a","status":"done"},{"content":"b","status":"weird"}],"decisions":[],"candidates":[{"kind":"mood","content":"c"}]}'
    )
    expect(r?.todos.map((t) => t.status)).toEqual(['done', 'open'])
    expect(r?.candidates[0].kind).toBe('fact')
  })

  it('无 summary 或纯文本返回 null', () => {
    expect(parseDigestResponse('{"todos":[]}')).toBeNull()
    expect(parseDigestResponse('完全不是 JSON')).toBeNull()
    expect(parseDigestResponse('')).toBeNull()
  })
})

describe('buildRulesDigest(零外发降级)', () => {
  it('会话清单 + 上版待办结转 + pendingProgress 进待办', () => {
    const prev = {
      summary: '旧总结',
      todos: [
        { content: '旧待办', status: 'open' },
        { content: '已完成', status: 'done' }
      ] as DigestTodo[]
    }
    const r = buildRulesDigest('demo', [sess({ id: 1 }), sess({ id: 2 })], prev, ['agent 收工汇报: 剩收尾'])
    expect(r.summary).toContain('2 个会话')
    expect(r.summary).toContain('会话 1')
    expect(r.summary).toContain('旧总结')
    expect(r.todos.map((t) => t.content)).toEqual(['旧待办', 'agent 收工汇报: 剩收尾'])
    expect(r.candidates).toEqual([])
  })
})

describe('shouldRunCatchup', () => {
  it('无未覆盖不跑;首次有未覆盖即跑;24h 内不重复跑', () => {
    const now = 1_760_000_000_000
    expect(shouldRunCatchup({ last_digest_at: now }, 0, now)).toBe(false)
    expect(shouldRunCatchup(undefined, 3, now)).toBe(true)
    expect(shouldRunCatchup({ last_digest_at: now - 3600_000 }, 3, now)).toBe(false)
    expect(shouldRunCatchup({ last_digest_at: now - 25 * 3600_000 }, 3, now)).toBe(true)
  })
})

describe('buildDigestMd', () => {
  it('渲染摘要/待办勾选/决策与元信息', () => {
    const md = buildDigestMd(
      { summary: 'S1', todos: [{ content: 't1', status: 'open' }, { content: 't2', status: 'done' }], decisions: ['D1'], candidates: [] },
      { projectName: 'demo', periodStart: 1_760_000_000, periodEnd: 1_760_086_400, model: 'llm:glm-4.7-flash', sessionsCovered: 5, generatedAt: new Date(1_760_086_400_000) }
    )
    expect(md).toContain('# 项目总结: demo')
    expect(md).toContain('- [ ] t1')
    expect(md).toContain('- [x] t2')
    expect(md).toContain('- D1')
    expect(md).toContain('llm:glm-4.7-flash')
  })
})

// ---------------------------------------------------------------------------
// 插件接线:真实 SQLite(内存,走生产迁移器)+ 最小 PluginContext 替身
// ---------------------------------------------------------------------------

type Handlers = Map<string, (payload: unknown) => unknown>

let wrapper: Db
let tmp: string
let handlers: Handlers
let mcpTools: Array<{ name: string; handler: (args: Record<string, unknown>) => unknown }>
let settingsMap: Record<string, unknown>

interface RefineStub {
  available(): boolean
  refine(prompt: string, opts?: { system?: string; maxTokens?: number }): Promise<string>
  describe?(): string
}

function makeCtx(opts: { enabled?: boolean; refine?: () => RefineStub } = {}): void {
  settingsMap = { 'project-digest:enabled': opts.enabled ?? false }
  const events = new EventBus()
  handlers = new Map()
  mcpTools = []
  const ctx = {
    id: 'project-digest',
    log: { info: () => {}, warn: () => {}, error: () => {} },
    env: { vaultDir: path.join(tmp, 'vault') },
    db: { migrate: () => {}, sqlite: wrapper.sqlite },
    settings: {
      // 真实 PluginContext.settings 会自动加 `<pluginId>:` 前缀(plugin-host.ts),
      // 替身必须复刻这一点,否则读的键和写的键对不上
      get: (k: string, d: unknown) => {
        const full = `project-digest:${k}`
        return full in settingsMap ? settingsMap[full] : d
      },
      set: (k: string, v: unknown) => {
        settingsMap[`project-digest:${k}`] = v
      }
    },
    events,
    ipc: {
      handle: (name: string, h: (payload: unknown) => unknown) => handlers.set(`project-digest:${name}`, h),
      call: async () => {}
    },
    mcp: {
      registerTool: (def: { name: string; handler: (args: Record<string, unknown>) => unknown }) => mcpTools.push(def),
      list: () => mcpTools
    },
    watcher: { watch: () => () => {} },
    summarizer: { registerProvider: () => {}, pickActive: () => null },
    services: {
      provide: () => {},
      use: () => {
        if (opts.refine) return opts.refine()
        throw new Error('Service not available')
      }
    }
  } as unknown as PluginContext
  plugin.init(ctx)
}

/** 给已有项目补 N 个带消息的会话(ts 秒递增) */
function addSessions(pid: number, name: string, n: number, startTs: number): void {
  const insSession = wrapper.sqlite.prepare(
    `INSERT INTO sessions (agent_type, external_id, project_id, title, summary, started_at, last_message_at, message_count, tool_call_count, content_hash, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const insMsg = wrapper.sqlite.prepare(
    'INSERT INTO session_messages (session_id, seq, role, content, ts) VALUES (?, ?, ?, ?, ?)'
  )
  for (let i = 0; i < n; i++) {
    const ts = startTs + i * 600
    const sInfo = insSession.run('codex', `${name}-s${i}-${ts}`, pid, `${name} 会话${i}`, `目标: x${i}`, ts, ts + 300, 4, 1, `h-${name}-${i}-${ts}`, Date.now())
    const sid = Number(sInfo.lastInsertRowid)
    insMsg.run(sid, 0, 'user', `用户问题 ${i}`, ts)
    insMsg.run(sid, 1, 'assistant', `助手回答 ${i}`, ts + 300)
  }
}

/** 造一个新项目 + N 个带消息的会话;返回 projectId */
function seedProject(name: string, n: number, startTs = 1_760_000_000): number {
  const info = wrapper.sqlite
    .prepare('INSERT INTO projects (name, updated_at, device_id) VALUES (?, ?, ?)')
    .run(name, Date.now(), 'local')
  const pid = Number(info.lastInsertRowid)
  addSessions(pid, name, n, startTs)
  return pid
}

beforeEach(() => {
  wrapper = new Db(':memory:')
  wrapper.migrate('core-schema', CORE_MIGRATIONS)
  wrapper.migrate('project-digest', DIGEST_MIGRATIONS)
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-'))
})

afterEach(() => {
  wrapper.close()
  fs.rmSync(tmp, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const runAll = async (): Promise<Record<string, { ok: boolean; message: string }>> =>
  (await (handlers.get('project-digest:runAll')!({}) as Promise<Record<string, { ok: boolean; message: string }>>))

describe('插件接线', () => {
  it('总开关默认关闭:status 报 enabled=false,MCP 工具给出开启指引', () => {
    makeCtx()
    const status = handlers.get('project-digest:status')!({}) as { enabled: boolean }
    expect(status.enabled).toBe(false)
    const tool = mcpTools.find((t) => t.name === 'memory_get_project_digest')!
    const out = tool.handler({}) as string
    expect(out).toContain('未开启')
  })

  it('runAll(显式 CLI 意图)在开关关闭时仍产出规则总结 + vault md + 覆盖水位', async () => {
    makeCtx()
    const pid = seedProject('demo', 3)
    const r = (await runAll())[String(pid)]
    expect(r.ok).toBe(true)
    expect(r.message).toContain('rules')
    const row = wrapper.sqlite.prepare('SELECT * FROM project_digests WHERE project_id = ?').get(pid) as { model: string; sessions_covered: number; period_end: number }
    expect(row.model).toBe('rules')
    expect(row.sessions_covered).toBe(3)
    const state = wrapper.sqlite.prepare('SELECT * FROM project_digest_state WHERE project_id = ?').get(pid) as { status: string; last_digest_at: number; last_covered_ts: number }
    expect(state.status).toBe('idle')
    expect(state.last_covered_ts).toBe(row.period_end)
    expect(state.last_digest_at).toBeGreaterThan(0)
    expect(fs.existsSync(path.join(tmp, 'vault', 'digest', 'demo.md'))).toBe(true)
  })

  it('没有新会话时 runAll 跳过且不写新 digest', async () => {
    makeCtx()
    const pid = seedProject('demo', 1)
    await runAll()
    const first = wrapper.sqlite.prepare('SELECT COUNT(*) AS n FROM project_digests').get() as { n: number }
    const second = (await runAll())[String(pid)]
    expect(second.message).toContain('没有新会话')
    const after = wrapper.sqlite.prepare('SELECT COUNT(*) AS n FROM project_digests').get() as { n: number }
    expect(after.n).toBe(first.n)
  })

  it('LLM 路径:产物标 llm:<model>,候选记忆去重入库', async () => {
    let calls = 0
    makeCtx({
      enabled: true,
      refine: () => ({
        available: () => true,
        describe: () => 'glm-4.7-flash',
        refine: async () => {
          calls++
          return JSON.stringify({
            summary: calls === 1 ? '第一版总结' : '第二版总结',
            todos: [{ content: '唯一待办', status: 'open' }],
            decisions: ['用 SQLite'],
            candidates: [{ kind: 'preference', content: '用户偏好中文回复' }, { kind: 'mood', content: '用户偏好中文回复' }]
          })
        }
      })
    })
    const pid = seedProject('demo', 2)
    let r = (await runAll())[String(pid)]
    expect(r.message).toContain('llm:glm-4.7-flash')
    // 两条候选(kind 不同、内容相同)按「同源同内容」去重为一条,kind 取合法值
    const mems = wrapper.sqlite.prepare('SELECT kind, content, status FROM memories WHERE source = ?').all(`project-digest:${pid}`) as Array<{ kind: string; status: string }>
    expect(mems).toHaveLength(1)
    expect(mems[0].kind).toBe('preference')
    expect(mems[0].status).toBe('candidate')
    // 另一个项目总结 → 候选不重复入库
    const pid2 = seedProject('demo2', 1)
    r = (await runAll())[String(pid2)]
    expect(r.ok).toBe(true)
    const again = wrapper.sqlite.prepare('SELECT COUNT(*) AS n FROM memories WHERE source = ?').get(`project-digest:${pid}`) as { n: number }
    expect(again.n).toBe(1)
  })

  it('LLM 输出不可解析时回落规则并把原因记进 state.last_error', async () => {
    makeCtx({
      enabled: true,
      refine: () => ({ available: () => true, refine: async () => '这不是 JSON' })
    })
    const pid = seedProject('demo', 1)
    const r = (await runAll())[String(pid)]
    expect(r.message).toContain('rules')
    const state = wrapper.sqlite.prepare('SELECT last_error FROM project_digest_state WHERE project_id = ?').get(pid) as { last_error: string }
    expect(state.last_error).toContain('无法解析')
  })

  it('latest 返回最新 digest 内容;status 汇总未覆盖数', async () => {
    makeCtx()
    const pid = seedProject('demo', 2)
    await runAll()
    addSessions(pid, 'demo', 1, 1_770_000_000) // 同一项目补新会话 → uncovered > 0
    const latest = handlers.get('project-digest:latest')!({ projectId: pid }) as { summary: string; todos: DigestTodo[]; projectName: string } | null
    expect(latest?.summary).toBeTruthy()
    expect(latest?.projectName).toBe('demo')
    const status = handlers.get('project-digest:status')!({}) as { enabled: boolean; projects: Array<{ projectId: number; uncovered: number; hasDigest: number }> }
    const mine = status.projects.find((p) => p.projectId === pid)
    expect(mine?.uncovered).toBe(1)
    expect(mine?.hasDigest).toBe(1)
  })

  it('MCP 工具在开启后返回总结文本;未命中项目给出提示', async () => {
    makeCtx({ enabled: true })
    seedProject('demo', 1)
    await runAll()
    const tool = mcpTools.find((t) => t.name === 'memory_get_project_digest')!
    const out = tool.handler({ project: 'demo' }) as string
    expect(out).toContain('项目滚动总结: demo')
    expect(out).toContain('demo 会话0')
    const miss = tool.handler({ project: '不存在的项目' }) as string
    expect(miss).toContain('未找到')
  })
})
