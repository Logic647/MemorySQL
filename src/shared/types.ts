// Shared types between main, plugins, and renderer.

// Known agents get literal typing; `(string & {})` keeps autocomplete while
// allowing user-registered custom agents (capture-watcher 登记式).
export type AgentType =
  | 'codex'
  | 'zcode'
  | 'hermes'
  | 'claudecode'
  | 'gemini'
  | 'cursor'
  | 'opencode'
  | (string & {})
export type MessageRole = 'user' | 'assistant' | 'tool' | 'system'

/** Normalized message produced by capture adapters. */
export interface RawMessage {
  role: MessageRole
  content: string
  ts?: number // unix epoch seconds
  /** tool name for role === 'tool' / tool call records */
  toolName?: string
  meta?: Record<string, unknown>
}

/** Normalized session produced by capture adapters — the ingest contract. */
export interface RawSession {
  /** agent-native stable id (deduped per agentType) */
  externalId: string
  agentType: AgentType
  cwd?: string
  startedAt?: number
  endedAt?: number
  title?: string
  messages: RawMessage[]
  /** source file/db reference for traceability */
  rawPath?: string
}

export interface SessionSummaryRow {
  id: number
  agentType: AgentType
  externalId: string
  title: string | null
  summary: string | null
  project: string | null
  startedAt: number | null
  endedAt: number | null
  messageCount: number
  toolCallCount: number
  titleLocked?: number
  archived?: number
  similarTo?: number | null
}

export interface MessageRow {
  id: number
  seq: number
  role: MessageRole
  content: string
  ts: number | null
  toolName: string | null
}

export interface SearchHit {
  kind: 'session' | 'message' | 'memory' | 'note'
  id: number
  sessionId?: number
  agentType?: AgentType
  title?: string | null
  snippet: string
  rank: number
}

export interface CaptureStatus {
  pluginId: string
  agentType: AgentType
  sourceRoot: string
  available: boolean
  sessionsFound: number
  sessionsImported: number
  lastScanAt: number | null
  lastError: string | null
}

/** Data flowing through IPC. Channels are `<pluginId>:<name>`. */
export interface IpcRequest {
  channel: string
  payload?: unknown
}
