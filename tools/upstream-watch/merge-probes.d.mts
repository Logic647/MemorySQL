/**
 * merge-probes.mjs 的类型声明 —— 让 TS 测试能拿到类型。
 */
export interface ProbePayload {
  checkedAt?: string | null
  ledgerHash?: string | null
  results: Array<{ id: string; verdict: string; [k: string]: unknown }>
}

export interface MergedProbe {
  checkedAt: string | null
  ledgerHash: string | null
  results: Array<{ id: string; verdict: string; src: string; checkedAt: string; [k: string]: unknown }>
}

export declare function mergeProbes(sources: Record<string, ProbePayload>): MergedProbe | null
