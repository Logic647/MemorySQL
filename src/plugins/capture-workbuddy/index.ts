import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RawSession } from '../../shared/types'
import { createCapturePlugin } from '../_lib/capture-factory'
import { collectWorkbuddy, findWorkbuddyDb, parseWorkbuddyJsonl } from './workbuddy-parser'

const WORKBUDDY_DB_WATCH = /workbuddy\.db(-wal|-shm)?$/i

function workbuddyRoot(): string {
  return path.join(os.homedir(), '.workbuddy')
}

function collect(root: string): RawSession[] {
  return collectWorkbuddy(root)
}

export default createCapturePlugin({
  id: 'capture-workbuddy',
  name: 'Capture: WorkBuddy',
  agentType: 'workbuddy',
  defaultRoot: workbuddyRoot(),
  sourceExists: (root) =>
    findWorkbuddyDb(root) !== null || fs.existsSync(path.join(root, 'projects')),
  collect,
  // function form: db/projects may appear after the plugin loads
  watchPaths: () => {
    const root = workbuddyRoot()
    const dirs: string[] = []
    const db = findWorkbuddyDb(root)
    if (db) dirs.push(path.dirname(db))
    const projects = path.join(root, 'projects')
    if (fs.existsSync(projects)) dirs.push(root)
    return dirs
  },
  watch: {
    match: /(\.jsonl$)|(workbuddy\.db(-wal|-shm)?$)/i,
    parseFile: (file) => {
      if (WORKBUDDY_DB_WATCH.test(file)) return collect(path.dirname(file))
      const s = parseWorkbuddyJsonl(file, fs.readFileSync(file, 'utf-8'))
      return s ? [s] : []
    }
  }
})
