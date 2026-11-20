import fs from 'node:fs'
import type Database from 'better-sqlite3'

/**
 * 知识库规模统计 —— `/health`(外部探活/插件状态页)和 `memory_stats`
 * (agent 自检)共用一份口径,避免两处 SQL 漂移。
 *
 * 只做 count(*),不扫消息内容;messages 在真库可达百万行,count 仍是
 * SQLite 的 B-tree 遍历,毫秒级。`dbBytes` 取主库文件大小(WAL 另计)。
 */
export interface DbStats {
  sessions: number
  subagentSessions: number
  messages: number
  projects: number
  memories: number
  activeMemories: number
  /** 最近一次对话时间,unix 秒;没有会话时为 null */
  lastSessionAt: number | null
  dbBytes: number | null
}

function count(sqlite: Database.Database, sql: string): number {
  const row = sqlite.prepare(sql).get() as { n: number } | undefined
  return Number(row?.n ?? 0)
}

export function collectDbStats(sqlite: Database.Database, dbPath?: string): DbStats {
  let dbBytes: number | null = null
  if (dbPath) {
    try {
      dbBytes = fs.statSync(dbPath).size
    } catch {
      /* 库还没落盘或路径不可读 —— 不是错误 */
    }
  }
  const last = sqlite
    .prepare(
      `SELECT MAX(COALESCE(last_message_at, started_at, ended_at)) AS ts
         FROM sessions WHERE deleted = 0 AND is_subagent = 0`
    )
    .get() as { ts: number | null } | undefined
  return {
    sessions: count(sqlite, 'SELECT count(*) AS n FROM sessions WHERE deleted = 0 AND is_subagent = 0'),
    subagentSessions: count(
      sqlite,
      'SELECT count(*) AS n FROM sessions WHERE deleted = 0 AND is_subagent = 1'
    ),
    messages: count(sqlite, 'SELECT count(*) AS n FROM session_messages'),
    projects: count(sqlite, 'SELECT count(*) AS n FROM projects WHERE deleted = 0'),
    memories: count(sqlite, 'SELECT count(*) AS n FROM memories WHERE deleted = 0'),
    activeMemories: count(
      sqlite,
      `SELECT count(*) AS n FROM memories WHERE deleted = 0 AND status = 'active'`
    ),
    lastSessionAt: last?.ts ?? null,
    dbBytes
  }
}
