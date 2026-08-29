import type { MemorySqlApi } from '../../preload/index'
import type {
  CaptureStatus,
  MessageRow,
  SearchHit,
  SessionSummaryRow
} from '../../shared/types'

declare global {
  interface Window {
    memorysql: MemorySqlApi
  }
}

export interface SessionDetail {
  session: {
    id: number
    agent_type: string
    external_id: string
    title: string | null
    summary: string | null
    project: string | null
    cwd: string | null
    started_at: number | null
    ended_at: number | null
    raw_path: string | null
  }
  messages: MessageRow[]
}

export interface Overview {
  byAgent: Array<{ agent_type: string; sessions: number; messages: number }>
  memories: number
}

export const api = {
  listSessions: (agentType: string): Promise<SessionSummaryRow[]> =>
    window.memorysql.invoke('core-schema:sessions:list', { agentType, limit: 200 }) as Promise<
      SessionSummaryRow[]
    >,
  getSession: (id: number): Promise<SessionDetail> =>
    window.memorysql.invoke('core-schema:sessions:get', { id }) as Promise<SessionDetail>,
  search: (q: string): Promise<SearchHit[]> =>
    window.memorysql.invoke('core-schema:search:all', { q, limit: 50 }) as Promise<SearchHit[]>,
  overview: (): Promise<Overview> =>
    window.memorysql.invoke('core-schema:stats:overview') as Promise<Overview>,
  memories: (): Promise<Array<Record<string, unknown>>> =>
    window.memorysql.invoke('core-schema:memories:list') as Promise<
      Array<Record<string, unknown>>
    >,
  captureStatus: (pluginId: string): Promise<CaptureStatus> =>
    window.memorysql.invoke(`${pluginId}:status`) as Promise<CaptureStatus>,
  scanNow: (pluginId: string): Promise<CaptureStatus> =>
    window.memorysql.invoke(`${pluginId}:scanNow`) as Promise<CaptureStatus>,
  onSessionsChanged: (cb: () => void): (() => void) => window.memorysql.on('push:sessions:changed', cb)
}
