import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCapturePlugin } from '../_lib/capture-factory.ts'
import { parseAgentSqliteSessions } from '../_lib/agent-db-parser.ts'
import { userDataDir } from '../../main/core/safe-path.ts'

/**
 * DevEco Code(华为,HarmonyOS 开发的 AI agent,**基于 opencode 通过 npm 分发**,
 * 多个公开镜像一致描述)—— 沿用 opencode 数据布局:
 *   配置 ~/.config/deveco(DEVECO_CONFIG_DIR 可移),数据 ~/.local/share/deveco
 *   (Windows %LOCALAPPDATA%\deveco),会话库 opencode 三表/session_v2 形状。
 * 证据级 family(opencode 系),库文件名未黑盒确认 —— 数据根下逐 *.db 探测
 * 布局,对不上返回 [](解析器本就"未知 schema 返回 []",不会误报)。
 */
export function devecoRoots(): string[] {
  return [
    path.join(os.homedir(), '.local', 'share', 'deveco'),
    path.join(userDataDir('local'), 'deveco')
  ]
}

/** 直接在给定目录里找库文件(用户自定义数据路径时优先用它) */
function dbInDir(dir: string, hint: string): string | null {
  let files: string[] = []
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.db') && !f.endsWith('-wal') && !f.endsWith('-shm'))
  } catch {
    return null
  }
  const db = files.find((f) => f.toLowerCase().includes(hint)) ?? files[0]
  return db ? path.join(dir, db) : null
}

export function findDevecoDb(): string | null {
  for (const root of devecoRoots()) {
    const db = dbInDir(root, 'deveco')
    if (db) return db
  }
  return null
}

export function collectDeveco(root?: string, since?: number) {
  const db = (root ? dbInDir(root, 'deveco') : null) ?? findDevecoDb()
  if (!db) return []
  return parseAgentSqliteSessions(db, 'deveco', undefined, since && since > 0 ? { since } : undefined)
}

export default createCapturePlugin({
  id: 'capture-deveco',
  name: 'Capture: DevEco Code',
  agentType: 'deveco',
  defaultRoot: devecoRoots()[0],
  collect: (root) => collectDeveco(root),
  collectSince: (root, sinceMs) => {
    const sessions = collectDeveco(root, sinceMs)
    let maxEnded = 0
    for (const s of sessions) if ((s.endedAt ?? 0) > maxEnded) maxEnded = s.endedAt ?? 0
    return { sessions, watermark: maxEnded > 0 ? maxEnded * 1000 : null }
  },
  sourceExists: (root) => dbInDir(root, 'deveco') !== null || findDevecoDb() !== null,
  watch: {
    match: /\.db(-wal)?$/i,
    rescan: true
  }
})
