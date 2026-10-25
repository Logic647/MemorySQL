/**
 * 探针源心跳健康 —— 「探针自己失联了」必须和「agent 漂移」一样可见。
 * ============================================================================
 * 整个黑盒监控的价值建立在「探针每天真的在上报」上:NAS 断电、cron 被清、
 * 开发机计划任务错过(2026-10 实测发生过)—— 任何一种都会让看板停在
 * 最后一份数据上,页面照常渲染、绿得心安理得。这与 running 落盘、
 * 空上报顶时间同一族:**看起来有结论,其实结论是缺失造成的**。
 *
 * 所以心跳在服务端每次 /api/state 现算(不落盘 —— age 随时间流逝,
 * 落盘的 age 是谎言),阈值对齐部署节奏:两台探针 cron 都是每日一跑
 * (dev 10:07 / nas 10:37),给出几个小时的重试与时区余量:
 *   ≤36h  ok    正常(错过当天但仍在余量内)
 *   ≤72h  late  迟到 —— 错过了一整天,该去看探针机器了
 *   >72h  lost  失联 —— 错过两天以上,黑盒数据已不可信
 *   count=0 empty 探针跑过但交了白卷(比失联更可疑:多半是探测本身坏了)
 */

export const LATE_AFTER_HOURS = 36
export const LOST_AFTER_HOURS = 72

/**
 * @param {Record<string, {checkedAt?: string|null, results?: Array<unknown>}|null|undefined>} sources
 * @param {Date} now
 * @param {{lateAfterHours?: number, lostAfterHours?: number}} [opts] 测试可覆盖阈值
 * @returns {Record<string, {state: 'ok'|'late'|'lost'|'empty', checkedAt: string|null,
 *            count: number, ageHours: number|null}>}
 */
export function probeHealthView(sources, now = new Date(), opts = {}) {
  const lateAfter = opts.lateAfterHours ?? LATE_AFTER_HOURS
  const lostAfter = opts.lostAfterHours ?? LOST_AFTER_HOURS
  const view = {}
  for (const [name, p] of Object.entries(sources ?? {})) {
    const count = Array.isArray(p?.results) ? p.results.length : 0
    const checkedAt = typeof p?.checkedAt === 'string' ? p.checkedAt : null
    const at = checkedAt ? Date.parse(checkedAt) : NaN
    if (!count || Number.isNaN(at)) {
      // 空上报单独一态:探针活着但什么都没测出来,和「没上报」处置不同
      view[name] = { state: 'empty', checkedAt, count, ageHours: null }
      continue
    }
    const ageH = (now.getTime() - at) / 3_600_000
    view[name] = {
      state: ageH <= lateAfter ? 'ok' : ageH <= lostAfter ? 'late' : 'lost',
      checkedAt,
      count,
      ageHours: Math.round(ageH * 10) / 10
    }
  }
  return view
}
