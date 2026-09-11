import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RawSession } from '../../shared/types'
import { createCapturePlugin } from '../_lib/capture-factory'
import { buildKimiSession, findKimiSessions, readKimiTitle } from './kimicli-parser'

/**
 * Kimi CLI keeps everything under ~/.kimi (relocatable via KIMI_SHARE_DIR);
 * only the sessions/ tree holds conversation transcripts.
 */
const kimiRoot = process.env.KIMI_SHARE_DIR ?? path.join(os.homedir(), '.kimi')

function parseSessionFile(file: string): RawSession | null {
  const text = fs.readFileSync(file, 'utf-8')
  const dir = path.dirname(file)
  const isCurrent = path.basename(file) === 'context.jsonl'
  const ref = isCurrent
    ? { id: path.basename(dir), contextFile: file, stateFile: path.join(dir, 'state.json'), legacy: false }
    : { id: path.basename(file, '.jsonl'), contextFile: file, legacy: true }
  return buildKimiSession(ref, text, readKimiTitle(ref.stateFile))
}

export default createCapturePlugin({
  id: 'capture-kimicli',
  name: 'Capture: Kimi CLI',
  agentType: 'kimicli',
  defaultRoot: path.join(kimiRoot, 'sessions'),
  collect: (root): RawSession[] => {
    const sessions: RawSession[] = []
    for (const ref of findKimiSessions(root)) {
      try {
        const s = buildKimiSession(ref, fs.readFileSync(ref.contextFile, 'utf-8'), readKimiTitle(ref.stateFile))
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
      try {
        const s = parseSessionFile(file)
        return s ? [s] : []
      } catch {
        return []
      }
    }
  }
})
