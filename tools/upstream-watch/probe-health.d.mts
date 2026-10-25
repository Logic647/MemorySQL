/**
 * probe-health.mjs 的类型声明 —— 让 TS 测试能拿到类型。
 */
export declare const LATE_AFTER_HOURS: number
export declare const LOST_AFTER_HOURS: number

export interface ProbeHealthEntry {
  state: 'ok' | 'late' | 'lost' | 'empty'
  checkedAt: string | null
  count: number
  ageHours: number | null
}

export declare function probeHealthView(
  sources: Record<string, { checkedAt?: string | null; results?: Array<unknown> } | null | undefined>,
  now?: Date,
  opts?: { lateAfterHours?: number; lostAfterHours?: number }
): Record<string, ProbeHealthEntry>
