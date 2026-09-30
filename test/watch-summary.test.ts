import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildBrief, summarize } from '../tools/upstream-watch/summarize.mjs'
import type { EvalLike } from '../tools/upstream-watch/summarize.mjs'

/**
 * 总体情况摘要。
 *
 * 最重要的一组断言在最后:**LLM 说什么都不能改变 brief 里的数字。**
 * 这是整个设计的目的 —— 一个会编数字的看板比没有看板更危险,因为人会照着它行动。
 */
const R = (over: Partial<EvalLike> = {}): EvalLike => ({
  agentId: 'x',
  risk: 'low',
  version: 'v1',
  notes: 'feat',
  llm: null,
  fetchError: null,
  ...over
})

beforeEach(() => { delete process.env.LLM_API_KEY })
afterEach(() => { vi.restoreAllMocks() })

describe('buildBrief — 纯函数,不联网', () => {
  it('白盒四档计数正确,且总数守恒', () => {
    const b = buildBrief([
      R({ agentId: 'a', risk: 'high' }),
      R({ agentId: 'b', risk: 'medium' }),
      R({ agentId: 'c', risk: 'medium' }),
      R({ agentId: 'd', risk: 'low' }),
      R({ agentId: 'e', risk: 'none' }),
      R({ agentId: 'f', risk: 'unknown' })
    ])
    expect(b.total).toBe(6)
    expect(b.whitebox).toEqual({ high: 1, medium: 2, lowOrNone: 2, unknown: 1 })
    const sum = b.whitebox.high + b.whitebox.medium + b.whitebox.lowOrNone + b.whitebox.unknown
    expect(sum).toBe(b.total)
  })

  it('LLM 状态四分:hit / clear / error / notInvoked', () => {
    const b = buildBrief([
      R({ agentId: 'a', risk: 'medium', llm: { affectsCapture: true } }),
      R({ agentId: 'b', risk: 'medium', llm: { affectsMcp: true } }),
      R({ agentId: 'c', risk: 'medium', llm: { affectsCapture: false, affectsMcp: false } }),
      R({ agentId: 'd', risk: 'medium', llmError: 'LLM HTTP 500' }),
      R({ agentId: 'e', risk: 'low' })
    ])
    expect(b.llm).toEqual({ hit: 2, clear: 1, error: 1, notInvoked: 1 })
  })

  it('需处理 = 白盒高/中 ∪ 黑盒漂移 ∪ LLM 判有影响(取并集,不是取最大)', () => {
    const b = buildBrief(
      [
        R({ agentId: 'a', risk: 'high' }),
        R({ agentId: 'b', risk: 'low', llm: { affectsMcp: true } }),
        R({ agentId: 'c', risk: 'low' })
      ],
      { checkedAt: '2026-09-30T00:00:00Z', results: [{ id: 'c', verdict: 'drift', detail: '表对不上' }] }
    )
    expect(b.attention.map((a) => a.id).sort()).toEqual(['a', 'b', 'c'])
    // 三个信号的理由都要在
    expect(b.attention.find((x) => x.id === 'c')!.reasons).toContain('黑盒确认漂移')
    expect(b.attention.find((x) => x.id === 'b')!.reasons).toContain('LLM 判 MCP 受影响')
  })

  it('attention 按风险降序,同级按 id 稳定排序(否则每次刷新顺序乱跳)', () => {
    const mk = (id: string, risk: EvalLike['risk']) => R({ agentId: id, risk })
    const b1 = buildBrief([mk('z', 'medium'), mk('a', 'high'), mk('m', 'high')])
    expect(b1.attention.map((a) => a.id)).toEqual(['a', 'm', 'z'])
    const b2 = buildBrief([mk('m', 'high'), mk('a', 'high'), mk('z', 'medium')])
    expect(b2.attention.map((a) => a.id)).toEqual(['a', 'm', 'z'])
  })

  it('闭源/无法白盒评估的必须单独列出 —— 混进总数会造成"还有 8 家在监控"的错觉', () => {
    const b = buildBrief(
      [
        R({ agentId: 'opencode', risk: 'low' }),
        R({ agentId: 'zcode', risk: 'unknown', blackboxOnly: true }),
        R({ agentId: 'qoder', risk: 'unknown', blackboxOnly: true })
      ],
      { checkedAt: 'x', results: [{ id: 'zcode', verdict: 'blackbox_only' }, { id: 'qoder', verdict: 'drift' }] }
    )
    expect(b.closedSource.map((c) => c.id).sort()).toEqual(['qoder', 'zcode'])
    expect(b.closedSource.find((c) => c.id === 'qoder')!.blackbox).toBe('drift')
  })

  it('探针未上报时 reported=false,且闭源项标 unreported', () => {
    const b = buildBrief([R({ agentId: 'zcode', risk: 'unknown', blackboxOnly: true })], null)
    expect(b.blackbox.reported).toBe(false)
    expect(b.closedSource[0].blackbox).toBe('unreported')
  })

  it('checker_error 与 drift 分开计数 —— 前者是工具坏了,不是上游变了', () => {
    const b = buildBrief(
      [R({ agentId: 'a' })],
      { checkedAt: 'x', results: [{ id: 'a', verdict: 'checker_error' }, { id: 'z', verdict: 'drift' }] }
    )
    expect(b.blackbox.drift).toBe(1)
    expect(b.blackbox.checkerError).toBe(1)
  })

  it('抓取失败单独收集,不混进"无风险"', () => {
    const b = buildBrief([R({ agentId: 'a', risk: 'medium', fetchError: '限流 (HTTP 403)' })])
    expect(b.fetchErrors).toEqual([{ id: 'a', error: '限流 (HTTP 403)' }])
  })

  it('闭源的"无公开更新日志"不算抓取失败 —— 它是预期状态,标红是误报', () => {
    // 实测踩过:页面上出现红色「抓取失败 4 家」,而那 4 家是闭源 agent,
    // 它们的 fetchError 恒为「闭源,无公开更新日志」,不是故障。
    // 而且它紧挨着「黑盒尚未上报」,两者自相矛盾。
    const b = buildBrief([
      R({ agentId: 'qoder', risk: 'unknown', blackboxOnly: true, fetchError: '闭源,无公开更新日志' }),
      R({ agentId: 'zcode', risk: 'unknown', blackboxOnly: true, fetchError: '闭源,无公开更新日志' }),
      R({ agentId: 'opencode', risk: 'low' })
    ])
    expect(b.fetchErrors).toEqual([])
    // 它们仍应在闭源名单里,不能被顺手抹掉
    expect(b.closedSource.map((c) => c.id).sort()).toEqual(['qoder', 'zcode'])
  })

  it('已评估的 agent 抓取失败仍要报(不能把真故障一起过滤掉)', () => {
    const b = buildBrief([
      R({ agentId: 'claudecode', risk: 'medium', fetchError: 'GitHub 主限流,配额 42 分钟后重置' })
    ])
    expect(b.fetchErrors.map((f) => f.id)).toEqual(['claudecode'])
  })

  it('空输入不炸', () => {
    const b = buildBrief([], null)
    expect(b.total).toBe(0)
    expect(b.attention).toEqual([])
  })
})

