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
  onSessionsChanged: (cb: () => void): (() => void) => window.memorysql.on('push:sessions:changed', cb),
  // privacy-export
  exportSession: (sessionId: number): Promise<{ saved: boolean; filePath?: string; redactions?: number }> =>
    window.memorysql.invoke('privacy-export:exportSession', { sessionId }) as Promise<{
      saved: boolean
      filePath?: string
      redactions?: number
    }>,
  // sync-archive
  exportArchive: (): Promise<{ path: string; bytes: number }> =>
    window.memorysql.invoke('sync-archive:export') as Promise<{ path: string; bytes: number }>,
  importArchive: (): Promise<{ relaunched: boolean; reason?: string }> =>
    window.memorysql.invoke('sync-archive:import') as Promise<{ relaunched: boolean; reason?: string }>,
  // mcp-server
  mcpStatus: (): Promise<{ enabled: boolean; port: number; running: boolean; toolCount: number }> =>
    window.memorysql.invoke('mcp-server:status') as Promise<{
      enabled: boolean
      port: number
      running: boolean
      toolCount: number
    }>,
  // memory-core
  memoriesSave: (input: { id?: number; kind: string; content: string }): Promise<{ id: number }> =>
    window.memorysql.invoke('memory-core:save', input) as Promise<{ id: number }>,
  memoriesDelete: (id: number): Promise<{ ok: boolean }> =>
    window.memorysql.invoke('memory-core:delete', { id }) as Promise<{ ok: boolean }>,
  memoriesSetStatus: (id: number, status: string): Promise<{ ok: boolean }> =>
    window.memorysql.invoke('memory-core:setStatus', { id, status }) as Promise<{ ok: boolean }>,
  // memory-dispatch
  dispatchGenerate: (): Promise<{ files: string[] }> =>
    window.memorysql.invoke('memory-dispatch:generate') as Promise<{ files: string[] }>,
  // summarizer-llm
  llmGetConfig: (): Promise<Record<string, unknown>> =>
    window.memorysql.invoke('summarizer-llm:getConfig') as Promise<Record<string, unknown>>,
  llmSetConfig: (patch: Record<string, unknown>): Promise<{ ok: boolean }> =>
    window.memorysql.invoke('summarizer-llm:setConfig', patch) as Promise<{ ok: boolean }>,
  // sync-folder
  syncStatus: (): Promise<{ deviceId: string; folder: string; lastSyncAt: number }> =>
    window.memorysql.invoke('sync-folder:status') as Promise<{
      deviceId: string
      folder: string
      lastSyncAt: number
    }>,
  syncConfigure: (folder: string): Promise<{ folder: string }> =>
    window.memorysql.invoke('sync-folder:configure', { folder }) as Promise<{ folder: string }>,
  syncNow: (): Promise<{ pushed: string; filesPulled: number; sessionsAdded: number; sessionsUpdated: number; memoriesAdded: number }> =>
    window.memorysql.invoke('sync-folder:syncNow') as Promise<{
      pushed: string
      filesPulled: number
      sessionsAdded: number
      sessionsUpdated: number
      memoriesAdded: number
    }>,
  // core-vault
  notesList: (): Promise<Array<{ id: number; relPath: string; title: string; tags: string[]; updatedAt: number }>> =>
    window.memorysql.invoke('core-vault:notes:list') as Promise<
      Array<{ id: number; relPath: string; title: string; tags: string[]; updatedAt: number }>
    >,
  notesGet: (id: number): Promise<{ note: { id: number; relPath: string; title: string; tags: string[] }; content: string }> =>
    window.memorysql.invoke('core-vault:notes:get', { id }) as Promise<{
      note: { id: number; relPath: string; title: string; tags: string[] }
      content: string
    }>,
  notesSave: (id: number, content: string): Promise<{ ok: boolean }> =>
    window.memorysql.invoke('core-vault:notes:save', { id, content }) as Promise<{ ok: boolean }>,
  notesCreate: (title: string): Promise<{ id: number; relPath: string }> =>
    window.memorysql.invoke('core-vault:notes:create', { title }) as Promise<{ id: number; relPath: string }>,
  notesDelete: (id: number): Promise<{ ok: boolean }> =>
    window.memorysql.invoke('core-vault:notes:delete', { id }) as Promise<{ ok: boolean }>,
  notesBacklinks: (id: number): Promise<Array<{ id: number; title: string }>> =>
    window.memorysql.invoke('core-vault:notes:backlinks', { id }) as Promise<Array<{ id: number; title: string }>>,
  notesGraph: (): Promise<{ nodes: Array<{ id: number; title: string }>; edges: Array<{ from: number; to: number }> }> =>
    window.memorysql.invoke('core-vault:notes:graph') as Promise<{
      nodes: Array<{ id: number; title: string }>
      edges: Array<{ from: number; to: number }>
    }>,
  // capture-watcher
  watcherList: (): Promise<{ roots: string[]; projects: Array<{ id: number; name: string; path: string }> }> =>
    window.memorysql.invoke('capture-watcher:list') as Promise<{
      roots: string[]
      projects: Array<{ id: number; name: string; path: string }>
    }>,
  watcherAddRoot: (root: string): Promise<{ roots: string[] }> =>
    window.memorysql.invoke('capture-watcher:addRoot', { root }) as Promise<{ roots: string[] }>,
  watcherRemoveRoot: (root: string): Promise<{ roots: string[] }> =>
    window.memorysql.invoke('capture-watcher:removeRoot', { root }) as Promise<{ roots: string[] }>
}
