import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { httpJson } from '../tools/upstream-watch/fetch.mjs'
import type { HttpErr } from '../tools/upstream-watch/fetch.mjs'
import fs from 'node:fs'

/**
 * httpJson 的 403/429 分类。
 *
 * 为什么值得单独测:GitHub 用 403/429 至少表示四种**处置方式互斥**的情况
 * (主限流 / 二级滥用 / 授权不足 / IP 级封禁)。旧实现把它们全标成「限流」且丢掉
 * 响应体,于是 2026-09-30 一次 IP 级滥用检测被误读成「token 没配好」,白排查一轮。
 * 这里每条用例锁住一种区分,防止将来又退回成一锅粥。
 */
type Reply = { status: number; headers: Record<string, string>; body: string }
type FetchInit = { headers?: Record<string, string> }
const URL_UNDER_TEST = 'https://api.github.com/repos/x/y/releases?per_page=5'

function mockFetch(reply: Reply) {
  const spy = vi.fn(async (_url: string, _init?: FetchInit) => ({
    status: reply.status,
    statusText: '',
    ok: reply.status >= 200 && reply.status < 300,
    headers: { get: (k: string) => reply.headers[k.toLowerCase()] ?? null },
    json: async () => JSON.parse(reply.body || 'null'),
    text: async () => reply.body
  }))
  // @ts-expect-error 只替换本次测试用到的全局
  globalThis.fetch = spy
  return spy
}

/** 断言这次调用失败,并把收窄后的错误结果交出来 —— 免得每个用例都写一遍 if (r.ok) throw */
async function expectErr(): Promise<HttpErr> {
  const r = await httpJson(URL_UNDER_TEST)
  if (r.ok) throw new Error(`expected a failure, but got HTTP ${r.status}`)
  return r
}

const realToken = process.env.GITHUB_TOKEN
beforeEach(() => { delete process.env.GITHUB_TOKEN })
afterEach(() => {
  if (realToken === undefined) delete process.env.GITHUB_TOKEN
  else process.env.GITHUB_TOKEN = realToken
})

describe('httpJson — 403/429 分类', () => {
  it('主限流:说清是配额耗尽并给出重置时间,而不是笼统「限流」', async () => {
    const reset = Math.floor(Date.now() / 1000) + 3600
    mockFetch({
      status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
      body: '{"message":"API rate limit exceeded"}'
    })
    const r = await expectErr()
    expect(r.status).toBe(403)
    expect(r.rateLimited).toBe(true)
    expect(r.error).toContain('主限流')
    expect(r.error).toMatch(/分钟后重置/)
  })

  it('二级限流:识别 secondary rate limit,标记为可自愈', async () => {
    mockFetch({
      status: 429,
      headers: {},
      body: '{"message":"You have exceeded a secondary rate limit. Please wait a few minutes before you try again."}'
    })
    const r = await expectErr()
    expect(r.rateLimited).toBe(true)
    expect(r.error).toContain('二级限流')
  })

  it('授权不足:必须与限流区分开 —— 这是 token 配错,等多久都没用', async () => {
    mockFetch({
      status: 403,
      headers: { 'x-ratelimit-remaining': '4999' },
      body: '{"message":"Resource not accessible by personal access token"}'
    })
    const r = await expectErr()
    // 判别依据是这个布尔位,不是文案 —— 文案里恰好带了「限流」二字(「这不是限流」),
    // 用 not.toContain('限流') 断言会自己把自己测挂。
    expect(r.rateLimited).toBe(false)
    expect(r.error).toContain('拒绝授权')
  })

  it('配额还剩很多却 403:判定为「非限流」,不再误导', async () => {
    mockFetch({
      status: 403,
      headers: { 'x-ratelimit-remaining': '4990' },
      body: '{"message":"Repository access blocked"}'
    })
    const r = await expectErr()
    expect(r.rateLimited).toBe(false)
    expect(r.error).toContain('不是限流')
  })

  it('始终带上 GitHub 原话,便于不猜原因', async () => {
    mockFetch({
      status: 403,
      headers: {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600)
      },
      body: '{"message":"You have triggered an abuse detection mechanism"}'
    })
    const r = await expectErr()
    expect(r.error).toContain('GitHub 原话')
    expect(r.error).toContain('abuse detection mechanism')
  })

  it('响应体读不出来时也不能抛 —— 仍要给出可读结论', async () => {
    globalThis.fetch = vi.fn(async (_u: string, _i?: FetchInit) => ({
      status: 403,
      statusText: '',
      ok: false,
      headers: { get: () => null },
      json: async () => null,
      text: async () => { throw new Error('stream already consumed') }
    })) as never
    const r = await expectErr()
    expect(typeof r.error).toBe('string')
    expect(r.error.length).toBeGreaterThan(0)
  })

  it('真实 404 不会被误当成限流', async () => {
    mockFetch({ status: 404, headers: {}, body: '{"message":"Not Found"}' })
    const r = await expectErr()
    expect(r.status).toBe(404)
    expect(r.error).toContain('404')
  })
})

describe('httpJson — 正常路径', () => {
  it('200 正常返回数据', async () => {
    mockFetch({ status: 200, headers: {}, body: '[{"tag_name":"v1.2.3"}]' })
    const r = await httpJson(URL_UNDER_TEST)
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    expect(Array.isArray(r.data)).toBe(true)
  })

  it('GITHUB_TOKEN 存在时才发 Authorization(匿名时不能发空 Bearer)', async () => {
    const spy = mockFetch({ status: 200, headers: {}, body: '{}' })
    await httpJson(URL_UNDER_TEST)
    const h1 = spy.mock.calls[0]?.[1]?.headers ?? {}
    expect(h1.Authorization).toBeUndefined()

    process.env.GITHUB_TOKEN = 'github_pat_example'
    const spy2 = mockFetch({ status: 200, headers: {}, body: '{}' })
    await httpJson(URL_UNDER_TEST)
    const h2 = spy2.mock.calls[0]?.[1]?.headers ?? {}
    expect(h2.Authorization).toBe('Bearer github_pat_example')
  })
})

describe('commit 回退:per_page 不能重复', () => {
  it('URL 只有一个 per_page(重复键会让服务端取哪个变得不可预测)', () => {
    const src = fs.readFileSync(new URL('../tools/upstream-watch/fetch.mjs', import.meta.url), 'utf8')
    const line = src.split('\n').find((l) => l.includes('/commits?per_page='))
    expect(line).toBeDefined()
    const matches = line!.match(/per_page=\d+/g) ?? []
    expect(matches).toHaveLength(1)
    expect(matches[0]).toBe('per_page=15')
  })
})
