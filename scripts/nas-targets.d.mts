/**
 * nas-targets.mjs 的类型声明 —— 让 TS 测试能拿到类型。
 */
export interface NasAgent {
  id: string
  label: string
  updateCmd: string[]
  versionCmd: string[]
  sessionCmd: string[]
  /** null = 该 CLI 没有非交互登录子命令(只能在 TUI 里认证,如 droid) */
  loginCmd: string[] | null
  sshFallback: string
}

export declare const NAS_AGENTS: NasAgent[]

export declare const LOGIN_TARGETS: Array<{
  id: string
  label: string
  loginCmd: string[] | null
  sshFallback: string
}>

export declare const NAS_BIN_PATH: string
