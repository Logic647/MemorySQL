/**
 * llm.mjs 的最小类型声明 —— 让 TS 测试能拿到类型(否则 TS7016 隐式 any)。
 * 只声明测试与调用方实际用到的形状,不做过度约束。
 */

export interface LlmOk {
  ok: true
  data: any
}

export interface LlmErr {
  ok: false
  error: string
}

export type LlmResult = LlmOk | LlmErr

export interface ExtractOk {
  ok: true
  data: any
}

export interface ExtractErr {
  ok: false
  error: string
}

export function llmConfigured(): boolean

/**
 * 从若干候选文本里抠出第一个可解析的 JSON。
 * 刻意不用贪婪正则 `/\{[\s\S]*\}/` —— 实测会在出现两段 JSON 时产出垃圾。
 */
export function extractJson(candidates: Array<string | null | undefined>): ExtractOk | ExtractErr

export function callLlmJson(
  prompt: string,
  opts?: { maxTokens?: number; timeoutMs?: number }
): Promise<LlmResult>
