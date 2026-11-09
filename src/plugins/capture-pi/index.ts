import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RawSession } from '../../shared/types'
import { createCapturePlugin } from '../_lib/capture-factory.ts'
import { listPiSessionFiles, parsePiSessionFile } from '../_lib/pi-jsonl.ts'

/**
 * Pi(pi coding agent,Mario Zechner,MIT)—— ~/.pi/agent/sessions/<cwd>/
 * <time>_<id>.jsonl。开源,格式按上游行为(magpie 实证解析)还原。
 * ($PI_CODING_AGENT_DIR 可覆盖根;PI_CODING_AGENT_SESSION_DIR/settings.json
 * 的 sessionDir 可把会话指到单一目录 —— collect 同时扫两处。)
 */
export function piAgentDir(home = os.homedir(), env = process.env): string {
  const override = env.PI_CODING_AGENT_DIR?.trim()
  if (override) return override.replace(/[/\\]+$/, '')
  return path.join(home, '.pi', 'agent')
}

/** settings.json 的 sessionDir(JSONC 宽容解析:去掉行注释再 parse) */
export function piCustomSessionDir(agentDir: string): string | null {
  let raw = ''
  try {
    raw = fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf-8')
  } catch {
    return null
  }
  try {
    const jsonc = raw.replace(/^\uFEFF/, '').replace(/(^|[^:"\\])\/\/.*$/gm, '$1')
    const j = JSON.parse(jsonc) as { sessionDir?: unknown }
    if (typeof j.sessionDir === 'string' && j.sessionDir.trim()) {
      const d = j.sessionDir.trim()
      return d.startsWith('~') ? path.join(os.homedir(), d.slice(1)) : d
    }
  } catch {
    return null
  }
  return null
}

export function collectPi(root: string): RawSession[] {
  const sessions: RawSession[] = []
  const seen = new Set<string>()
  const roots = [root]
  const custom = piCustomSessionDir(root)
  if (custom) roots.push(custom)
  for (const file of listPiSessionFiles(roots)) {
    try {
      const s = parsePiSessionFile(file, 'pi')
      if (!s || seen.has(s.externalId)) continue
      seen.add(s.externalId)
      sessions.push(s)
    } catch {
      /* 单文件损坏不拖垮整轮 */
    }
  }
  return sessions
}

export default createCapturePlugin({
  id: 'capture-pi',
  name: 'Capture: Pi',
  agentType: 'pi',
  defaultRoot: piAgentDir(),
  collect: (root) => collectPi(root),
  watch: {
    match: /(^|[/\\])[^/\\]+_[^/\\]+\.jsonl$/i,
    parseFile: (file) => {
      try {
        const s = parsePiSessionFile(file, 'pi')
        return s ? [s] : []
      } catch {
        return []
      }
    }
  }
})
