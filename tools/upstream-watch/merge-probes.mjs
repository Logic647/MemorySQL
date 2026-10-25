/**
 * 多源探针合并 —— 开发机与 NAS 各自跑黑盒,云端把两份结果合成一份看板视图。
 * ============================================================================
 * 为什么必须按 agent 合并而不是"最后上报的赢":
 *   /api/probe 原本是单槽位,第二台机器(NAS 探针)一上报就会把开发机的结果
 *   整个冲掉,反之亦然 —— 而开发机上的 zcode/opencode/codex/claudecode/hermes
 *   只有开发机测得了,NAS 上的闭源五家只有 NAS 测得了,两边各是另一半真相。
 *
 * 合并规则(判定的优先级,不是时间的新旧):
 *   1. 任何一家报 drift 都必须浮出:drift > checker_error > stale > ok >
 *      absent/blackbox_only。开发机的 🟢 绝不能盖住 NAS 的 🔴;
 *      反过来 NAS 的 🟢 也要能覆盖开发机的 ⚪(闭源 agent 开发机没装,
 *      只有 NAS 测得到 —— 这正是 NAS 探针存在的意义)
 *   2. 同级取 checkedAt 较新者(同一 agent 两台都装时,谁的数据新听谁的)
 *   3. 胜者带 src 字段标记来源(字段名刻意避开 result.source —— 那是
 *      check.ts 里的"数据源路径",已被占用)
 *
 * checkedAt / ledgerHash 取**有结果的上报里**最新的那份:
 *   - 空 results 的上报不参与代表权,只存档 —— 否则一次失败的探测(报了空数组)
 *     会把面板时间顶成"刚刚",底下却是旧数据,又是"看起来有结论其实缺失"一族
 *   - 指纹契约是"探针 vs 服务器用同一套台账";两源分歧时原始两份都留在
 *     state.probeSources,合并视图取较新者的指纹
 */

const VERDICT_PRIORITY = {
  drift: 0,
  checker_error: 1,
  stale: 2,
  ok: 3,
  absent: 4,
  blackbox_only: 4
}

/**
 * @param {Record<string, {checkedAt?: string|null, ledgerHash?: string|null, results: Array<{id: string, verdict: string, [k: string]: unknown}>}>} sources
 *        键 = 来源标识('dev' / 'nas' / 未来第三台),值 = 该源最后一次上报
 * @returns {{checkedAt: string|null, ledgerHash: string|null, results: Array<object>} | null}
 *          没有任何有效结果时返回 null(调用方保留原 probe,别清空)
 */
export function mergeProbes(sources) {
  const byAgent = new Map()
  let newestAt = null
  let newestHash = null

  for (const [src, probe] of Object.entries(sources ?? {})) {
    if (!probe || !Array.isArray(probe.results) || probe.results.length === 0) continue
    const at = typeof probe.checkedAt === 'string' ? probe.checkedAt : ''
    if (newestAt === null || at >= newestAt) {
      newestAt = at
      newestHash = typeof probe.ledgerHash === 'string' ? probe.ledgerHash : null
    }
    for (const r of probe.results) {
      if (!r || typeof r.id !== 'string') continue
      // checkedAt 落到每条结果上,同级比较才有依据(原始 payload 里没有这字段)
      const cand = { ...r, src, checkedAt: at }
      const prev = byAgent.get(r.id)
      if (!prev) {
        byAgent.set(r.id, cand)
        continue
      }
      const p = VERDICT_PRIORITY[prev.verdict] ?? 9
      const c = VERDICT_PRIORITY[cand.verdict] ?? 9
      if (c < p || (c === p && at >= prev.checkedAt)) byAgent.set(r.id, cand)
    }
  }

  if (!byAgent.size) return null
  return { checkedAt: newestAt, ledgerHash: newestHash, results: [...byAgent.values()] }
}
