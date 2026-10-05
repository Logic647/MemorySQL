import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { mapLimit } from '../tools/upstream-watch/map-limit.mjs'

/**
 * 带界并发 —— 三个性质里少一个就会伤到结论可信度:
 *
 *  1. **顺序必须与入参一致。** 看板按台账顺序渲染,顺序一乱,
 *     「第 3 家」在不同轮次里指的就不是同一家 —— 比缺一家更糟。
 *  2. **一项失败不能吞掉其余。** 12 家里挂 1 家,另外 11 家必须照常返回。
 *     常见的 `Promise.all(items.map(fn))` 是"首个 reject 整体 reject",
 *     已经算完的那几项就此丢失,面板上凭空少 11 家 ——
 *     这正是本项目反复吃的静默失败:看起来有结论,其实结论是缺失造成的。
 *  3. **并发必须有上限。** 撞 GitHub 限流的表现是零散「无法评估」,
 *     很容易被当成「上游没更新」忽略掉。
 *
 * 契约:**mapLimit 自身绝不因单项失败而 reject**,错误交给 onError。
 * 可见性是调用方的责任(onError → state.error),不是被吞掉的借口。
 */

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 剥掉整行注释再匹配 —— 断言扫源码时必须做,否则改一次注释就红一次 */
const code = (s: string): string =>
  s.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*')).join('\n')

describe('mapLimit 保序与并发', () => {
  it('完成顺序打乱,结果仍按入参排列', async () => {
    const delays = [40, 5, 30, 1, 20]
    const out = await mapLimit(delays, 3, async (d, i) => {
      await tick(d)
      return `${i}:${d}`
    })
    // 不保序的话这里会是按完成时间排的 3,1,4,0,2
    expect(out).toEqual(['0:40', '1:5', '2:30', '3:1', '4:20'])
  })

  it('确实并发:总耗时接近最慢一项,而不是各项之和', async () => {
    const t0 = Date.now()
    await mapLimit([60, 60, 60, 60], 4, async () => {
      await tick(60)
    })
    const ms = Date.now() - t0
    // 串行会 ≥240ms;余量只为抓住"退化成串行"这种回归,不是性能基准
    expect(ms, `并发下耗时 ${ms}ms,看起来退化成串行了`).toBeLessThan(200)
  })

  it('尊重上限', async () => {
    let active = 0
    let peak = 0
    await mapLimit(Array.from({ length: 10 }, (_, i) => i), 3, async () => {
      active++
      peak = Math.max(peak, active)
      await tick(15)
      active--
    })
    expect(peak).toBeLessThanOrEqual(3)
    expect(peak).toBeGreaterThan(1)
  })

  it('limit=1 等价于串行', async () => {
    const order: number[] = []
    await mapLimit([1, 2, 3], 1, async (n) => {
      order.push(n)
      await tick(1)
    })
    expect(order).toEqual([1, 2, 3])
  })

  it('limit 大于项数时不会多开 worker', async () => {
    let peak = 0
    let active = 0
    await mapLimit([1, 2], 99, async () => {
      active++
      peak = Math.max(peak, active)
      await tick(10)
      active--
    })
    expect(peak).toBe(2)
  })

  it('空数组直接返回空', async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([])
  })
})

