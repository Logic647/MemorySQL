/**
 * nas-freshness.mjs 的类型声明 —— 让 TS 测试能拿到类型。
 */
export declare function scanLatestMtime(roots: string[] | null | undefined, home: string): string | null

export interface SponsoredFact {
  version: string | null
  updatedAt: string | null
  dataAt: string | null
  versionError?: string | null
  sessionError?: string | null
}

export declare function applyFreshness(
  results: Array<{ id: string; verdict: string; detail: string; [k: string]: unknown }>,
  sponsored: Record<string, SponsoredFact>
): { results: Array<Record<string, unknown>>; downgraded: string[] }
