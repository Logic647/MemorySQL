/**
 * fingerprint.mjs 的最小类型声明 —— 让 TS 测试能拿到类型(否则 TS7016 隐式 any)。
 */

export interface FingerprintComparison {
  /** match = 两边一致;mismatch = 契约不同,结论不可比;unknown = 有一边没带指纹 */
  state: 'match' | 'mismatch' | 'unknown'
  server: string | null
  probe: string | null
}

export function ledgerFingerprint(ledger: { agents?: unknown[] } | null | undefined): string

export function compareFingerprints(
  serverHash: string | null | undefined,
  probeHash: string | null | undefined
): FingerprintComparison