describe('单项失败:不吞掉其余,但错误可见', () => {
  it('一项失败时,其余结果全部照常返回(不 reject)', async () => {
    const out = await mapLimit([1, 2, 3, 4, 5], 3, async (n) => {
      if (n === 3) throw new Error('boom')
      return n * 10
    })
    expect(out).toEqual([10, 20, undefined, 40, 50])
  })

  it('失败项留 undefined 占位,**不打乱后续下标**', async () => {
    // 关键:不能用 splice/filter 去掉失败项,那样后面全部前移一位,
    // 面板按下标渲染就会张冠李戴 —— 比缺一家更难查。
    const out = await mapLimit([1, 2, 3], 1, (n) => {
      if (n === 1) throw new Error('x')
      return n
    })
    expect(out).toHaveLength(3)
    expect(out[0]).toBeUndefined()
    expect(out[1]).toBe(2)
    expect(out[2]).toBe(3)
  })

  it('onError 收到每一项失败,且**不 fail-fast**(失败数 = 错误数)', async () => {
    const errs: string[] = []
    await mapLimit([1, 2, 3, 4], 2, async (n) => {
      if (n % 2 === 1) throw new Error(`odd-${n}`)
      return n
    }, (e, _item, i) => errs.push(`${i}:${(e as Error).message}`))
    expect(errs.sort()).toEqual(['0:odd-1', '2:odd-3'])
  })

  it('**所有项都会被尝试完**,不会因首个失败而中止', async () => {
    // fail-fast 的实现会只跑到第 1 项就停,后面 3 项的副作用从未发生
    const ran: number[] = []
    await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      ran.push(n)
      if (n === 1) throw new Error('first explodes')
      return n
    })
    expect(ran.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
  })

  it('全部失败也不 reject,只是全为 undefined', async () => {
    const n = await mapLimit([1, 2, 3], 3, async () => {
      throw new Error('always')
    })
    expect(n).toEqual([undefined, undefined, undefined])
  })

  it('同步抛出的 fn 也接得住', async () => {
    const out = await mapLimit([1, 2, 3], 2, (n) => {
      if (n === 2) throw new Error('sync boom')
      return n
    })
    expect(out).toEqual([1, undefined, 3])
  })

  it('没有 onError 时也不该崩(错误仍不静默:槽位是 undefined)', async () => {
    const out = await mapLimit([1, 2], 2, (n) => {
      if (n === 1) throw new Error('quiet')
      return n
    })
    expect(out[0]).toBeUndefined()
    expect(out[1]).toBe(2)
  })
})

describe('runOnce 用它,且失败会显式进 state.error', () => {
  const raw = fs.readFileSync(new URL('../tools/upstream-watch/server.mjs', import.meta.url), 'utf8')
  const body = code(raw.slice(raw.indexOf('async function runOnce'), raw.indexOf('function auth')))

  it('两段都用 mapLimit,且并发数不同(抓取 4 / LLM 2)', () => {
    expect(body).toMatch(/mapLimit\(agents, 4, \(a\) => fetchUpstream\(a\), note\('抓取'\)\)/)
    expect(body).toMatch(/mapLimit\(\s*agents,\s*2,/)
  })

  it('没有裸 Promise.all(items.map(...)) —— 那会一次全开', () => {
    expect(body).not.toMatch(/Promise\.all\(\s*agents\.map/)
  })

  it('抓取段允许 4 路,但 **LLM 段不得超过 2 路**', () => {
    // 上一版把两段一起禁了,结果把合法的 4 路抓取也判红 —— 断言要指明是哪一段。
    // 也不能"从 llmEnhance 往前回看 N 字符找数字":两次 mapLimit 挨得很近,
    // 回看窗口会把**抓取那段的 4** 捡回来(实测踩过)。各自用独特锚点最稳。
    const m = body.match(/mapLimit\(\s*agents,\s*(\d+),\s*async \(agent, i\) => llmEnhance/)
    expect(m, `LLM 段的 mapLimit 并发数没匹配上。上下文:\n${body.slice(0, 900)}`).toBeTruthy()
    expect(Number(m![1]), `LLM 段并发是 ${m![1]},应 ≤2`).toBeLessThanOrEqual(2)
  })

  it('顺序:先抓上游,再评估(按代码位置判断,注释已剥掉)', () => {
    expect(body.indexOf('fetchUpstream')).toBeGreaterThan(-1)
    expect(body.indexOf('fetchUpstream')).toBeLessThan(body.indexOf('llmEnhance'))
  })

  it('失败被收集并写进 state.error,不静默', () => {
    expect(body).toMatch(/const failed = \[\]/)
    expect(body).toMatch(/note\('抓取'\)/)
    expect(body).toMatch(/note\('评估'\)/)
    expect(body).toMatch(/state\.error = failed\.length \? failed\.join/)
  })

  it('评估失败的槽位补占位,保证 results 与台账逐项对齐', () => {
    // 不补的话 results 会比台账短,面板按下标渲染就张冠李戴
    expect(body).toMatch(/out\[i\] === undefined/)
    expect(body).toMatch(/agentId: agents\[i\]\.id/)
  })
})
