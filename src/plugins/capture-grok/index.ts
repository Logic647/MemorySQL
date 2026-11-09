import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RawSession } from '../../shared/types'
import { createCapturePlugin } from '../_lib/capture-factory.ts'
import { parseGrokSessionDir } from './grok-parser.ts'

/**
 * Grok Build(xAI,闭源)—— ~/.grok/sessions/<urlencode(cwd)>/<id>/,
 * summary.json + updates.jsonl(见 grok-parser.ts)。本机未装;格式按
 * magpie 实证解析还原,装好后跑一轮探针即可校准。(GROK_HOME 可覆盖根)
 */
export const GROK_ROOT = process.env.GROK_HOME?.trim()?.replace(/[/\\]+$/, '')
  ? path.join(process.env.GROK_HOME.replace(/[/\\]+$/, ''), 'sessions')
  : path.join(os.homedir(), '.grok', 'sessions')

export function collectGrok(root: string): RawSession[] {
  const sessions: RawSession[] = []
  let cwds: fs.Dirent[]
  try {
    cwds = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return sessions
  }
  for (const cwd of cwds) {
    if (!cwd.isDirectory()) continue
    let ids: fs.Dirent[]
    try {
      ids = fs.readdirSync(path.join(root, cwd.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const id of ids) {
      if (!id.isDirectory()) continue
      try {
        const s = parseGrokSessionDir(path.join(root, cwd.name, id.name))
        if (s) sessions.push(s)
      } catch {
        /* 单目录损坏不拖垮整轮 */
      }
    }
  }
  return sessions
}

export default createCapturePlugin({
  id: 'capture-grok',
  name: 'Capture: Grok Build',
  agentType: 'grok',
  defaultRoot: GROK_ROOT,
  collect: (root) => collectGrok(root),
  watch: {
    match: /(^|[/\\])(updates\.jsonl|summary\.json)$/i,
    parseFile: (file) => {
      const dir = path.dirname(file)
      try {
        const s = parseGrokSessionDir(dir)
        return s ? [s] : []
      } catch {
        return []
      }
    }
  }
})
