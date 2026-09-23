import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RawSession } from '../../shared/types'
import { createCapturePlugin } from '../_lib/capture-factory'
import { findClaudeFiles, parseClaudeJsonl } from '../capture-claudecode/claude-parser'

/**
 * Qoder CLI / Qoder CN (Alibaba) — Claude-compatible JSONL under the user
 * config directory (default ~/.qoder, CN twin ~/.qoder-cn; env
 * QODER_CONFIG_DIR / QODERCN_CONFIG_DIR):
 *   projects/<flattened-path>/<session-id>.jsonl   conversation log
 *   projects/<flattened-path>/<session-id>/state.json  session state (title/cwd)
 * One agent type covers both international and CN installs.
 */
const globalRoot = process.env.QODER_CONFIG_DIR ?? path.join(os.homedir(), '.qoder')
const cnRoot = process.env.QODERCN_CONFIG_DIR ?? path.join(os.homedir(), '.qoder-cn')

/** Accept a config root (~/.qoder) or its projects/ subdir. */
function asConfigRoot(p: string): string {
  return path.basename(p) === 'projects' ? path.dirname(p) : p
}

/** Config roots scanned for a given primary sourceRoot (default layout picks up the CN twin). */
export function qoderRoots(primary: string): string[] {
  const root = asConfigRoot(primary)
  const roots = [root]
  if (root === globalRoot && cnRoot !== root) roots.push(cnRoot)
  return roots
}

function projectsDir(root: string): string {
  return path.join(root, 'projects')
}

/** Only `projects/<slug>/<session>.jsonl` is a transcript — skip AGENTS.md trees etc. */
export function isQoderSessionFile(file: string): boolean {
  if (!file.endsWith('.jsonl')) return false
  return path.basename(path.dirname(path.dirname(file))) === 'projects'
}

/** Sibling state.json may carry a display name / cwd the transcript lacks. */
export function readQoderState(filePath: string): { title?: string; cwd?: string } {
  const stateFile = path.join(path.dirname(filePath), path.basename(filePath, '.jsonl'), 'state.json')
  try {
    const j = JSON.parse(fs.readFileSync(stateFile, 'utf-8')) as Record<string, unknown>
    const title =
      (typeof j.title === 'string' && j.title.trim()) ||
      (typeof j.name === 'string' && j.name.trim()) ||
      (typeof j.custom_title === 'string' && j.custom_title.trim()) ||
      (typeof j.displayName === 'string' && j.displayName.trim()) ||
      undefined
    const cwd = typeof j.cwd === 'string' && j.cwd.trim() ? j.cwd : undefined
    return { title, cwd }
  } catch {
    return {}
  }
}

export function parseQoderSession(file: string): RawSession | null {
  const s = parseClaudeJsonl(file, fs.readFileSync(file, 'utf-8'), 'qoder')
  if (!s) return null
  const state = readQoderState(file)
  if (state.title && !s.title) s.title = state.title
  if (state.cwd && !s.cwd) s.cwd = state.cwd
  return s
}

export default createCapturePlugin({
  id: 'capture-qoder',
  name: 'Capture: Qoder CLI',
  agentType: 'qoder',
  defaultRoot: globalRoot,
  collect: (root): RawSession[] => {
    const sessions: RawSession[] = []
    const seen = new Set<string>()
    for (const cfgRoot of qoderRoots(root)) {
      for (const file of findClaudeFiles(projectsDir(cfgRoot))) {
        if (!isQoderSessionFile(file)) continue
        try {
          const s = parseQoderSession(file)
          if (!s) continue
          // same uuid should not double-ingest if roots ever overlap
          if (seen.has(s.externalId)) continue
          seen.add(s.externalId)
          sessions.push(s)
        } catch {
          /* per-file errors are non-fatal */
        }
      }
    }
    return sessions
  },
  sourceExists: (root) => qoderRoots(root).some((r) => fs.existsSync(projectsDir(r))),
  watchPaths: (sourceRoot) =>
    qoderRoots(sourceRoot)
      .map((r) => projectsDir(r))
      .filter((d) => fs.existsSync(d)),
  watch: {
    match: /\.jsonl$/i,
    parseFile: (file) => {
      if (!isQoderSessionFile(file)) return []
      try {
        const s = parseQoderSession(file)
        return s ? [s] : []
      } catch {
        return []
      }
    }
  }
})
