import test from 'node:test'
import assert from 'node:assert/strict'
import { openDatabase } from '../lib/backend/sqlite.mjs'
import { migrate } from '../lib/backend/schema.mjs'

test('migrate 自愈：版本号已是 2 但缺 v2 列时补齐', async (t) => {
  const db = await openDatabase(':memory:')
  t.after(() => db.close())
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
  db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', '2')").run()
  db.exec('CREATE TABLE sessions (id INTEGER PRIMARY KEY)')
  db.exec('CREATE TABLE memories (id INTEGER PRIMARY KEY)')
  migrate(db)
  const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name)
  assert.ok(columns('sessions').includes('distilled_at'))
  assert.ok(columns('sessions').includes('distilled_count'))
  assert.ok(columns('memories').includes('source_session_id'))
  assert.ok(columns('memories').includes('why'))
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='project_digests'").get())
})

test('migrate 幂等：新库跑两次不报错', async (t) => {
  const db = await openDatabase(':memory:')
  t.after(() => db.close())
  migrate(db)
  migrate(db)
  assert.equal(
    db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value,
    '2'
  )
})
