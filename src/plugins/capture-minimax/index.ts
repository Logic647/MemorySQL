import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RawSession } from '../../shared/types'
import { createCapturePlugin } from '../_lib/capture-factory.ts'
import { parseMinimaxSessionDir } from './minimax-parser.ts'

/**
 * MiniMax Code(MiniMax,闭源,bin mcode)—— ~/.minimax/v2/sessions/
 * <yyyy>/<mm>/<dd>/<ts>-session_<base64(id)>/messages.jsonl。CN 高相关。
 * 本机未装;格式按 magpie 实证解析还原(@minimax-ai/code 0.6.8),
 * npm 装好后跑一轮探针即可校准。($MINIMAX_DATA_DIR 可覆盖根)
 */
export const MINIMAX_ROOT = process.env.MINIMAX_DATA_DIR?.trim()?.replace(/[/\\]+$/, '')
  ? path.join(process.env.MINIMAX_DATA_DIR.replace(/[/\\]+$/, ''), 'v2', 'sessions')
  : path.join(os.homedir(), '.minimax', 'v2', 'sessions')

export function collectMinimax(root: string): RawSession[] {
  const sessions: RawSession[] = []
  // v2/sessions/<y>/<m>/<d>/<dir>/ —— 四层日期壳,直接 walk 到 messages.jsonl 为止
  const walk = (dir: string, depth: number): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const child = path.join(dir, e.name)
      if (depth < 3 && /^\d{2,4}$/.test(e.name)) {
        walk(child, depth + 1)
      } else if (fs.existsSync(path.join(child, 'messages.jsonl'))) {
        try {
          const s = parseMinimaxSessionDir(child)
          if (s) sessions.push(s)
        } catch {
          /* 单目录损坏不拖垮整轮 */
        }
      }
    }
  }
  walk(root, 0)
  return sessions
}

export default createCapturePlugin({
  id: 'capture-minimax',
  name: 'Capture: MiniMax Code',
  agentType: 'minimax',
  defaultRoot: MINIMAX_ROOT,
  collect: (root) => collectMinimax(root),
  watch: {
    match: /(^|[/\\])messages[^/\\]*\.jsonl$/i,
    parseFile: (file) => {
      const dir = path.dirname(file)
      try {
        const s = parseMinimaxSessionDir(dir)
        return s ? [s] : []
      } catch {
        return []
      }
    }
  }
})
