import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RawSession } from '../../shared/types'
import { createCapturePlugin } from '../_lib/capture-factory'
import { findGeminiFiles, parseGeminiHistory } from './gemini-parser'

const DEFAULT_ROOT = path.join(os.homedir(), '.gemini')

export default createCapturePlugin({
  id: 'capture-gemini',
  name: 'Capture: Gemini CLI',
  agentType: 'gemini',
  defaultRoot: DEFAULT_ROOT,
  collect: (root): RawSession[] => {
    const sessions: RawSession[] = []
    for (const file of findGeminiFiles(root)) {
      try {
        const raw = fs.readFileSync(file, 'utf-8')
        const parsed = JSON.parse(raw) as unknown
        // namespace relative to home so ids stay stable across config changes
        const rel = path.relative(os.homedir(), file)
        const s = parseGeminiHistory(rel, parsed)
        if (s) sessions.push(s)
      } catch {
        /* skip unparseable files */
      }
    }
    return sessions
  },
  watch: {
    match: /\.json$/i,
    parseFile: (file) => {
      try {
        const rel = path.relative(os.homedir(), file)
        const s = parseGeminiHistory(rel, JSON.parse(fs.readFileSync(file, 'utf-8')))
        return s ? [s] : []
      } catch {
        return []
      }
    }
  }
})
