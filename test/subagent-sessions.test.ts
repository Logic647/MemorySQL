import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseAgentSqliteSessions } from '../src/plugins/_lib/agent-db-parser'
import { CORE_MIGRATIONS } from '../src/plugins/core-schema/migrations'
import { createIngestService } from '../src/plugins/core-schema/ingest'
import { createSearchService } from '../src/plugins/core-schema/search'
import { createMcpTools } from '../src/plugins/core-schema/mcp-tools'
import type { RawSession } from '../src/shared/types'

/**
 * 子代理会话:源库里明确标了(zcode session.task_type / opencode session.parent_id),
 * 过去一律当普通会话入库,真机 100 条 zcode 里有 37 条是「你是 xxx 子代理」——
 * 列表直接被挤满。现在照常入库(内容/检索不丢),但默认折叠在父会话下。
 */
const tmpFiles: string[] = []

function fixtureDb(): string {
  const file = path.join(os.tmpdir(), `subagent-${Math.random().toString(36).slice(2)}.db`)
  const db = new Database(file)
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT,
      time_created INTEGER, time_updated INTEGER, parent_id TEXT, task_type TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);
  `)
  const sess = db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?)')
  sess.run('top', '/p', '正常会话', 1790000000000, 1790000500000, null, 'interactive')
  sess.run('child', '/p', '子代理', 1790000100000, 1790000200000, 'top', 'subagent_child')
  sess.run('orphan', '/p', '任务子会话', 1790000300000, 1790000400000, null, 'workflow_child')
  const msg = db.prepare('INSERT INTO message VALUES (?,?,?)')
  const part = db.prepare('INSERT INTO part VALUES (?,?,?,?)')
  for (const id of ['top', 'child', 'orphan']) {
    msg.run(`m-${id}`, id, JSON.stringify({ role: 'user', time: { created: 1790000000000 } }))
    part.run(`p-${id}`, `m-${id}`, id, JSON.stringify({ type: 'text', text: `${id} turn` }))
  }
  db.close()
  tmpFiles.push(file)
  return file
}

afterEach(() => {
  for (const f of tmpFiles.splice(0)) fs.rmSync(f, { force: true })
})

describe('capture: 子代理会话识别', () => {
  it('parent_id 非空 → 子代理,并带出父会话 id', () => {
    const sessions = parseAgentSqliteSessions(fixtureDb(), 'zcode')
    const child = sessions.find((s) => s.externalId === 'child')
    expect(child?.isSubagent).toBe(true)
    expect(child?.parentExternalId).toBe('top')
  })

  it('task_type 非 interactive → 子代理(即使没有 parent_id,如 workflow_child)', () => {
    const sessions = parseAgentSqliteSessions(fixtureDb(), 'zcode')
    expect(sessions.find((s) => s.externalId === 'orphan')?.isSubagent).toBe(true)
  })

  it('顶层会话不会被误标', () => {
    const sessions = parseAgentSqliteSessions(fixtureDb(), 'zcode')
    const top = sessions.find((s) => s.externalId === 'top')
    expect(top?.isSubagent).toBeUndefined()
    expect(top?.parentExternalId).toBeUndefined()
  })

  it('没有 parent_id/task_type 列的 store 照常工作(不报错、全部当顶层)', () => {
    const file = path.join(os.tmpdir(), `subagent-flat-${Math.random().toString(36).slice(2)}.db`)
    const db = new Database(file)
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT,
      time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);`)
    db.prepare('INSERT INTO session VALUES (?,?,?,?,?)').run('s1', '/p', 't', 1, 2)
    db.prepare('INSERT INTO message VALUES (?,?,?)').run('m1', 's1', JSON.stringify({ role: 'user' }))
    db.prepare('INSERT INTO part VALUES (?,?,?,?)').run('p1', 'm1', 's1', JSON.stringify({ type: 'text', text: 'hi' }))
    db.close()
    tmpFiles.push(file)
    const sessions = parseAgentSqliteSessions(file, 'opencode')
    expect(sessions).toHaveLength(1)
    expect(sessions[0].isSubagent).toBeUndefined()
  })
})

