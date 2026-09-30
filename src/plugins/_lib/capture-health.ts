import type { CaptureHealth } from '../../shared/types'

/**
 * 捕获健康度判定 —— capture-factory / capture-zcode / capture-hermes 共用,
 * 避免三处独立实现导致口径漂移。
 */

/** 连续失败达到此值即判定 failing(极可能是上游格式漂移) */
export const FAILING_THRESHOLD = 3

export function healthFrom(consecutiveFailures: number, hasSuccess: boolean): CaptureHealth {
  if (consecutiveFailures >= FAILING_THRESHOLD) return 'failing'
  if (consecutiveFailures > 0) return 'suspect'
  return hasSuccess ? 'healthy' : 'unknown'
}

/** 增量解析失败的诊断信息:取错误文本 + 出错文件,截断到可读长度 */
export function failureDetail(err: unknown, file?: string): string {
  const msg = err instanceof Error ? err.message : String(err)
  const where = file ? ` @ ${file}` : ''
  const one = `${msg}${where}`.replace(/\s+/g, ' ').trim()
  return one.length > 200 ? `${one.slice(0, 200)}…` : one
}
