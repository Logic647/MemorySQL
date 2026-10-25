/**
 * nas-panel.mjs 的类型声明 —— 让 TS 测试能拿到类型。
 */
export interface LoginTarget {
  id: string
  label: string
  loginCmd: string[]
  sshFallback: string
}

export declare function parseEnvFile(text: string): Record<string, string>
export declare function findLoginTarget(id: string): LoginTarget | null
export declare function loadPanelState(): {
  lastRun: {
    at: string
    upload?: { at: string; ok: boolean | null; error: string | null }
    agents: Record<
      string,
      {
        version: string | null
        verdict: string | null
        sessionOk: boolean | null
        sessionAt: string | null
        sessionError: string | null
        dataAt: string | null
      }
    >
  } | null
  reports: string[]
  endpoint: string
}
