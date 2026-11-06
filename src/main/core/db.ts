import Database from 'better-sqlite3'

export interface Migration {
  version: number
  up: string
}

export interface AppliedMigrationRow {
  plugin: string
  version: number
  applied_at: number
}

/**
 * SQLite connection + per-plugin migration runner.
 * Each plugin migrates under its own namespace, so plugins never
 * touch each other's tables.
 */
export class Db {
  readonly sqlite: Database.Database

  constructor(dbPath: string) {
    this.sqlite = new Database(dbPath)
    this.sqlite.pragma('journal_mode = WAL')
    this.sqlite.pragma('foreign_keys = ON')
    // 从未 ANALYZE 过的库,查询计划只能靠启发式统计。PRAGMA optimize 很便宜
    // (只在统计缺失/过期时才跑 ANALYZE),放在开会话时做一次即可。
    try {
      this.sqlite.pragma('optimize')
    } catch {
      /* 统计不是正确性前提 —— 失败不阻塞启动 */
    }
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        plugin     TEXT NOT NULL,
        version    INTEGER NOT NULL,
        applied_at INTEGER NOT NULL,
        PRIMARY KEY (plugin, version)
      );
    `)
  }

  /** Apply the plugin's migrations that have not run yet, in order. */
  migrate(pluginId: string, migrations: Migration[]): void {
    const applied = new Set(
      this.sqlite
        .prepare('SELECT version FROM schema_migrations WHERE plugin = ?')
        .all(pluginId)
        .map((r) => (r as { version: number }).version)
    )
    const record = this.sqlite.prepare(
      'INSERT INTO schema_migrations (plugin, version, applied_at) VALUES (?, ?, ?)'
    )
    for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
      if (applied.has(m.version)) continue
      const run = this.sqlite.transaction(() => {
        this.sqlite.exec(m.up)
        record.run(pluginId, m.version, Date.now())
      })
      run()
    }
  }

  close(): void {
    this.sqlite.close()
  }
}
