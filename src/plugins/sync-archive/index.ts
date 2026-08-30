import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app, dialog } from 'electron'
import Database from 'better-sqlite3'
import AdmZip from 'adm-zip'
import type { MemorySQLPlugin } from '../../main/core/plugin-host'

/**
 * Knowledge-base portability. The data dir (db + vault) is self-contained:
 * export = clean VACUUM INTO snapshot + vault zipped into one .msqlv file;
 * import = validate, stage, then swap files on next app start (no live-db
 * surgery), then relaunch.
 */
const MARKER = '.import-pending.json'

const plugin: MemorySQLPlugin = {
  manifest: {
    id: 'sync-archive',
    name: 'Sync: Archive (.msqlv)',
    version: '0.1.0'
  },

  init(ctx) {
    ctx.ipc.handle('export', (payload) => {
      const { dest } = (payload ?? {}) as { dest?: string }
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
      const target = dest ?? path.join(ctx.env.dataDir, 'backups', `MemorySQL-${stamp}.msqlv`)
      fs.mkdirSync(path.dirname(target), { recursive: true })

      // clean snapshot of the live db (WAL-consistent, no file juggling)
      const snapshot = path.join(os.tmpdir(), `memorysql-export-${Date.now()}.db`)
      ctx.db.sqlite.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`)

      try {
        const zip = new AdmZip()
        zip.addFile(
          'manifest.json',
          JSON.stringify(
            { format: 'msqlv', version: 1, app: 'memorysql', exportedAt: new Date().toISOString(), includesSettings: true },
            null,
            2
          )
        )
        zip.addLocalFile(snapshot, '', 'memory.db')
        if (fs.existsSync(ctx.env.settingsPath)) zip.addLocalFile(ctx.env.settingsPath, '', 'settings.json')
        if (fs.existsSync(ctx.env.vaultDir)) zip.addLocalFolder(ctx.env.vaultDir, 'vault')
        zip.writeZip(target)
      } finally {
        fs.rmSync(snapshot, { force: true })
      }
      const bytes = fs.statSync(target).size
      ctx.log.info(`archive exported -> ${target} (${(bytes / 1024 / 1024).toFixed(1)} MB)`)
      return { path: target, bytes }
    })

    ctx.ipc.handle('import', async (payload) => {
      const { src } = (payload ?? {}) as { src?: string }
      let archivePath = src
      if (!archivePath) {
        const { canceled, filePaths } = await dialog.showOpenDialog({
          title: '导入知识库归档(.msqlv)',
          filters: [{ name: 'MemorySQL 归档', extensions: ['msqlv', 'zip'] }],
          properties: ['openFile']
        })
        if (canceled || filePaths.length === 0) return { relaunched: false, reason: 'canceled' }
        archivePath = filePaths[0]
      }

      const zip = new AdmZip(archivePath)
      const manifestEntry = zip.getEntry('manifest.json')
      const dbEntry = zip.getEntry('memory.db')
      if (!dbEntry) throw new Error('归档缺少 memory.db')
      if (!manifestEntry) throw new Error('归档缺少 manifest.json(不是 MemorySQL 导出的包)')
      {
        const manifest = JSON.parse(manifestEntry.getData().toString('utf-8')) as { format?: string }
        if (manifest.format !== 'msqlv') throw new Error('manifest.format 不是 msqlv')
      }

      // validate before touching anything live
      const tmpDb = path.join(os.tmpdir(), `memorysql-import-check-${Date.now()}.db`)
      fs.writeFileSync(tmpDb, dbEntry.getData())
      const check = new Database(tmpDb, { readonly: true, fileMustExist: true })
      try {
        const n = (
          check
            .prepare(
              "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('sessions','memories','schema_migrations')"
            )
            .get() as { n: number }
        ).n
        if (n < 3) throw new Error('不是 MemorySQL 数据库(缺核心表)')
      } finally {
        check.close()
      }

      // stage next to the data dir; the boot path swaps files after relaunch
      const staging = path.join(ctx.env.dataDir, '.import-staging')
      fs.rmSync(staging, { recursive: true, force: true })
      fs.mkdirSync(staging, { recursive: true })
      fs.renameSync(tmpDb, path.join(staging, 'memory.db'))
      const settingsEntry = zip.getEntry('settings.json')
      if (settingsEntry) fs.writeFileSync(path.join(staging, 'settings.json'), settingsEntry.getData())
      for (const entry of zip.getEntries()) {
        if (entry.entryName.startsWith('vault/') && !entry.isDirectory) {
          zip.extractEntryTo(entry, staging, true, true)
        }
      }
      fs.writeFileSync(
        path.join(ctx.env.dataDir, MARKER),
        JSON.stringify({ stagingDir: staging, from: archivePath }),
        'utf-8'
      )

      ctx.log.info(`import staged from ${archivePath} — relaunching`)
      app.relaunch()
      app.exit(0)
      return { relaunched: true }
    })
  }
}

export default plugin
