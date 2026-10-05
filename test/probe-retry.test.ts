import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import {
  shouldRetryUpload,
  uploadBackoffMs,
  RETRYABLE_STATUS
} from '../tools/upstream-watch/retry.mjs'

/**
 * 上报重试的分类 —— 判错的后果不对称。
 *
 * 该重试的没重试:每日探针有一半概率白跑,平均两天才落一次数据,
 * 而这个功能的价值就是**尽快发现上游漂移**。
 * 不该重试的重试:凭据错时干等 4 次(实测约 6 秒 + 4 次连接尝试),
 * 而真正的网络抖动反而只试一次就放弃 —— 两个错误正好搞反。
 *
 * 分类逻辑抽到 tools/upstream-watch/retry.mjs 就是为了能这样直接单测,
 * 而不是去断言脚本源码的形状。
 */

describe('传输层失败:该重试', () => {
  it('拿不到响应(undefined / null)→ 重试', () => {
    // node fetch 抛错时根本没有 status,这是本机链路最主要的失败形态
    expect(shouldRetryUpload(undefined).retry).toBe(true)
    expect(shouldRetryUpload(null).retry).toBe(true)
  })

  it('理由要说清是传输层,便于日志判断', () => {
    expect(shouldRetryUpload(undefined).why).toMatch(/传输层/)
  })
})

describe('暂时性 HTTP 状态:该重试', () => {
  for (const s of [408, 425, 429, 500, 502, 503, 504]) {
    it(`HTTP ${s} → 重试`, () => {
      expect(shouldRetryUpload(s).retry).toBe(true)
      expect(RETRYABLE_STATUS.has(s)).toBe(true)
    })
  }

  it('429 必须重试(限流是暂时的)', () => {
    // 与云端 fetch.mjs 的原则一致:只有 rateLimited 才值得 retry
    expect(shouldRetryUpload(429).retry).toBe(true)
  })
})

describe('凭据 / 请求问题:重试无用', () => {
  it('401 → 不重试,且理由点名 PROBE_TOKEN', () => {
    // 2026-10-05 起云端对写端点要求真 token,这是最可能踩到的 4xx
    const r = shouldRetryUpload(401)
    expect(r.retry).toBe(false)
    expect(r.why).toMatch(/凭据/)
    expect(r.why).toMatch(/PROBE_TOKEN/)
  })

  it('403 → 不重试', () => {
    expect(shouldRetryUpload(403).retry).toBe(false)
  })

  it('其他 4xx → 不重试', () => {
    // 400/404/413 等:请求本身有问题,再发一次结果一样
    for (const s of [400, 404, 413, 422]) {
      expect(shouldRetryUpload(s).retry, `HTTP ${s} 不该重试`).toBe(false)
    }
  })

  it('2xx 不该出现在失败路径上,但也不该崩', () => {
    expect(() => shouldRetryUpload(200)).not.toThrow()
  })
})

describe('退避时长', () => {
  it('线性递增,不做指数增长', () => {
    // 指数增长在每日任务上是灾难:第 4 次要等 8 秒,而实测本机链路的抖动
    // 是**秒级**的 —— 一次失败到成功常常不到 1 秒
    expect(uploadBackoffMs(1)).toBe(1000)
    expect(uploadBackoffMs(2)).toBe(2000)
    expect(uploadBackoffMs(3)).toBe(3000)
  })

  it('总等待不超过 ~6 秒(4 次尝试)', () => {
    const total = [1, 2, 3].reduce((s, a) => s + uploadBackoffMs(a), 0)
    expect(total).toBeLessThanOrEqual(6000)
  })
})

describe('探针真的用上了这个分类', () => {
  const src = fs.readFileSync(new URL('../scripts/upstream-probe.mjs', import.meta.url), 'utf8')

  it('import 了分类函数,而不是自己再写一套状态码集合', () => {
    expect(src).toMatch(/import \{ shouldRetryUpload, uploadBackoffMs \}/)
    // 分类逻辑只有一处。散在脚本里就等于有两份,改一份忘一份。
    expect(src).not.toMatch(/new Set\(\[\s*408/)
  })

  it('按分类决定是否继续重试', () => {
    expect(src).toMatch(/const verdict = shouldRetryUpload\(res\?\.status\)/)
    expect(src).toMatch(/if \(!verdict\.retry\) break/)
  })

  it('失败日志带上"该不该重试"的判断', () => {
    // 凭据错时如果只写「HTTP 401」,人会以为是网络抖动然后干等重试
    expect(src).toMatch(/—— \$\{lastWhy\}/)
  })

  it('仍然校验响应体(只看 status 会被"HTML 但 200"骗过去)', () => {
    // 这是旧有的坑,不能因为加了重试而丢掉
    expect(src).toMatch(/ack\.ok !== true/)
  })
})
