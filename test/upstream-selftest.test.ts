import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AGENTS, AGENT_BY_ID } from '../src/shared/upstream-agents'
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

  /**
   * JSON 源(gemini)此前是**空检查**:无条件 return ok,详情却写着
   * 「逐条 parseGeminiHistory」。实测本机 ~/.gemini 连 history 都没有也报 🟢。
   * 这四条锁住"它真的在看数据":能解析=绿、自称会话却解析不出=红、
   * 只有配置文件=黄(未验证)、空目录=黄。判据里**没有登录状态**。
   */
  describe('gemini(JSON 源)必须真的解析,不能无条件判绿', () => {
    const gemini = () => AGENT_BY_ID.get('gemini')!
    const dir = (name: string) => {
      const d = path.join(tmp, name)
      fs.mkdirSync(d, { recursive: true })
      return d
    }

    it('已知形状能解析出消息 → 绿,并报出条数', async () => {
      const root = dir('gem-known')
      fs.writeFileSync(
        path.join(root, 'session-1.json'),
        JSON.stringify({
          sessionId: 's1',
          messages: [
            { role: 'user', parts: [{ text: '你好' }] },
            { role: 'model', parts: [{ text: '在的' }] }
          ]
        })
      )
      const r = await checkOne({ ...gemini(), localRoots: [root] })
      expect(r.verdict).toBe('ok')
      expect(r.detail).toContain('2 条')
    })

    it('有 messages 数组但消息形状变了 → 红(这才是漂移)', async () => {
      const root = dir('gem-drift')
      fs.writeFileSync(
        path.join(root, 'session-1.json'),
        JSON.stringify({ messages: [{ author: 'human', blocks: [{ text: 'hi' }] }] })
      )
      const r = await checkOne({ ...gemini(), localRoots: [root] })
      expect(r.verdict).toBe('drift')
      expect(r.detail).toContain('形状可能已变')
    })

    it('只有配置文件(oauth/settings)没有会话 → 黄,不是绿也不是红', async () => {
      const root = dir('gem-config-only')
      fs.writeFileSync(path.join(root, 'oauth_creds.json'), JSON.stringify({ token: 'x' }))
      fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ theme: 'dark' }))
      const r = await checkOne({ ...gemini(), localRoots: [root] })
      expect(r.verdict).toBe('absent')
      expect(r.detail).toContain('没有会话数据')
    })

    it('空目录 → 黄(旧实现会判绿,那是假绿)', async () => {
      const root = dir('gem-empty')
      const r = await checkOne({ ...gemini(), localRoots: [root] })
      expect(r.verdict).toBe('absent')
    })
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