describe('ingest: 子会话字段与父会话回填', () => {
  const mkDb = (): Database.Database => {
    const db = new Database(':memory:')
    for (const m of CORE_MIGRATIONS) db.exec(m.up)
    return db
  }
  const raw = (externalId: string, over: Partial<RawSession> = {}): RawSession => ({
    agentType: 'zcode',
    externalId,
    title: externalId,
    messages: [{ role: 'user', content: `hello ${externalId}` }],
    ...over
  })
  const service = (db: Database.Database) =>
    createIngestService({ sqlite: db, getSummarizer: () => null, onIngest: () => {} })

  it('写入 is_subagent / parent_external_id,并在父会话入库后回填 parent_session_id', async () => {
    const db = mkDb()
    const ingest = service(db)
    // 先子后父:验证回溯解析(首次全量导入顺序不保证)
    await ingest.ingestSessions([raw('child', { isSubagent: true, parentExternalId: 'top' })])
    await ingest.ingestSessions([raw('top', { isSubagent: false })])
    const child = db
      .prepare('SELECT is_subagent, parent_external_id, parent_session_id FROM sessions WHERE external_id = ?')
      .get('child') as { is_subagent: number; parent_external_id: string; parent_session_id: number }
    const top = db.prepare('SELECT id FROM sessions WHERE external_id = ?').get('top') as { id: number }
    expect(child.is_subagent).toBe(1)
    expect(child.parent_external_id).toBe('top')
    expect(child.parent_session_id).toBe(top.id)
    db.close()
  })

  it('父会话不存在时 parent_session_id 留空(不报错),父到来后补上', async () => {
    const db = mkDb()
    const ingest = service(db)
    await ingest.ingestSessions([raw('child', { isSubagent: true, parentExternalId: 'later' })])
    expect(
      (db.prepare('SELECT parent_session_id FROM sessions WHERE external_id = ?').get('child') as {
        parent_session_id: number | null
      }).parent_session_id
    ).toBeNull()
    await ingest.ingestSessions([raw('later')])
    const later = db.prepare('SELECT id FROM sessions WHERE external_id = ?').get('later') as { id: number }
    expect(
      (db.prepare('SELECT parent_session_id FROM sessions WHERE external_id = ?').get('child') as {
        parent_session_id: number | null
      }).parent_session_id
    ).toBe(later.id)
    db.close()
  })

  it('老库升级:内容没变也要把 is_subagent 补上(增量水位不会重读老会话)', async () => {
    const db = mkDb()
    const ingest = service(db)
    await ingest.ingestSessions([raw('child')])
    expect(
      (db.prepare('SELECT is_subagent FROM sessions WHERE external_id = ?').get('child') as { is_subagent: number })
        .is_subagent
    ).toBe(0)
    // 同样的内容,第二次带上子代理标记 —— 必须落库,不能因为 content_hash 相同就跳过
    await ingest.ingestSessions([raw('child', { isSubagent: true, parentExternalId: 'top' })])
    const row = db
      .prepare('SELECT is_subagent, parent_external_id FROM sessions WHERE external_id = ?')
      .get('child') as { is_subagent: number; parent_external_id: string }
    expect(row.is_subagent).toBe(1)
    expect(row.parent_external_id).toBe('top')
    db.close()
  })
})

describe('MCP: 子代理会话不占列表位置', () => {
  const build = (): { db: Database.Database; call: (n: string, a?: Record<string, unknown>) => Promise<string> } => {
    const db = new Database(':memory:')
    for (const m of CORE_MIGRATIONS) db.exec(m.up)
    const ins = db.prepare(
      `INSERT INTO sessions (id, agent_type, external_id, title, summary, content_hash,
         message_count, tool_call_count, started_at, last_message_at, updated_at, device_id,
         is_subagent, parent_session_id)
       VALUES (?, 'zcode', ?, ?, '', ?, 1, 0, ?, ?, ?, 'local', ?, ?)`
    )
    const now = Math.floor(Date.now() / 1000)
    ins.run(1, 'top', '正常会话', 'h1', now - 60, now - 10, now, 0, null)
    ins.run(2, 'child', '子代理会话', 'h2', now - 50, now - 5, now, 1, 1)
    ins.run(3, 'child2', '另一个子代理', 'h3', now - 40, now - 1, now, 1, 1)
    db.exec(`INSERT INTO sessions_fts (rowid, title, summary) SELECT id, title, summary FROM sessions`)
    const tools = createMcpTools({
      sqlite: db,
      search: createSearchService(db),
      memories: createIngestService({ sqlite: db, getSummarizer: () => null, onIngest: () => {} }),
      services: {
        use: (name: string): never => {
          throw new Error(`Service not provided: ${name}`)
        }
      }
    })
    return {
      db,
      call: async (name, args = {}) => {
        const tool = tools.find((t) => t.name === name)!
        return String(await tool.handler(args))
      }
    }
  }

  it('memory_list_sessions 默认只回顶层会话', async () => {
    const { db, call } = build()
    const out = await call('memory_list_sessions', {})
    expect(out).toContain('正常会话')
    expect(out).not.toContain('子代理会话')
    expect(out).not.toContain('另一个子代理')
    db.close()
  })

  it('includeSubagents=true 时才把子会话放回来', async () => {
    const { db, call } = build()
    const out = await call('memory_list_sessions', { includeSubagents: true })
    expect(out).toContain('子代理会话')
    db.close()
  })

  it('memory_get_context 的最近会话不含子代理(否则「用户最近做过什么」全是子代理)', async () => {
    const { db, call } = build()
    const out = await call('memory_get_context', {})
    expect(out).toContain('正常会话')
    expect(out).not.toContain('子代理会话')
    db.close()
  })
})
