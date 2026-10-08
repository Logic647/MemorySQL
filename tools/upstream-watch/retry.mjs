/**
 * 上报失败该怎么处理 —— 抽出来是为了能单测,而不是靠断言源码形状。
 *
 * ── 为什么需要区分 ──
 *
 * 本机到云端的链路实测约一半的时候会 `fetch failed`(出口走透明代理,
 * 长连接被掐)。但**不是所有失败都值得重试**:
 *
 *   `fetch failed` / 超时 / 5xx  → 下一次可能就通,**该重试**
 *   401 / 403(凭据错)          → 重试一万次还是 401,**纯属浪费**
 *
 * 这与云端 `fetch.mjs` 的原则一致:**只有"重试有意义"的错误才重试**。
 * 把两者混为一谈的代价是:凭据错时干等 4 次(约 6 秒 + 4 次连接),
 * 而真正的网络抖动反而只试一次就放弃。
 */

/** 值得重试的 HTTP 状态码 */
export const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])

/**
 * 决定某次上报失败要不要再试。
 *
 * @param {number|null|undefined} status HTTP 状态码;null/undefined 表示请求根本没拿到响应(传输层失败)
 * @returns {{ retry: boolean, why: string }}
 */
export function shouldRetryUpload(status) {
  if (status === null || status === undefined) {
    return { retry: true, why: '传输层失败(连接被重置/超时/DNS 抖动)' }
  }
  if (status >= 200 && status < 300) {
    // 成功。曾经缺这个分支,200 落到最后的默认 retry:true —— 结果每次成功上报
    // 都被当失败,日志连写 3 条「失败(HTTP 200)」、同一 payload 重复 POST 4 次
    // (2026-10-08 实测日志)。「成功看起来像失败」是本项目反复踩的坑族,必须显式。
    return { retry: false, why: `HTTP ${status} 成功,无需重试` }
  }
  if (RETRYABLE_STATUS.has(status)) {
    return { retry: true, why: `HTTP ${status} 是暂时性状态` }
  }
  if (status === 401 || status === 403) {
    // 明确区分出来:日志里要能看出"重试没用",否则人会以为是网络问题
    return { retry: false, why: `HTTP ${status} 是凭据问题,重试无用(检查 PROBE_TOKEN)` }
  }
  if (status >= 400 && status < 500) {
    return { retry: false, why: `HTTP ${status} 是请求本身的问题,重试无用` }
  }
  return { retry: true, why: `HTTP ${status} 按可重试处理` }
}

/**
 * 指数退避的等待毫秒。
 * 刻意不做指数增长:探针是每日任务,卡太久没有意义;
 * 也刻意不做更长:本机链路的失败是**秒级**抖动(实测两次失败间隔不到 1 秒就成功)。
 */
export function uploadBackoffMs(attempt) {
  return attempt * 1000
}
