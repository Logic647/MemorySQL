import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RawSession } from '../../shared/types'
import { createCapturePlugin } from '../_lib/capture-factory.ts'
import { parseDroidSession } from './droid-parser.ts'

/**
 * Droid(Factory,闭源)—— ~/.factory/sessions 下的 JSONL 转录(根级 +
 * 按工作目录分文件夹两代并存)。格式依据 magpie 对真实文件的实证解析,
 * 本机未装,fixture 为按该格式构造的样本;装好后跑一轮探针即可校准。
 * (FACTORY_HOME_OVERRIDE 可覆盖根)
 */
export const DROID_ROOT = process.env.FACTORY_HOME_OVERRIDE?.trim()
  ? path.join(process.env.FACTORY_HOME_OVERRIDE.replace(/[/\\]+$/, ''), '.factory', 'sessions')
  : path.join(os.homedir(), '.factory', 'sessions')

function listTranscripts(root: string): string[] {
  const out: string[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.jsonl')) out.push(path.join(root, e.name))
    else if (e.isDirectory()) {
      // 按工作目录分文件夹的一代;不再向下递(会话只在这一层)
      let inner: fs.Dirent[]
      try {
        inner = fs.readdirSync(path.join(root, e.name), { withFileTypes: true })
      } catch {
        continue
      }
      for (const f of inner) {
        if (f.isFile() && f.name.endsWith('.jsonl')) out.push(path.join(root, e.name, f.name))
      }
    }
  }
  return out
}

export function collectDroid(root: string): RawSession[] {
  const sessions: RawSession[] = []
  const seen = new Set<string>()
  for (const file of listTranscripts(root)) {
    try {
      const s = parseDroidSession(file)
      if (!s || seen.has(s.externalId)) continue
      seen.add(s.externalId)
      sessions.push(s)
    } catch {
      /* 单文件损坏不拖垮整轮 */
    }
  }
  return sessions
}

export default createCapturePlugin({
  id: 'capture-droid',
  name: 'Capture: Droid',
  agentType: 'droid',
  defaultRoot: DROID_ROOT,
  collect: (root) => collectDroid(root),
  watch: {
    match: /\.jsonl$/i,
    parseFile: (file) => {
      if (!file.includes(`${path.sep}.factory${path.sep}sessions`)) return []
      try {
        const s = parseDroidSession(file)
        return s ? [s] : []
      } catch {
        return []
      }
    }
  }
})
