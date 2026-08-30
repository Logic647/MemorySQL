import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RawSession } from '../../shared/types'
import { createCapturePlugin } from '../_lib/capture-factory'
import { findClaudeFiles, parseClaudeJsonl } from './claude-parser'

export default createCapturePlugin({
  id: 'capture-claudecode',
  name: 'Capture: Claude Code',
  agentType: 'claudecode',
  defaultRoot: path.join(os.homedir(), '.claude', 'projects'),
  collect: (root): RawSession[] => {
    const sessions: RawSession[] = []
    for (const file of findClaudeFiles(root)) {
      try {
        const s = parseClaudeJsonl(file, fs.readFileSync(file, 'utf-8'))
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
      const s = parseClaudeJsonl(file, fs.readFileSync(file, 'utf-8'))
      return s ? [s] : []
    }
  }
})
