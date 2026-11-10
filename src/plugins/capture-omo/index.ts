import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { RawSession } from '../../shared/types'
import { createCapturePlugin } from '../_lib/capture-factory.ts'
import { listPiSessionFiles, parsePiSessionFile } from '../_lib/pi-jsonl.ts'

/**
 * OmO(oh-my-openagent)Native —— 引擎 senpi(pi 系 fork),状态在
 * ~/.omo/agent/(OMO_CODING_AGENT_DIR 可覆盖;fallback ~/.senpi/agent)。
 * 会话文件按 pi 系惯例在 agent/sessions/ 下,格式按 pi 形状解析
 * (family 证据,装好后黑盒复核);MCP ~/.omo/agent/mcp.json(上游 setup 文档)。
 */
export function omoAgentDirs(home = os.homedir(), env = process.env): string[] {
  const override = env.OMO_CODING_AGENT_DIR?.trim() || env.SENPI_CODING_AGENT_DIR?.trim()
  if (override) return [override.replace(/[/\\]+$/, '')]
  const dirs = [path.join(home, '.omo', 'agent'), path.join(home, '.senpi', 'agent')]
  return dirs
}

/** 扫描根集:用户显式指定的根只扫它自己;默认根时连带 senpi fallback */
export function omoRoots(primary: string): string[] {
  const defaults = omoAgentDirs()
  if (primary && !defaults.includes(primary)) return [primary]
  return defaults
}

export function collectOmo(root: string): RawSession[] {
  const sessions: RawSession[] = []
  const seen = new Set<string>()
  for (const r of omoRoots(root)) {
    for (const file of listPiSessionFiles([r])) {
      try {
        const s = parsePiSessionFile(file, 'omo')
        if (s && !seen.has(s.externalId)) {
          seen.add(s.externalId)
          sessions.push(s)
        }
      } catch {
        /* 单文件损坏不拖垮整轮 */
      }
    }
  }
  return sessions
}

export default createCapturePlugin({
  id: 'capture-omo',
  name: 'Capture: OmO',
  agentType: 'omo',
  defaultRoot: omoAgentDirs()[0],
  collect: (root) => collectOmo(root),
  sourceExists: (root) => omoRoots(root).some((d) => fs.existsSync(path.join(d, 'sessions'))),
  watchPaths: (root) => {
    const dirs = omoRoots(root)
      .map((d) => path.join(d, 'sessions'))
      .filter((d) => fs.existsSync(d))
    return dirs.length > 0 ? dirs : []
  },
  watch: {
    match: /(^|[/\\])[^/\\]+_[^/\\]+\.jsonl$/i,
    parseFile: (file) => {
      try {
        const s = parsePiSessionFile(file, 'omo')
        return s ? [s] : []
      } catch {
        return []
      }
    }
  }
})
