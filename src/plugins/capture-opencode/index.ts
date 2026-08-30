import os from 'node:os'
import { createCapturePlugin } from '../_lib/capture-factory'
import { findOpencodeStorage, parseOpencodeStorage } from './opencode-parser'

export default createCapturePlugin({
  id: 'capture-opencode',
  name: 'Capture: OpenCode / Copilot CLI',
  agentType: 'opencode',
  defaultRoot: os.homedir(),
  sourceExists: (home) => findOpencodeStorage(home, process.env.LOCALAPPDATA) !== null,
  collect: (home) => {
    const storage = findOpencodeStorage(home, process.env.LOCALAPPDATA)
    return storage ? parseOpencodeStorage(storage) : []
  }
})
