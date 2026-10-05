import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'

/**
 * 写操作的回执不得被 LLM 往返阻塞。
 *
 * 实测踩过:探针上报返回 **504**。根因不在网络、也不在鉴权,而是服务端把
 * `json(res, 200, …)` 放在 `recomputeSummary().finally()` 里 —— 每次上报都要
 * 等 summarizer 跑完一次 LLM。实测**空 results 也要 26 秒**,而 nginx 的
 * proxy_read_timeout 是 30 秒。
 *
 * 最坏的地方不是超时,是**它长得像失败**:数据其实已经存进 state.json 了,
 * 调用方只看到一个网关错误,合理地重试、再超时。而从面板上完全看不出
 * 数据其实是好的。`/api/refresh` 有同一个毛病,只是更严重 —— runOnce 串行
 * 遍历 12 家、每家都可能调 LLM,一次能跑几分钟。
 *
 * 这些用例断言的是**代码形状**(回执不在异步链上),因为把服务真跑起来注入
 * 一个 26 秒的假 LLM 太重;真正的时间行为由下面的 spawn 冒烟测试覆盖。
 */

const SERVER = path.join(process.cwd(), 'tools', 'upstream-watch', 'server.mjs')
const src = fs.readFileSync(SERVER, 'utf8')

/**
 * 去掉整行注释再匹配。
 *
 * 踩过:断言 `not.toMatch(/recomputeSummary\(\)\.finally/)` 结果被**自己写的注释**打挂 ——
 * 那条注释正好在解释"旧实现是 `recomputeSummary().finally()`",于是源码文本断言
 * 匹配到了文档。扫源码文本的断言必须先剥注释,否则改一次注释就红一次。
 */
const code = (s: string): string =>
  s.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

/** 取出某个路由块的源码(已剥注释) */
function route(marker: string, len = 1600): string {
  const i = src.indexOf(marker)
  expect(i, `找不到路由 ${marker}`).toBeGreaterThan(-1)
  return code(src.slice(i, i + len))
}

describe('/api/probe 的回执不等 LLM', () => {
  const block = route("url.pathname === '/api/probe'")

  it('回执不在 recomputeSummary 的 finally 里', () => {
    // 旧形状:void recomputeSummary().finally(() => { ...; json(res, 200, …) })
    expect(block).not.toMatch(/recomputeSummary\(\)\.finally/)
  })

  it('先落盘再回执,顺序不能反', () => {
    // 数据必须先 saveState,否则回执说"收下了"而盘上还没有
    const save = block.indexOf('saveState()')
    const ack = block.indexOf('json(res, 200')
    expect(save, 'probe 路由里应有 saveState()').toBeGreaterThan(-1)
    expect(ack, 'probe 路由里应有 200 回执').toBeGreaterThan(-1)
    expect(save, 'saveState 必须排在回执之前').toBeLessThan(ack)
  })

  it('回执明说摘要待重算,不假装已一致', () => {
    // 面板在那 26 秒里显示的是上一轮结论。不标 pending 就是让调用方误以为已一致。
    expect(block).toMatch(/summary:\s*'pending'/)
  })

  it('重算走串行队列,不是裸 void', () => {
    expect(block).toMatch(/refreshSummarySoon\(\)/)
  })
})

