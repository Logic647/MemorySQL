import os from 'node:os'
import path from 'node:path'
import type { RawSession } from '../../shared/types'
import { createCapturePlugin } from '../_lib/capture-factory'
import { collectDsh, decodeDshFile, parseDshSession } from './dsh-parser'

/**
 * DeepSeek Harness(dsh)—— 官方 agent 框架。会话根 = ~/.dsh/sessions
 * (DSH_HOME 可覆盖),每会话一个 `session.vN.jsonl[.zstd]` 日志。
 * 详见 dsh-parser.ts 头部注释(格式逐条对上游源码核实)。
 */
const dshHome = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
const DEFAULT_ROOT = path.join(dshHome, 'sessions')

export default createCapturePlugin({
  id: 'capture-dsh',
  name: 'Capture: DeepSeek Harness',
  agentType: 'dsh',
  defaultRoot: DEFAULT_ROOT,
  collect: (root): RawSession[] => collectDsh(root),
  watch: {
    match: /session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/i,
    parseFile: (file) => {
      const text = decodeDshFile(file)
      if (text === null) return []
      try {
        const s = parseDshSession(file, text)
        return s ? [s] : []
      } catch {
        return []
      }
    }
  }
})
