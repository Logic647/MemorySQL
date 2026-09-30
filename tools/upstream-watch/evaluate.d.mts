/**
 * evaluate.mjs 的最小类型声明 —— 让 TS 测试能拿到类型(否则 TS7016 隐式 any)。
 * 只声明测试与调用方实际用到的形状,不做过度约束。
 */

export interface RuleResult {
  risk: 'none' | 'low' | 'medium' | 'high'
  hits: string[]
  strongHits: string[]
  negatedBy: string[]
  note: string
}

export interface EvalResult {
  agentId: string
  version: string | null
  publishedAt: string | null
  url: string | null
  notes: string
  fetchError: string | null
  fallbackUsed: boolean
  fallbackReason: string | null
  risk: 'none' | 'low' | 'medium' | 'high' | 'unknown'
  riskLabel: string
  hits: string[]
  reason: string
  blackboxOnly?: boolean
  llm: unknown
  llmError?: string
}

export interface LlmVerdict {
  affectsCapture: boolean
  affectsMcp: boolean
  severity: 'none' | 'low' | 'medium' | 'high'
  reason: string
}

export function ruleEvaluate(changelog: unknown, agent: { riskKeywords?: string[] }): RuleResult

export function evaluate(
  agent: {
    id: string
    name: string
    monitor: string
    upstream?: { kind: string; repo?: string }
    riskKeywords?: string[]
    mcp?: { file: string; jsonpath: string; requiredKeys: string[] }
    source?: { kind: string; sqlite?: { tablesAnyOf: string[][] }; jsonl?: { fileMatch: string; parser: string } }
  },
  upstream: {
    version?: string | null
    publishedAt?: string | null
    url?: string | null
    notes?: string
    error?: string | null
    fallbackUsed?: boolean
    fallbackReason?: string | null
  }
): EvalResult

export function llmEnhance(
  result: EvalResult,
  agent: unknown
): Promise<EvalResult & { llm?: LlmVerdict | null; llmError?: string }>