describe('串行化摘要重算', () => {
  it('存在队列,避免并发写 state.json 互相覆盖', () => {
    // 两个请求同时到达会各算一次各写一次盘,后写的可能带着旧 summary 覆盖新数据,
    // 而那种丢失不报错,只让面板停在旧结论上。
    expect(src).toMatch(/let summaryQueue = Promise\.resolve\(\)/)
    // \s* 而不是 \. :实现里为了可读性换行了,写成一行匹配会误报
    expect(code(src)).toMatch(/summaryQueue = summaryQueue\s*\n?\s*\.then\(/)
  })

  it('队列不会因一次失败而永久卡死', () => {
    const fn = code(src.slice(src.indexOf('function refreshSummarySoon')))
    // 必须 catch:summaryQueue 一旦 reject,后续 .then 全挂在已 reject 的 promise 上,
    // 摘要永久冻结 —— 与 `running` 落盘那次同一族(瞬时故障变成永久失效)。
    expect(fn.slice(0, 700)).toMatch(/\.catch\(/)
  })
})

describe('/api/refresh 立刻回执,不阻塞在整轮抓取上', () => {
  const block = route("url.pathname === '/api/refresh'", 1200)

  it('回 202 而不是等 runOnce 跑完', () => {
    expect(block).toMatch(/202/)
    expect(block).not.toMatch(/runOnce\(\)\.then\(\(\)\s*=>\s*json/)
  })

  it('仍在跑时回 409(这条不能被改坏)', () => {
    // 「已有抓取在进行」必须与「成功」区分开 —— 否则页面会把陈旧数据当刷新成功
    expect(block).toMatch(/409/)
    expect(block).toMatch(/state\.running/)
  })
})

describe('页面与新的 202 契约对齐', () => {
  const web = fs.readFileSync(
    path.join(process.cwd(), 'tools', 'upstream-watch', 'web', 'index.html'), 'utf8')

  it('认得 202 并改为轮询 running', () => {
    expect(web).toMatch(/res\.status === 202/)
    expect(web).toMatch(/!s\.running/)
  })

  it('轮询失败不当成整轮失败', () => {
    // 单次轮询挂了就再试;否则一次网络抖动会把一次成功的抓取报成失败
    expect(web).toMatch(/\.catch\(\(\)\s*=>\s*null\)/)
  })

  it('轮询有上限,不会无限转圈', () => {
    expect(web).toMatch(/i < \d+/)
  })
})

describe('冒烟:服务能起来且 /api/probe 秒回', () => {
  it('响应不等待摘要(实测毫秒级,而摘要要几十秒)', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msql-watch-'))
    const env = {
      ...process.env,
      PORT: '0',                        // 0 = 让系统分配随机端口,避免撞上在跑的实例
      AUTH_TOKEN: 'test-token',
      // STATE_PATH 是可覆盖的(见 server.mjs);不给它的话冒烟测试会写进
      // 仓库里的 tools/upstream-watch/state.json —— 污染开发机真实状态。
      STATE_PATH: path.join(dataDir, 'state.json'),
      LEDGER_PATH: path.join(process.cwd(), 'upstream', 'ledger.json'),
      LLM_API_KEY: '',                  // 不给 key:summarize 走纯规则,不联网
      REFRESH_HOURS: '9999'
    }
    const child = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    const out: string[] = []
    child.stdout.on('data', (d) => out.push(String(d)))
    child.stderr.on('data', (d) => out.push(String(d)))

    try {
      // 等它把端口打出来
      const deadline = Date.now() + 15000
      let port = 0
      while (Date.now() < deadline) {
        const m = out.join('').match(/127\.0\.0\.1:(\d+)/)
        if (m) { port = Number(m[1]); break }
        await new Promise((r) => setTimeout(r, 200))
      }
      expect(port, '服务应在 15 秒内报出监听端口。输出:\n' + out.join('')).toBeGreaterThan(0)

      const base = `http://127.0.0.1:${port}`
      const post = (p: string, body: unknown, token?: string) =>
        fetch(base + p, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {})
          },
          body: JSON.stringify(body)
        })

      // 鉴权仍必须生效
      expect((await post('/api/probe', { results: [] })).status).toBe(401)

      // 关键:带 token 上报,计时
      const t0 = Date.now()
      const res = await post('/api/probe', {
        checkedAt: '2026-01-01T00:00:00.000Z',
        ledgerHash: 'deadbeef',
        results: [{ id: 'zcode', verdict: 'ok' }]
      }, 'test-token')
      const ms = Date.now() - t0

      expect(res.status, '带正确 token 应被接受').toBe(200)
      const ack = (await res.json()) as { ok: boolean; accepted: number; summary?: string }
      expect(ack.ok).toBe(true)
      expect(ack.accepted).toBe(1)
      expect(ack.summary, '回执应标明摘要待重算').toBe('pending')
      // 摘要走纯规则也要几十毫秒;旧实现会等它完成。这里给 5s 余量,
      // 目的是抓住"又变回阻塞式"这种回归,而不是测性能。
      expect(ms, `上报耗时 ${ms}ms,看起来仍在等摘要`).toBeLessThan(5000)

      // 数据必须真的落盘(回执说收下了,盘上就得有)
      const st = await fetch(base + '/api/state', {
        headers: { Authorization: 'Bearer test-token' }
      }).then((r) => r.json()) as { probe: { ledgerHash: string | null; results: unknown[] } }
      expect(st.probe.results, '数据应已落盘').toHaveLength(1)
      expect(st.probe.ledgerHash).toBe('deadbeef')
    } finally {
      child.kill()
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  }, 40000)
})
