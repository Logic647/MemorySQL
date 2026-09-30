/**
 * summarize.mjs 的最小类型声明 —— 让 TS 测试能拿到类型(否则 TS7016 隐式 any)。
 * 只声明测试与调用方实际用到的形状,不做过度约束。
 */

export interface EvalLike {
  agentId: string
  risk: 'none' | 'low' | 'medium' | 'high' | 'unknown'
  version?: string | null
  notes?: string
  blackboxOnly?: boolean
  llm?: { affectsCapture?: boolean; affectsMcp?: boolean; reason?: string } | null
  llmError?: string
  fetchError?: string | null
}

export interface ProbeLike {
  checkedAt?: string
  results?: Array<{
    id: string
    verdict: 'ok' | 'drift' | 'checker_error' | 'absent' | 'blackbox_only' | string
    detail?: string
  }>
}

export interface AttentionItem {
  id: string
  version: string | null
  risk: string
  reasons: string[]
  llmReason: string | null
  blackboxDetail: string | null
}

export interface LedgerAgreement {
  /** match = 两边一致;mismatch = 契约不同,结论不可比;unknown = 有一边没带指纹 */
  state: 'match' | 'mismatch' | 'unknown'
  server: string | null
  probe: string | null
}

export interface Brief {
  total: number
  whitebox: { high: number; medium: number; lowOrNone: number; unknown: number }
  llm: { hit: number; clear: number; error: number; notInvoked: number }
  blackbox: {
    reported: boolean
    checkedAt: string | null
    drift: number
    checkerError: number
    ok: number
    absent: number
    blackboxOnly: number
  }
  /** 白盒(云端台账)与黑盒(开发机台账)是否基于同一版适配契约 */
  ledger: LedgerAgreement
  attention: AttentionItem[]
  closedSource: Array<{ id: string; blackbox: string; detail: string }>
  fetchErrors: Array<{ id: string; error: string | null }>
}

export interface Summary {
  brief: Brief
  headline: string | null
  actions: string[]
  blindspot: string | null
  error: string | null
  generatedAt: string | null
  llmInvoked: boolean
}

export function buildBrief(
  results: EvalLike[],
  probe?: ProbeLike | null,
  ledger?: LedgerAgreement
): Brief

export function summarize(
  results: EvalLike[],
  probe?: ProbeLike | null,
  ledger?: LedgerAgreement
): Promise<Summary>
