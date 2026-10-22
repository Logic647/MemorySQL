import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Db } from '../src/main/core/db'
import { CORE_MIGRATIONS } from '../src/plugins/core-schema/migrations'
import { createIngestService, type IngestService } from '../src/plugins/core-schema/ingest'
import type { RawSession } from '../src/shared/types'

/**
 * 「最后一次对话时间」(last_message_at)
 *
 * 会话开始时间回答不了「这个会话还有下文吗」——同一个项目里,上周开始、
 * 今早还在聊的会话和上周开始、上周就结束的会话,用户要能一眼分开。
 *
 * The schema comes from the production migration runner (Db.migrate), so this
 * test exercises the exact SQL the app applies on upgrade.
 */

let store: Db
let ingest: IngestService
let tmp: string

beforeEach(() => {
  store = new Db(':memory:')
  store.migrate('core-schema', CORE_MIGRATIONS)
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'last-activity-'))
  ingest = createIngestService({
    sqlite: store.sqlite,
    getSummarizer: () => null,
    onIngest: () => {}
  })
})

afterEach(() => {
  store.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const session = (over: Partial<RawSession> & { externalId: string }): RawSession => ({
  agentType: 'zcode',
  title: '会话标题',
  cwd: tmp,
  messages: [
    { role: 'user', content: '第一条', ts: 1_700_000_000 },
    { role: 'assistant', content: '第二条', ts: 1_700_000_600 }
  ],
  ...over
})

const lastOf = (externalId: string): unknown =>
  (
    store.sqlite.prepare('SELECT last_message_at FROM sessions WHERE external_id = ?').get(externalId) as {
      last_message_at: number | null
    }
  ).last_message_at

describe('last_message_at — 入库时维护', () => {
  it('取最新消息的时间戳(不是第一条,也不是 ended_at)', async () => {
    await ingest.ingestSessions([
      session({ externalId: 's1', startedAt: 1_699_000_000, endedAt: 1_700_000_000 })
    ])
    expect(lastOf('s1')).toBe(1_700_000_600)
  })

  it('消息没有时间戳时回落到适配器给的 ended_at', async () => {
    await ingest.ingestSessions([
      session({
        externalId: 's2',
        endedAt: 1_700_000_900,
        messages: [{ role: 'user', content: '无时间戳' }]
      })
    ])
    expect(lastOf('s2')).toBe(1_700_000_900)
  })

  it('两者都没有时留空,而不是写 0(0 会被当成 1970 年)', async () => {
    await ingest.ingestSessions([
      session({ externalId: 's3', messages: [{ role: 'user', content: '无时间戳' }] })
    ])
    expect(lastOf('s3')).toBeNull()
  })

  it('会话续聊后重新入库,时间随之前进', async () => {
    await ingest.ingestSessions([session({ externalId: 's4' })])
    expect(lastOf('s4')).toBe(1_700_000_600)
    await ingest.ingestSessions([
      session({
        externalId: 's4',
        messages: [
          { role: 'user', content: '第一条', ts: 1_700_000_000 },
          { role: 'assistant', content: '第二条', ts: 1_700_000_600 },
          { role: 'user', content: '继续', ts: 1_700_050_000 }
        ]
      })
    ])
    expect(lastOf('s4')).toBe(1_700_050_000)
  })
})

describe('last_message_at — 迁移回填', () => {
  /** a database that only knows migrations v1..v6 */
  const buildOldDb = (): Db => {
    const old = new Db(':memory:')
    old.migrate('core-schema', CORE_MIGRATIONS.slice(0, 6))
    return old
  }

  it('v7 给旧库补上最后一次对话时间(取历史消息里的最大 ts)', () => {
    const old = buildOldDb()
    old.sqlite
      .prepare(
        `INSERT INTO sessions (agent_type, external_id, started_at, ended_at, title, content_hash, updated_at, device_id)
         VALUES ('zcode', 'old1', 1699000000, 1700000000, '旧会话', 'h', 1, 'local')`
      )
      .run()
    old.sqlite
      .prepare(
        `INSERT INTO session_messages (session_id, seq, role, content, ts)
         VALUES (1, 0, 'user', '第一条', 1699500000), (1, 1, 'assistant', '第二条', 1699999999)`
      )
      .run()
    old.migrate('core-schema', [CORE_MIGRATIONS[6]])
    const row = old.sqlite.prepare('SELECT last_message_at FROM sessions WHERE id = 1').get() as {
      last_message_at: number | null
    }
    expect(row.last_message_at).toBe(1_699_999_999)
    old.close()
  })

  it('v7 对没有消息时间戳的旧会话回落到 ended_at', () => {
    const old = buildOldDb()
    old.sqlite
      .prepare(
        `INSERT INTO sessions (agent_type, external_id, started_at, ended_at, title, content_hash, updated_at, device_id)
         VALUES ('zcode', 'old2', 1699000000, 1700000123, '旧会话', 'h', 1, 'local')`
      )
      .run()
    old.migrate('core-schema', [CORE_MIGRATIONS[6]])
    const row = old.sqlite.prepare('SELECT last_message_at FROM sessions WHERE id = 1').get() as {
      last_message_at: number | null
    }
    expect(row.last_message_at).toBe(1_700_000_123)
    old.close()
  })
})