describe('summarize — LLM 降级路径', () => {
  it('未配 LLM_API_KEY:brief 照常产出,只是没有解读', async () => {
    const s = await summarize([R({ agentId: 'a', risk: 'high' })])
    expect(s.brief.whitebox.high).toBe(1)
    expect(s.headline).toBeNull()
    expect(s.llmInvoked).toBe(false)
    // 错误文案要说清是"未配置",否则和"生成失败"分不开
    expect(s.error).toContain('未配置')
  })

  it('LLM 报错:brief 仍在,error 带上原因 —— 绝不因摘要功能让整轮刷新失败', async () => {
    process.env.LLM_API_KEY = 'sk-test'
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 500, json: async () => ({}), text: async () => ''
    })))
    const s = await summarize([R({ agentId: 'a', risk: 'high' })])
    expect(s.brief.whitebox.high).toBe(1)
    expect(s.headline).toBeNull()
    expect(s.llmInvoked).toBe(true)
    expect(s.error).toContain('500')
  })

  it('LLM 返回非 JSON:降级而不是抛', async () => {
    process.env.LLM_API_KEY = 'sk-test'
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: '这不是 JSON' } }] })
    })))
    const s = await summarize([R({ agentId: 'a', risk: 'high' })])
    expect(s.headline).toBeNull()
    expect(s.error).toContain('JSON')
  })

  it('无抓取结果时直接返回,不浪费一次 LLM 调用', async () => {
    process.env.LLM_API_KEY = 'sk-test'
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    const s = await summarize([])
    expect(spy).not.toHaveBeenCalled()
    expect(s.error).toBeTruthy()
  })
})

