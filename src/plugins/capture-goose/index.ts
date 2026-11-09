import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RawSession } from '../../shared/types'
import { createCapturePlugin } from '../_lib/capture-factory.ts'
import { gooseDataRoots, parseGooseSessions } from './goose-db.ts'

/**
 * Goose(Block 的 AI agent,CLI 与桌面 app 共用配置)。
 * 会话库 = <数据根>/sessions/sessions.db(SQLite,WAL),路径与表结构
 * 2026-11 按上游源码核对(见 goose-db.ts 头注释)。
 * 数据根:Win %APPDATA%\Block\goose / mac ~/Library/Application Support/Block/goose
 * / Linux ~/.local/share/goose;GOOSE_PATH_ROOT 覆盖时 <root>/data。
 */
function defaultRoot(): string {
  return gooseDataRoots(os.homedir(), process.env.APPDATA).find((r) => fs.existsSync(r)) ?? gooseDataRoots(os.homedir(), process.env.APPDATA)[0]
}

/** sourceRoot 可能指向数据根(…/goose)或其 sessions/ 子目录 */
export function sessionsDirOf(root: string): string {
  return path.basename(root) === 'sessions' ? root : path.join(root, 'sessions')
}

export function collectGoose(root: string, since?: number): RawSession[] {
  const dbPath = path.join(sessionsDirOf(root), 'sessions.db')
  if (!fs.existsSync(dbPath)) return []
  return parseGooseSessions(dbPath, since)
}

export default createCapturePlugin({
  id: 'capture-goose',
  name: 'Capture: Goose',
  agentType: 'goose',
  defaultRoot: defaultRoot(),
  collect: (root) => collectGoose(root),
  collectSince: (root, sinceMs) => {
    const sessions = collectGoose(root, sinceMs)
    let maxEnded = 0
    for (const s of sessions) if ((s.endedAt ?? 0) > maxEnded) maxEnded = s.endedAt ?? 0
    return { sessions, watermark: maxEnded > 0 ? maxEnded * 1000 : null }
  },
  sourceExists: (root) => fs.existsSync(path.join(sessionsDirOf(root), 'sessions.db')),
  watch: {
    // SQLite store — any change (db/wal/shm) triggers a watermark rescan
    match: /sessions\.db(-wal|-shm)?$/i,
    rescan: true
  }
})
