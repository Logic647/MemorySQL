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
  | 'qwencode'
  | 'kimicli'
  | 'codebuddy'
  | 'workbuddy'
  | 'qoder'
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
  sortKey?: number | null
  projectId?: number | null
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

/**
 * 捕获健康度。关键区分:「agent 没装」与「agent 装了但我们读不懂」——前者无需
 * 动作,后者需要适配发版。历史事故:上游改 schema 后增量解析持续失败,而状态面板
 * 一直显示正常(失败只落在日志里),导致问题长期无人察觉。
 */
export type CaptureHealth =
  | 'unknown' // 尚未扫描过
  | 'healthy' // 有成功记录且无连续失败
  | 'suspect' // 1~2 次连续增量失败 —— 可能偶发(文件写入中/权限)
  | 'failing' // ≥3 次连续失败 —— 极可能是上游格式漂移,需要适配

export interface CaptureStatus {
  pluginId: string
  agentType: AgentType
  sourceRoot: string
  /** 源目录是否存在(仅表示「装没装」,不代表「读不读得懂」) */
  available: boolean
  sessionsFound: number
  sessionsImported: number
  lastScanAt: number | null
  /** 最近一次「手动/启动扫描」的错误;增量 watcher 的失败见 health 相关字段 */
  lastError: string | null
  health: CaptureHealth
  /** 连续增量捕获失败次数;任意一次成功即归零 */
  consecutiveFailures: number
  lastFailureAt: number | null
  /** 最近一次增量失败的原始信息(截断),便于用户/维护者定位 */
  lastFailureDetail: string | null
  /** 最近一次成功捕获(扫描或增量)时间 */
  lastSuccessAt: number | null
}

/** Data flowing through IPC. Channels are `<pluginId>:<name>`. */
export interface IpcRequest {
  channel: string
  payload?: unknown
}
