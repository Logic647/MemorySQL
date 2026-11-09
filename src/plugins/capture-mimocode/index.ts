import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCapturePlugin } from '../_lib/capture-factory.ts'
import { parseAgentSqliteSessions } from '../_lib/agent-db-parser.ts'
import { userDataDir } from '../../main/core/safe-path.ts'

/**
 * MiMo Code(小米,闭源,magpie 接线记录为「OpenCode 形状」:配置
 * $XDG_CONFIG_HOME/mimocode、auth ~/.local/share/mimocode/auth.json)——
 * 数据布局按 opencode 系对待:会话库在 ~/.local/share/mimocode(Windows
 * %LOCALAPPDATA%\mimocode),session/session_v2 形状,agent-db-parser 的
 * 布局探测直接适用;库文件名未黑盒确认,数据根下逐 *.db 探测,对不上
 * 返回 [](不会误报)。证据级 family,装好后跑一轮探针即可校准。
 */
export function mimocodeRoots(): string[] {
  return [
    path.join(os.homedir(), '.local', 'share', 'mimocode'),
    path.join(userDataDir('local'), 'mimocode')
  ]
}

export function findMimocodeDb(): string | null {
  for (const root of mimocodeRoots()) {
    let files: string[] = []
    try {
      files = fs.readdirSync(root).filter((f) => f.endsWith('.db') && !f.endsWith('-wal') && !f.endsWith('-shm'))
    } catch {
      continue
    }
    const db = files.find((f) => f.toLowerCase().includes('mimo')) ?? files[0]
    if (db) return path.join(root, db)
  }
  return null
}

export function collectMimocode(since?: number) {
  const db = findMimocodeDb()
  if (!db) return []
  return parseAgentSqliteSessions(db, 'mimocode', undefined, since && since > 0 ? { since } : undefined)
}

export default createCapturePlugin({
  id: 'capture-mimocode',
  name: 'Capture: MiMo Code',
  agentType: 'mimocode',
  defaultRoot: mimocodeRoots()[0],
  collect: () => collectMimocode(),
  collectSince: (_root, sinceMs) => {
    const sessions = collectMimocode(sinceMs)
    let maxEnded = 0
    for (const s of sessions) if ((s.endedAt ?? 0) > maxEnded) maxEnded = s.endedAt ?? 0
    return { sessions, watermark: maxEnded > 0 ? maxEnded * 1000 : null }
  },
  sourceExists: () => findMimocodeDb() !== null,
  watch: {
    match: /\.db(-wal)?$/i,
    rescan: true
  }
})
