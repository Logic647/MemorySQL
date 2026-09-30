/**
 * fetch.mjs 的最小类型声明 —— 让 TS 测试能拿到类型(否则 TS7016 隐式 any)。
 * 只声明测试与调用方实际用到的形状,不做过度约束。
 *
 * `rateLimited` 是这次新加的字段,刻意做成显式布尔而不是从 error 文案里推断:
 * 403/429 有四种成因(主限流 / 二级滥用 / 授权不足 / IP 级封禁),只有前两种
 * 值得重试,后两种重试多少次都没用。调用方靠这个字段决定要不要退避。
 */

export interface HttpOk<T = unknown> {
  ok: true
  data: T
  status: number
}

export interface HttpErr {
  ok: false
  error: string
  status: number
  /** 仅在「主限流 / 二级限流」时为 true;授权不足、IP 封禁均为 false */
  rateLimited?: boolean
}

export type HttpResult<T = unknown> = HttpOk<T> | HttpErr

export interface UpstreamInfo {
  kind: 'github' | 'commit' | 'npm' | 'none'
  version: string | null
  publishedAt: string | null
  url?: string | null
  notes: string
  error?: string | null
  fallbackUsed?: boolean
  fallbackReason?: string | null
}

export function httpJson<T = unknown>(
  url: string,
  opts?: { headers?: Record<string, string> }
): Promise<HttpResult<T>>

export function fetchUpstream(agent: {
  upstream?: { kind?: string; repo?: string; pkg?: string }
}): Promise<UpstreamInfo>
