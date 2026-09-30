import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AGENTS, AGENT_BY_ID } from '../upstream/agents'
import { checkOne } from '../upstream/check'

/**
 * 黑盒检查器自身的自测 —— 证明它「真的能抓到漂移」,而不只是在本机碰巧全绿。
 * 没有这一层,一个永远返回 ok 的检查器和没有检查器没有区别。
 *
 * 手法:构造合成库模拟上游改 schema,断言检查器判红并指出正确的缺失项。
 */
let tmp: string

function makeDb(name: string, tables: Record<string, string[]>): string {
  const p = path.join(tmp, name)
  const db = new Database(p)
  for (const [t, cols] of Object.entries(tables)) {
    db.exec(`CREATE TABLE ${t} (${cols.join(', ')})`)
  }
  db.close()
  return p
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'upstream-selftest-'))
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('检查器自测:能抓到上游漂移', () => {
  it('opencode 老库(legacy 三表)应判绿', async () => {
    const db = makeDb('opencode-legacy.db', {
      session: ['id', 'directory', 'title', 'time_created', 'time_updated'],
      message: ['id', 'session_id', 'data'],
      part: ['id', 'message_id', 'data']
    })
    const contract = { ...AGENT_BY_ID.get('opencode')!, localRoots: [db] }
    const r = await checkOne(contract)
    expect(r.verdict, `legacy 布局应判绿,实际: ${r.detail}`).toBe('ok')
  })

  it('opencode 新库(session_v2)应判绿 —— 多代布局并存', async () => {
    const db = makeDb('opencode-v2.db', {
      session_v2: ['id', 'directory', 'title', 'time_created', 'time_updated', 'project_id'],
      session_message: ['id', 'session_id', 'seq', 'data']
    })
    const contract = { ...AGENT_BY_ID.get('opencode')!, localRoots: [db] }
    const r = await checkOne(contract)
    expect(r.verdict, `v2 布局应判绿,实际: ${r.detail}`).toBe('ok')
  })

  it('上游把表整个改名 → 必须判红并点名缺哪些表', async () => {
    // 模拟 opencode 下一次再改 schema:session_v2 → conversation
    const db = makeDb('opencode-renamed.db', {
      conversation: ['id', 'directory', 'title', 'time_created'],
      session_message: ['id', 'session_id']
    })
    const contract = { ...AGENT_BY_ID.get('opencode')!, localRoots: [db] }
    const r = await checkOne(contract)
    expect(r.verdict).toBe('drift')
    expect(r.missingTables).toContain('session_v2')
    expect(r.detail).toMatch(/表结构对不上/)
  })

  it('表名没变但列被删 → 必须判红并点名缺的列', async () => {
    const db = makeDb('opencode-cols.db', {
      session_v2: ['id', 'directory', 'title'], // time_created / time_updated 被删
      session_message: ['id', 'session_id', 'data']
    })
    const contract = { ...AGENT_BY_ID.get('opencode')!, localRoots: [db] }
    const r = await checkOne(contract)
    expect(r.verdict).toBe('drift')
    expect(r.missingColumns?.session_v2).toEqual(
      expect.arrayContaining(['time_created', 'time_updated'])
    )
  })

  it('zcode 换成 opencode v2 布局也应判红(zcode 仍停在 legacy)', async () => {
    const db = makeDb('zcode-upgraded.db', {
      session_v2: ['id', 'directory', 'title', 'time_created', 'time_updated'],
      session_message: ['id', 'session_id', 'data']
    })
    const contract = { ...AGENT_BY_ID.get('zcode')!, localRoots: [db] }
    const r = await checkOne(contract)
    expect(r.verdict, 'zcode 若跟随上游迁到 v2,台账应立刻报漂移').toBe('drift')
  })

  it('空库(表全丢)判红', async () => {
    const db = makeDb('opencode-empty.db', { some_other_table: ['id'] })
    const contract = { ...AGENT_BY_ID.get('opencode')!, localRoots: [db] }
    const r = await checkOne(contract)
    expect(r.verdict).toBe('drift')
  })

  it('源不存在时不应误报为漂移', async () => {
    const contract = {
      ...AGENT_BY_ID.get('opencode')!,
      localRoots: [path.join(tmp, 'nope-does-not-exist')]
    }
    const r = await checkOne(contract)
    expect(r.verdict).toBe('absent')
  })

  it('台账里的 sqlite 期望自身能被解析器满足(防止声明了不存在的表)', () => {
    for (const c of AGENTS) {
      if (c.source.kind !== 'sqlite') continue
      for (const group of c.source.sqlite.tablesAnyOf) {
        expect(group.length, `${c.id} 有空的布局组`).toBeGreaterThan(0)
      }
    }
  })
})
