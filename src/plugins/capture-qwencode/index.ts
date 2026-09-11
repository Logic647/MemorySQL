import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RawSession } from '../../shared/types'
import { createCapturePlugin } from '../_lib/capture-factory'
import { parseQwenJsonl } from './qwencode-parser'

/**
 * Only transcripts whose immediate parent directory is `chats` are session
 * files — everything else under ~/.qwen (checkpoints, shell history, debug
 * logs, plans) stays out. This also covers both the current
 * `projects/<proj>/chats/` and the legacy `tmp/<project_id>/chats/` layout.
 */
function findQwenChatFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name === '.lock' || e.name === 'tmp_install') continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile() && e.name.endsWith('.jsonl') && path.basename(dir) === 'chats') {
        out.push(full)
      }
    }
  }
  walk(root)
  return out
}

export default createCapturePlugin({
  id: 'capture-qwencode',
  name: 'Capture: Qwen Code',
  agentType: 'qwencode',
  defaultRoot: path.join(os.homedir(), '.qwen'),
  collect: (root): RawSession[] => {
    const sessions: RawSession[] = []
    for (const file of findQwenChatFiles(root)) {
      try {
        const s = parseQwenJsonl(file, fs.readFileSync(file, 'utf-8'))
        if (s) sessions.push(s)
      } catch {
        /* per-file errors are non-fatal */
      }
    }
    return sessions
  },
  watch: {
    match: /\.jsonl$/i,
    parseFile: (file) => {
      if (path.basename(path.dirname(file)) !== 'chats') return []
      const s = parseQwenJsonl(file, fs.readFileSync(file, 'utf-8'))
      return s ? [s] : []
    }
  }
})
