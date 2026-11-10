import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { RawSession } from '../../shared/types'
import { createCapturePlugin } from '../_lib/capture-factory.ts'
import { listPiSessionFiles, ompArtifactParent, parseOmpArtifacts, parsePiSessionFile } from '../_lib/pi-jsonl.ts'

/**
 * omp(oh-my-pi,Pi 的 fork)—— ~/.omp/agent/sessions/<cwd>/<time>_<id>.jsonl,
 * 与 Pi 同形状(见 _lib/pi-jsonl.ts);增量差异:
 *   - header 前有固定宽度 title 行(就地重写)→ 解析按 title_change 口径,天然兼容
 *   - 子代理/advisor 会话在与文件同名的 artifacts 目录里 → isSubagent 入库
 * 根:$PI_CONFIG_DIR 可改 ~/.omp;OMP_PROFILE/PI_PROFILE → profiles/<name>/agent;
 * $XDG_DATA_HOME/omp/sessions(非 Windows)也扫。
 */
export function ompAgentDirs(home = os.homedir(), env = process.env): string[] {
  const base = env.PI_CONFIG_DIR?.trim()?.replace(/[/\\]+$/, '') || path.join(home, '.omp')
  const dirs = [path.join(base, 'agent')]
  const profile = env.OMP_PROFILE?.trim() || env.PI_PROFILE?.trim()
  if (profile) dirs.unshift(path.join(base, 'profiles', profile, 'agent'))
  if (process.platform !== 'win32') {
    const xdg = env.XDG_DATA_HOME?.trim() || path.join(home, '.local', 'share')
    dirs.push(path.join(xdg, 'omp', 'sessions'))
  }
  return dirs
}

/** 扫描根集:默认根带上 profile/XDG 伴生根;用户显式指根时只扫那一个 */
export function ompRoots(primary: string): string[] {
  const roots = [primary]
  const defaults = ompAgentDirs()
  if (defaults.includes(primary)) {
    for (const d of defaults) if (!roots.includes(d)) roots.push(d)
  }
  return roots
}

export function collectOmp(root: string): RawSession[] {
  const sessions: RawSession[] = []
  const seen = new Set<string>()
  for (const r of ompRoots(root)) {
    for (const file of listPiSessionFiles([r])) {
      try {
        const s = parsePiSessionFile(file, 'omp')
        if (s && !seen.has(s.externalId)) {
          seen.add(s.externalId)
          sessions.push(s)
        }
        // artifacts 子代理(与文件同名目录);失败不拖垮
        for (const sub of parseOmpArtifacts(file, 'omp')) {
          if (!seen.has(`sub:${sub.externalId}:${sub.parentExternalId ?? ''}`)) {
            seen.add(`sub:${sub.externalId}:${sub.parentExternalId ?? ''}`)
            sessions.push(sub)
          }
        }
      } catch {
        /* 单文件损坏不拖垮整轮 */
      }
    }
  }
  return sessions
}

export default createCapturePlugin({
  id: 'capture-omp',
  name: 'Capture: omp',
  agentType: 'omp',
  defaultRoot: ompAgentDirs()[0],
  collect: (root) => collectOmp(root),
  sourceExists: (root) => ompRoots(root).some((d) => fs.existsSync(path.join(d, 'sessions'))),
  watchPaths: (sourceRoot) => {
    const dirs = ompRoots(sourceRoot)
      .map((d) => path.join(d, 'sessions'))
      .filter((d) => fs.existsSync(d))
    return dirs.length > 0 ? dirs : []
  },
  watch: {
    // 任意 .jsonl 都可能是事件源:artifacts 子代理的文件名(<agent>.jsonl)不带
    // 下划线,用「主会话文件」的正则会漏掉它们;具体归属交给 parseFile 判定。
    match: /\.jsonl$/i,
    parseFile: (file) => {
      try {
        // artifacts 目录里的文件:只可能是子代理,绝不能当顶层会话入库
        const art = ompArtifactParent(file)
        if (art) {
          const s = parsePiSessionFile(file, 'omp')
          return s ? [{ ...s, isSubagent: true, parentExternalId: art.parentId }] : []
        }
        const out = []
        const s = parsePiSessionFile(file, 'omp')
        if (s) out.push(s)
        out.push(...parseOmpArtifacts(file, 'omp'))
        return out
      } catch {
        return []
      }
    }
  }
})
