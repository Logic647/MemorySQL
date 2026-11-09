import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RawSession } from '../../shared/types'
import { createCapturePlugin } from '../_lib/capture-factory.ts'
import { clineSessionsDir, parseClineSessionDir } from './cline-parser.ts'

/**
 * Cline CLI(开源)—— ~/.cline/data/sessions/<id>/ 一个目录一个会话,
 * manifest + messages.json + 子代理 messages 文件(见 cline-parser.ts)。
 * 本机未装;格式按 magpie 实证解析还原,装好后跑一轮即可校准。
 */
export const CLINE_SESSIONS = clineSessionsDir(process.env, os.homedir())

export function collectCline(root: string): RawSession[] {
  const sessions: RawSession[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return sessions
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    try {
      sessions.push(...parseClineSessionDir(path.join(root, e.name)))
    } catch {
      /* 单目录损坏不拖垮整轮 */
    }
  }
  return sessions
}

export default createCapturePlugin({
  id: 'capture-cline',
  name: 'Capture: Cline CLI',
  agentType: 'cline',
  defaultRoot: CLINE_SESSIONS,
  collect: (root) => collectCline(root),
  watch: {
    match: /messages\.json$/i,
    parseFile: (file) => {
      // <sessions>/<id>/<file>.messages.json → 重解析整个会话目录(子代理文件也在里面)
      const dir = path.dirname(file)
      try {
        return parseClineSessionDir(dir)
      } catch {
        return []
      }
    }
  }
})
