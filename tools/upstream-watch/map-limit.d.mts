/**
 * map-limit.mjs 的类型声明 —— 让 TS 测试能拿到类型。
 */
export function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R> | R,
  /** 每一项失败时调用一次;mapLimit 自身**不会**因单项失败而 reject */
  onError?: (err: unknown, item: T, index: number) => void
): Promise<(R | undefined)[]>
