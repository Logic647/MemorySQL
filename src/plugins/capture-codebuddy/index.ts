import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RawSession } from '../../shared/types'
import { createCapturePlugin } from '../_lib/capture-factory'
import { findClaudeFiles, parseClaudeJsonl } from '../capture-claudecode/claude-parser'

/**
 * Tencent CodeBuddy Code writes Claude Code-compatible JSONL transcripts
 * under `~/.codebuddy/projects/` (relocatable via CODEBUDDY_CONFIG_DIR).
 * Same record shape as ~/.claude/projects, different home.
 */
const codebuddyHome =
  process.env.CODEBUDDY_CONFIG_DIR ?? path.join(os.homedir(), '.codebuddy')

export default createCapturePlugin({
  id: 'capture-codebuddy',
  name: 'Capture: CodeBuddy Code',
  agentType: 'codebuddy',
  defaultRoot: path.join(codebuddyHome, 'projects'),
  collect: (root): RawSession[] => {
    const sessions: RawSession[] = []
    for (const file of findClaudeFiles(root)) {
      try {
        const s = parseClaudeJsonl(file, fs.readFileSync(file, 'utf-8'), 'codebuddy')
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
      const s = parseClaudeJsonl(file, fs.readFileSync(file, 'utf-8'), 'codebuddy')
      return s ? [s] : []
    }
  }
})
