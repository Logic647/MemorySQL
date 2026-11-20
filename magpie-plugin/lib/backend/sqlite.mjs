// SQLite 驱动适配：magpie 宿主是 Bun（bun:sqlite），单测跑在 Node 24
// （node:sqlite）。两边 API 接近，这里抹平差异，并补一个同步事务助手。
//
// 不引第三方原生模块：bun:sqlite / node:sqlite 都是内置的，插件装到哪都能跑。
async function loadDriver() {
  if (typeof Bun !== 'undefined') {
    const mod = await import('bun:sqlite')
    return mod.Database
  }
  const mod = await import('node:sqlite')
  return mod.DatabaseSync
}

/**
 * @param {string} file 数据库路径，或 ':memory:'
 */
export async function openDatabase(file) {
  const Database = await loadDriver()
  const db = new Database(file)
  db.exec('PRAGMA foreign_keys = ON')
  // magpie 的 app / CLI 宿主可能同时开着同一个库；写锁等 5 秒再报错
  try {
    db.exec('PRAGMA busy_timeout = 5000')
  } catch {
    /* 极老 SQLite 没有这个 pragma */
  }
  if (file !== ':memory:') {
    try {
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA synchronous = NORMAL')
    } catch {
      /* 某些文件系统不支持 WAL —— 退回默认 journal */
    }
  }
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => {
      const stmt = db.prepare(sql)
      return {
        run: (...params) => stmt.run(...params),
        get: (...params) => stmt.get(...params),
        all: (...params) => stmt.all(...params)
      }
    },
    /** 同步事务：fn 抛错则回滚 */
    tx: (fn) => {
      db.exec('BEGIN')
      try {
        const out = fn()
        db.exec('COMMIT')
        return out
      } catch (err) {
        try {
          db.exec('ROLLBACK')
        } catch {
          /* already rolled back */
        }
        throw err
      }
    },
    close: () => db.close()
  }
}
