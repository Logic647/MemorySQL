import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RawSession } from '../../shared/types'
import { createCapturePlugin } from '../_lib/capture-factory.ts'
import { parseCopilotSessionDir } from './copilot-parser.ts'

/**
 * GitHub Copilot CLI(闭源)—— ~/.copilot/session-state/<uuid>/events.jsonl。
 * 格式与目录 2026-11-10 在 NAS 上真机实测(见 copilot-parser.ts 头注释)。
 * COPILOT_HOME 可覆盖根(官方支持)。
 */
export function copilotRoot(home = os.homedir(), env = process.env): string {
  const override = env.COPILOT_HOME?.trim()
  return override ? override.replace(/[/\\]+$/, '') : path.join(home, '.copilot')
}

export function collectCopilot(root: string): RawSession[] {
  const sessions: RawSession[] = []
  const stateDir = path.join(root, 'session-state')
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(stateDir, { withFileTypes: true })
  } catch {
    return sessions
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue
    try {
      const s = parseCopilotSessionDir(path.join(stateDir, e.name))
      if (s) sessions.push(s)
    } catch {
      /* 单目录损坏不拖垮整轮 */
    }
  }
  return sessions
}

export default createCapturePlugin({
  id: 'capture-copilot',
  name: 'Capture: GitHub Copilot CLI',
  agentType: 'copilot',
  defaultRoot: copilotRoot(),
  collect: (root) => collectCopilot(root),
  sourceExists: (root) => fs.existsSync(path.join(root, 'session-state')),
  watch: {
    match: /(^|[/\\])events\.jsonl$/i,
    parseFile: (file) => {
      try {
        const s = parseCopilotSessionDir(path.dirname(file))
        return s ? [s] : []
      } catch {
        return []
      }
    }
  }
})
