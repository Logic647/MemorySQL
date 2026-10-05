/**
 * 带并发上限的 map —— 保序、单点失败不吞掉其余、错误照样可见。
 *
 * ── 为什么不直接用 Promise.all(items.map(fn)) ──
 *
 * 1. 那会一次全开。GitHub 匿名配额 60/小时,全开极易撞限流;而撞限流的表现是
 *    零散的「无法评估」,很容易被当成「上游没更新」忽略掉。
 * 2. 它是"首个 reject 立即整体 reject"——**已经算完的那几项就此丢失**。
 *    12 家里挂 1 家,整轮刷新全废,面板上少了 11 家,而这正是本项目反复吃的
 *    静默失败:看起来有结论,其实结论是缺失造成的。
 *
 * ── 所以这里的契约是 ──
 *
 *   - **绝不因为单项失败而 reject。** 失败槽位留 `undefined`,其余照常返回。
 *   - 错误交给 `onError` 回调,由调用方决定怎么表达(记进 state.error /
 *     打日志 / 标红)。**可见性是调用方的责任,不是被吞掉的借口。**
 *   - 全部项都会被尝试(不 fail-fast),所以 onError 的调用次数 = 失败项数。
 *   - 结果顺序与入参一致 —— 看板按台账顺序展示,顺序一乱,
 *     「第 3 家」在不同轮次里指的就不是同一家了。
 *
 * @param {unknown[]} items
 * @param {number} limit 同时执行的最大数量
 * @param {(item: unknown, index: number) => Promise<unknown>} fn
 * @param {(err: unknown, item: unknown, index: number) => void} [onError]
 * @returns {Promise<unknown[]>} 顺序与 items 一致;失败项为 undefined
 */
export async function mapLimit(items, limit, fn, onError) {
  const n = items.length
  if (n === 0) return []
  const out = new Array(n)
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, n))
  let cursor = 0

  const worker = async () => {
    for (;;) {
      const i = cursor++
      if (i >= n) return
      try {
        out[i] = await fn(items[i], i)
      } catch (e) {
        // 留 undefined 而不是删掉该槽:那样会打乱后续按下标对齐
        out[i] = undefined
        onError?.(e, items[i], i)
      }
    }
  }

  await Promise.all(Array.from({ length: width }, worker))
  return out
}
