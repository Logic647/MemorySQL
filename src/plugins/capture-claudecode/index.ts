import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RawSession } from '../../shared/types'
import { createCapturePlugin } from '../_lib/capture-factory'
import {
  findClaudeFiles,
  findDesktopMetaFiles,
  parseClaudeJsonl,
  parseDesktopMeta,
  parseHistoryJsonl
} from './claude-parser'

const claudeHome = path.join(os.homedir(), '.claude')

/** Claude Desktop lives under %LOCALAPPDATA% (MSIX data dir "Claude-3p");
 * non-MSIX installs use "AnthropicClaude". */
function collectDesktopMetas(): Array<{ session: RawSession; cliSessionId?: string }> {
  const lad = process.env.LOCALAPPDATA
  if (!lad) return []
  const out: Array<{ session: RawSession; cliSessionId?: string }> = []
  for (const appDir of ['Claude-3p', 'AnthropicClaude']) {
    const root = path.join(lad, appDir, 'claude-code-sessions')
    for (const file of findDesktopMetaFiles(root)) {
      try {
        const meta = parseDesktopMeta(file, fs.readFileSync(file, 'utf-8'))
        if (meta) out.push(meta)
      } catch {
        /* per-file errors are non-fatal */
      }
    }
  }
  return out
}

export default createCapturePlugin({
  id: 'capture-claudecode',
  name: 'Capture: Claude Code',
  agentType: 'claudecode',
  defaultRoot: path.join(claudeHome, 'projects'),
  collect: (root): RawSession[] => {
    const sessions: RawSession[] = []
    // full transcripts win: their session ids suppress the prompt-only
    // history rows and the desktop metadata wrappers for the same conversation
    const transcriptIds = new Set<string>()
    for (const file of findClaudeFiles(root)) {
      try {
        const s = parseClaudeJsonl(file, fs.readFileSync(file, 'utf-8'))
        if (s) {
          sessions.push(s)
          transcriptIds.add(s.externalId)
        }
      } catch {
        /* per-file errors are non-fatal */
      }
    }

    const historyFile = path.join(claudeHome, 'history.jsonl')
    const historyById = new Map<string, RawSession>()
    if (fs.existsSync(historyFile)) {
      for (const s of parseHistoryJsonl(fs.readFileSync(historyFile, 'utf-8'), historyFile, transcriptIds)) {
        historyById.set(s.externalId.slice('history:'.length), s)
      }
    }

    for (const meta of collectDesktopMetas()) {
      const cliId = meta.cliSessionId
      const hist = cliId ? historyById.get(cliId) : undefined
      if (hist) {
        // desktop metadata + its prompts are one conversation: enrich, don't duplicate
        if (!hist.title && meta.session.title) hist.title = meta.session.title
        hist.cwd = hist.cwd ?? meta.session.cwd
        hist.startedAt = hist.startedAt ?? meta.session.startedAt
        hist.endedAt = hist.endedAt ?? meta.session.endedAt
        continue
      }
      if (cliId && transcriptIds.has(cliId)) continue
      sessions.push(meta.session)
    }
    sessions.push(...historyById.values())
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
