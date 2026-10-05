/**
 * retry.mjs 的类型声明 —— 让 TS 测试能拿到类型。
 */
export declare const RETRYABLE_STATUS: Set<number>

export declare function shouldRetryUpload(
  status: number | null | undefined
): { retry: boolean; why: string }

export declare function uploadBackoffMs(attempt: number): number
