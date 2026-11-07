import AdmZip from 'adm-zip'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 导入归档的 staging 语义。回归背景(Linux 真机):校验库曾写进 os.tmpdir()
 * (tmpfs,独立设备),再 renameSync 到 dataDir/.import-staging → EXDEV
 * cross-device link not permitted。Windows 上 tmp 与数据目录同盘,永远踩不到。
 * 结构性回归:校验库必须落在 staging(数据目录一侧),os.tmpdir() 不再出现
 * memorysql-import-check-*;校验失败时 staging 整个清掉,不留半个。
 */

vi.mock('electron', () => ({
  app: {
    relaunch: () => {},
    // handler 走到最后会 relaunch + exit;抛错截停测试进程,充当成功信号
    exit: () => {
      throw new Error('exit called')
    },
    getVersion: () => '0.0.0-test'
  },
  dialog: {
    async showOpenDialog() {
      return { canceled: true, filePaths: [] }
    }
  }
}))

const tmps: string[] = []
let dataDir: string
let vaultDir: string
let archiveBuf: AdmZip
let handlers: Record<string, (payload: unknown) => unknown>

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msql-data-'))
  vaultDir = path.join(dataDir, 'vault')
  fs.mkdirSync(vaultDir, { recursive: true })
  tmps.push(dataDir)

  // 造一个最小合法归档:manifest + 含核心表的 memory.db
  const db = new Database(path.join(dataDir, 'seed.db'))
  db.exec(
    'CREATE TABLE sessions (id INTEGER PRIMARY KEY); CREATE TABLE memories (id INTEGER PRIMARY KEY); CREATE TABLE schema_migrations (version INTEGER)'
  )
  db.close()
  archiveBuf = new AdmZip()
  archiveBuf.addFile('manifest.json', Buffer.from(JSON.stringify({ format: 'msqlv', version: 1 })))
  archiveBuf.addLocalFile(path.join(dataDir, 'seed.db'), '', 'memory.db')

  handlers = {}
  const mod = (await import('../src/plugins/sync-archive/index.ts')).default
  mod.init({
    env: {
      dataDir,
      vaultDir,
      dbPath: path.join(dataDir, 'memory.db'),
      settingsPath: path.join(dataDir, 'settings.json')
    },
    db: { sqlite: null as never },
    ipc: { handle: (name: string, h: (p: unknown) => unknown) => (handlers[name] = h) },
    log: { info: () => {}, error: () => {} }
  } as never)
})

afterEach(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { force: true, recursive: true })
})

describe('sync-archive 导入 staging(EXDEV 回归)', () => {
  it('校验库落在 staging 内,os.tmpdir() 不出现 memorysql-import-check-*', async () => {
    const zipPath = path.join(dataDir, 'fixture.msqlv')
    archiveBuf.writeZip(zipPath)
    // handler 走到最后会 app.relaunch() + app.exit(0);mock 的 exit 抛错截停流程,
    // 这个 reject 恰是「staging 成功走完」的信号
    await expect(handlers['import']({ src: zipPath })).rejects.toThrow('exit called')
    const staging = path.join(dataDir, '.import-staging')
    expect(fs.existsSync(path.join(staging, 'memory.db'))).toBe(true)
    // 同设备内 rename:staging 的中间产物已被改名成 memory.db
    const leftovers = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('memorysql-import-check-'))
    expect(leftovers, 'tmp 里不应再有校验库(旧实现跨设备 rename 的源头)').toEqual([])
    // marker 已写,boot 侧换装流程能看到它
    expect(fs.existsSync(path.join(dataDir, '.import-pending.json'))).toBe(true)
  })

  it('坏库(缺核心表)→ 整个 staging 清掉,数据目录不留半个目录', async () => {
    const bad = new AdmZip()
    bad.addFile('manifest.json', Buffer.from(JSON.stringify({ format: 'msqlv', version: 1 })))
    bad.addFile('memory.db', Buffer.from('not a sqlite db'))
    const zipPath = path.join(dataDir, 'bad.msqlv')
    bad.writeZip(zipPath)
    await expect(handlers['import']({ src: zipPath })).rejects.toThrow()
    expect(fs.existsSync(path.join(dataDir, '.import-staging'))).toBe(false)
  })
})