describe('summarize — 正常路径', () => {
  const okFetch = (payload: unknown) => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] })
    })))
  }

  it('解析 headline / actions / blindspot', async () => {
    process.env.LLM_API_KEY = 'sk-test'
    okFetch({ headline: '本周两家需关注', actions: ['跑 npm run upstream:check', '更新台账'], blindspot: '闭源 4 家无人看守' })
    const s = await summarize([R({ agentId: 'a', risk: 'high' })])
    expect(s.headline).toBe('本周两家需关注')
    expect(s.actions).toHaveLength(2)
    expect(s.blindspot).toContain('闭源')
    expect(s.generatedAt).toBeTruthy()
  })

  it('actions 里的非字符串项被丢掉(LLM 常把数组写成对象或混类型)', async () => {
    process.env.LLM_API_KEY = 'sk-test'
    okFetch({ headline: 'x', actions: ['好的动作', null, 42, { a: 1 }, '  '], blindspot: '' })
    const s = await summarize([R({ agentId: 'a', risk: 'high' })])
    expect(s.actions).toEqual(['好的动作'])
  })

  it('headline 超长被截断,避免撑爆面板', async () => {
    process.env.LLM_API_KEY = 'sk-test'
    okFetch({ headline: '啊'.repeat(500), actions: [], blindspot: '' })
    const s = await summarize([R({ agentId: 'a', risk: 'high' })])
    expect(s.headline!.length).toBeLessThanOrEqual(200)
  })
})

describe('核心不变量:LLM 不能改变 brief 的数字', () => {
  it('即使 LLM 谎报"12 家全部高风险",brief 也纹丝不动', async () => {
    process.env.LLM_API_KEY = 'sk-test'
    const results = [R({ agentId: 'a', risk: 'high' }), R({ agentId: 'b', risk: 'low' })]
    const before = buildBrief(results, null)
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              headline: '12 家全部高风险,建议立即全部发版适配',
              actions: ['紧急处理'],
              blindspot: ''
            })
          }
        }]
      })
    })))
    const s = await summarize(results, null)
    // LLM 说了什么随它去
    expect(s.headline).toContain('12 家全部高风险')
    // 但程序统计必须还是原样 —— UI 会把它俩并排显示,对不上用户自己会看见
    expect(s.brief).toEqual(before)
    expect(s.brief.whitebox.high).toBe(1)
    expect(s.brief.whitebox.lowOrNone).toBe(1)
    expect(s.brief.total).toBe(2)
  })

  it('喂给 LLM 的事实里不含 changelog 原文,避免它被长文本带偏', async () => {
    process.env.LLM_API_KEY = 'sk-test'
    const spy = vi.fn(async (_url: string, _init?: { body?: string }) => ({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: '{"headline":"ok","actions":[],"blindspot":""}' } }] })
    }))
    vi.stubGlobal('fetch', spy)
    const secret = 'BREAKING-CHANGE-UNIQUE-MARKER-9182'
    await summarize([R({ agentId: 'a', risk: 'medium', notes: secret })])
    const init = spy.mock.calls[0]?.[1]
    const body = JSON.parse(String(init?.body ?? '{}'))
    const prompt: string = body.messages[0].content
    expect(prompt).not.toContain(secret)
    // 但事实段必须在
    expect(prompt).toContain('已适配 agent 总数:1')
    expect(prompt).toContain('需要处理')
  })
})
