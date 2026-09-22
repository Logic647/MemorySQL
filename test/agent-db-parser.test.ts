import { describe, expect, it } from 'vitest'
import { parseAgentSqliteSessions } from '../src/plugins/_lib/agent-db-parser'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** build a minimal opencode-lineage store; withSequence mirrors zcode's extra column */
function buildFixture(withSequence: boolean): string {
  const file = path.join(os.tmpdir(), `agent-db-${Math.random().toString(36).slice(2)}.db`)
  const db = new Database(file)
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT${withSequence ? ', sequence INTEGER' : ''});
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);
  `)
  db.prepare('INSERT INTO session VALUES (?,?,?,?,?)').run(
    'sess_money-1', 'H:\\桌面\\temp\\money', 'money 调研', 1789990000000, 1789990600000
  )
  db.prepare('INSERT INTO session VALUES (?,?,?,?,?)').run(
    'sess_empty', 'X:\\empty', '(no turns)', 1789990000000, 1789990000000
  )
  const insMsg = withSequence
    ? db.prepare('INSERT INTO message VALUES (?,?,?,?)')
    : db.prepare('INSERT INTO message VALUES (?,?,?)')
  const msg = (id: string, sid: string, data: string, seq: number): void => {
    if (withSequence) insMsg.run(id, sid, data, seq)
    else insMsg.run(id, sid, data)
  }
  msg('m1', 'sess_money-1', JSON.stringify({ role: 'user', time: { created: 1789990010000 } }), 1)
  msg('m2', 'sess_money-1', JSON.stringify({ role: 'assistant', time: { created: 1789990020000 } }), 2)
  msg('m3', 'sess_money-1', JSON.stringify({ role: 'system', time: { created: 1789990030000 } }), 3)
  db.prepare('INSERT INTO part VALUES (?,?,?,?)').run(
    'p1', 'm1', 'sess_money-1',
    JSON.stringify({ type: 'text', text: '帮我统计收支' })
  )
  db.prepare('INSERT INTO part VALUES (?,?,?,?)').run(
    'p2', 'm2', 'sess_money-1',
    JSON.stringify({ type: 'reasoning', text: '内心独白' })
  )
  db.prepare('INSERT INTO part VALUES (?,?,?,?)').run(
    'p3', 'm2', 'sess_money-1',
    JSON.stringify({ type: 'text', text: '好的，', extra: 1 })
  )
  db.prepare('INSERT INTO part VALUES (?,?,?,?)').run(
    'p4', 'm2', 'sess_money-1',
    JSON.stringify({ type: 'text', text: '先建表。' })
  )
  db.prepare('INSERT INTO part VALUES (?,?,?,?)').run(
    'p5', 'm2', 'sess_money-1',
    JSON.stringify({ type: 'tool', tool: 'Bash', state: { status: 'completed', input: { command: 'ls money' } } })
  )
  db.close()
  return file
}

describe('parseAgentSqliteSessions (opencode-lineage stores)', () => {
  it('builds sessions with cwd/title/timestamps and text+tool messages', () => {
    for (const file of [buildFixture(true), buildFixture(false)]) {
      const sessions = parseAgentSqliteSessions(file, 'zcode')
      expect(sessions).toHaveLength(1) // session without turns is skipped
      const s = sessions[0]
      expect(s.externalId).toBe('sess_money-1')
      expect(s.agentType).toBe('zcode')
      expect(s.cwd).toBe('H:\\桌面\\temp\\money')
      expect(s.title).toBe('money 调研')
      expect(s.startedAt).toBe(1789990000)
      expect(s.endedAt).toBe(1789990600)
      const roles = s.messages.map((m) => m.role)
      expect(roles).toEqual(['user', 'assistant', 'tool'])
      expect(s.messages[0].content).toBe('帮我统计收支')
      expect(s.messages[1].content).toBe('好的，\n先建表。')
      expect(s.messages[1].ts).toBe(1789990020)
      expect(s.messages[2].toolName).toBe('Bash')
      expect(s.messages[2].content).toContain('ls money')
      fs.rmSync(file, { force: true })
    }
  })

  it('filters by session id when onlySessionId is given', () => {
    const file = buildFixture(true)
    expect(parseAgentSqliteSessions(file, 'zcode', 'sess_empty')).toHaveLength(0)
    const one = parseAgentSqliteSessions(file, 'zcode', 'sess_money-1')
    expect(one).toHaveLength(1)
    expect(one[0].externalId).toBe('sess_money-1')
    fs.rmSync(file, { force: true })
  })

  it('returns an empty list when the db does not exist', () => {
    expect(parseAgentSqliteSessions(path.join(os.tmpdir(), 'no-such-db-x9.db'), 'opencode')).toEqual([])
  })
})
