import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * 2026-11-10 批(Magpie 名单补全)的 9 家新适配器解析器回归。
 * fixture 全部内联;闭源三家(droid/grok/minimax)的样本按 magpie 对真实
 * 文件的实证解析构造,装机校准后如有出入以真机样本为准改 fixture。
 */

const tmps: string[] = []
function tmpdir(tag: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `msql-magpie-${tag}-`))
  tmps.push(d)
  return d
}
afterEach(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { force: true, recursive: true })
})

// ───────────────────────────── goose(SQLite)─────────────────────────────

describe('capture-goose(goose-db)', () => {
  it('解析 sessions/messages 两表:标题/cwd/秒级时间戳/块数组/子代理/归档', async () => {
    const root = tmpdir('goose')
    const dbDir = path.join(root, 'sessions')
    fs.mkdirSync(dbDir, { recursive: true })
    const db = new Database(path.join(dbDir, 'sessions.db'))
    db.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, name TEXT, description TEXT, user_set_name BOOLEAN DEFAULT FALSE,
        session_type TEXT NOT NULL DEFAULT 'user', working_dir TEXT,
        created_at TIMESTAMP, updated_at TIMESTAMP, archived_at TIMESTAMP, parent_session_id TEXT
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT, session_id TEXT,
        role TEXT, content_json TEXT, created_timestamp INTEGER
      );
    `)
    db.prepare(
      "INSERT INTO sessions (id, name, session_type, working_dir, created_at, updated_at) VALUES (?,?,?,?,?,?)"
    ).run('s1', '重命名过的会话', 'user', 'H:\\proj', '2026-11-09T10:00:00Z', '2026-11-09T10:30:00Z')
    db.prepare(
      "INSERT INTO sessions (id, name, session_type, working_dir, created_at, updated_at, parent_session_id, archived_at) VALUES (?,?,?,?,?,?,?,?)"
    ).run('s2', '', 'subagent', 'H:\\proj', '2026-11-09T10:05:00Z', '2026-11-09T10:06:00Z', 's1', '2026-11-09T11:00:00Z')
    const ins = db.prepare('INSERT INTO messages (session_id, role, content_json, created_timestamp) VALUES (?,?,?,?)')
    ins.run('s1', 'user', JSON.stringify([{ type: 'text', text: '帮我看看构建' }]), 1794218400)
    ins.run(
      's1',
      'assistant',
      JSON.stringify([
        { type: 'thinking', thinking: '内部推理' },
        { type: 'text', text: '好的' },
        { type: 'toolRequest', id: 't1', toolCall: { status: 'success', value: { name: 'developer__shell', arguments: { command: 'ls' } } } }
      ]),
      1794218460
    )
    ins.run('s2', 'user', JSON.stringify([{ type: 'text', text: '子代理任务' }]), 1794218700)
    db.close()

    const { parseGooseSessions } = await import('../src/plugins/capture-goose/goose-db.ts')
    const out = parseGooseSessions(path.join(dbDir, 'sessions.db'))
    expect(out).toHaveLength(2)
    const main = out.find((s) => s.externalId === 's1')!
    expect(main.agentType).toBe('goose')
    expect(main.title).toBe('重命名过的会话')
    expect(main.cwd).toBe('H:\\proj')
    expect(main.startedAt).toBe(Math.floor(Date.parse('2026-11-09T10:00:00Z') / 1000))
    expect(main.endedAt).toBe(Math.floor(Date.parse('2026-11-09T10:30:00Z') / 1000))
    expect(main.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
    expect(main.messages[2].toolName).toBe('developer__shell')
    expect(JSON.parse(main.messages[2].content)).toEqual({ command: 'ls' })
    // thinking 块不进时间线
    expect(main.messages[1].content).toBe('好的')

    const sub = out.find((s) => s.externalId === 's2')!
    expect(sub.isSubagent).toBe(true)
    expect(sub.parentExternalId).toBe('s1')
    expect(sub.archived).toBe(true)
  })

  it('未知 schema(缺 sessions/messages)→ 返回 [],不抛错', async () => {
    const root = tmpdir('goose-x')
    fs.mkdirSync(root, { recursive: true })
    const db = new Database(path.join(root, 'sessions.db'))
    db.exec('CREATE TABLE other (id INTEGER)')
    db.close()
    const { parseGooseSessions } = await import('../src/plugins/capture-goose/goose-db.ts')
    expect(parseGooseSessions(path.join(root, 'sessions.db'))).toEqual([])
  })

  it('老 schema(无 session_type/parent 列)→ 全按顶层会话', async () => {
    const root = tmpdir('goose-old')
    fs.mkdirSync(root, { recursive: true })
    const db = new Database(path.join(root, 'sessions.db'))
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT, working_dir TEXT, created_at TIMESTAMP, updated_at TIMESTAMP);
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content_json TEXT, created_timestamp INTEGER);
    `)
    db.prepare("INSERT INTO sessions (id, name, working_dir) VALUES ('a','x','/p')").run()
    db.prepare("INSERT INTO messages (session_id, role, content_json, created_timestamp) VALUES ('a','user','[{\"type\":\"text\",\"text\":\"hi\"}]',100)").run()
    db.close()
    const { parseGooseSessions } = await import('../src/plugins/capture-goose/goose-db.ts')
    const out = parseGooseSessions(path.join(root, 'sessions.db'))
    expect(out).toHaveLength(1)
    expect(out[0].isSubagent).toBeUndefined()
  })
})

// ───────────────────────────── droid(JSONL)─────────────────────────────

describe('capture-droid(droid-parser)', () => {
  const start = JSON.stringify({
    type: 'session_start',
    id: 'dr-1',
    title: 'New Session',
    cwd: 'H:\\proj',
    lastCwd: 'H:\\proj\\sub'
  })
  const msg = (id: string, role: string, content: unknown, ts: string): string =>
    JSON.stringify({ type: 'message', id, timestamp: ts, message: { role, content } })

  it('解析 session_start + message 事件;lastCwd 优先;New Session 不当标题', async () => {
    const dir = tmpdir('droid')
    const file = path.join(dir, 'dr-1.jsonl')
    fs.writeFileSync(
      file,
      [
        start,
        msg('m1', 'user', '修一下 EXDEV', '2026-11-09T10:00:00Z'),
        msg('m2', 'assistant', [{ type: 'text', text: '好' }, { type: 'tool_use', name: 'shell', input: { cmd: 'ls' } }], '2026-11-09T10:00:05Z')
      ].join('\n')
    )
    const { parseDroidSession } = await import('../src/plugins/capture-droid/droid-parser.ts')
    const s = parseDroidSession(file)!
    expect(s.externalId).toBe('dr-1')
    expect(s.cwd).toBe('H:\\proj\\sub')
    expect(s.title).toBeUndefined()
    expect(s.startedAt).toBe(Math.floor(Date.parse('2026-11-09T10:00:00Z') / 1000))
    expect(s.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
    expect(s.messages[2].toolName).toBe('shell')
  })

  it('用户消息的 content 是块数组时仍保持 user 角色(真实样本回归)', async () => {
    // magpie testdata(droid-skills)里的真实形状:user 的 content 也是 Anthropic 块数组。
    // 旧实现按「数组内容 → assistant」硬编码,把每条用户消息都写成了助手发言。
    const dir = tmpdir('droid-userblocks')
    const file = path.join(dir, 'u1.jsonl')
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: 'session_start', id: 'u1', title: '块数组的用户消息', cwd: '/p' }),
        JSON.stringify({
          type: 'message',
          id: 'm1',
          timestamp: '2026-11-09T10:00:00.000Z',
          message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>上下文</system-reminder>' }] }
        }),
        JSON.stringify({
          type: 'message',
          id: 'm2',
          timestamp: '2026-11-09T10:00:01.000Z',
          message: { role: 'user', content: [{ type: 'text', text: '真正的问题' }] }
        }),
        JSON.stringify({
          type: 'message',
          id: 'm3',
          timestamp: '2026-11-09T10:00:02.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: '回答' }] }
        })
      ].join('\n')
    )
    const { parseDroidSession } = await import('../src/plugins/capture-droid/droid-parser.ts')
    const s = parseDroidSession(file)!
    expect(s.messages.map((m) => m.role)).toEqual(['user', 'user', 'assistant'])
    expect(s.title).toBe('块数组的用户消息')
  })

  it('fork 的拷贝段(forkedAtMessageId 之前)跳过;子代理按 callingSessionId 标记', async () => {
    const dir = tmpdir('droid-fork')
    fs.writeFileSync(
      path.join(dir, 'fork.jsonl'),
      [
        JSON.stringify({ type: 'session_start', id: 'fork', title: '分叉', cwd: '/p', parent: 'src', forkedAtMessageId: 'm2' }),
        msg('m1', 'user', '这是拷贝来的', '2026-11-09T09:00:00Z'),
        msg('m2', 'assistant', '拷贝的回复', '2026-11-09T09:00:01Z'),
        msg('m3', 'user', '自己的新消息', '2026-11-09T10:00:00Z')
      ].join('\n')
    )
    fs.writeFileSync(
      path.join(dir, 'sub.jsonl'),
      [
        JSON.stringify({ type: 'session_start', id: 'sub', title: '子任务', cwd: '/p', callingSessionId: 'main' }),
        msg('x1', 'user', '子任务输入', '2026-11-09T10:01:00Z')
      ].join('\n')
    )
    const { parseDroidSession } = await import('../src/plugins/capture-droid/droid-parser.ts')
    const fork = parseDroidSession(path.join(dir, 'fork.jsonl'))!
    expect(fork.messages.map((m) => m.content)).toEqual(['自己的新消息'])
    const sub = parseDroidSession(path.join(dir, 'sub.jsonl'))!
    expect(sub.isSubagent).toBe(true)
    expect(sub.parentExternalId).toBe('main')
  })
})

// ───────────────────────────── cline(JSON)─────────────────────────────

describe('capture-cline(cline-parser)', () => {
  it('manifest + messages.json;子代理 messages 文件标 isSubagent', async () => {
    const root = tmpdir('cline')
    const dir = path.join(root, 'sess-1')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'sess-1.json'),
      JSON.stringify({
        session_id: 'sess-1',
        started_at: '2026-11-09T10:00:00Z',
        cwd: 'H:\\proj',
        prompt: '第一句话',
        metadata: { title: '修 bug' }
      })
    )
    fs.writeFileSync(
      path.join(dir, 'sess-1.messages.json'),
      JSON.stringify({
        messages: [
          { role: 'user', content: [{ type: 'text', text: '修一下' }], ts: 1794218400000 },
          { role: 'assistant', content: [{ type: 'text', text: '在修' }], ts: 1794218405000, modelInfo: { id: 'claude-x' } }
        ]
      })
    )
    fs.writeFileSync(
      path.join(dir, 'agent-7.messages.json'),
      JSON.stringify({ messages: [{ role: 'user', content: '子代理输入', ts: 1794218410000 }] })
    )
    const { parseClineSessionDir } = await import('../src/plugins/capture-cline/cline-parser.ts')
    const out = parseClineSessionDir(dir)
    expect(out).toHaveLength(2)
    const main = out.find((s) => s.externalId === 'sess-1')!
    expect(main.title).toBe('修 bug')
    expect(main.cwd).toBe('H:\\proj')
    expect(main.startedAt).toBe(Math.floor(Date.parse('2026-11-09T10:00:00Z') / 1000))
    expect(main.messages[0].content).toBe('修一下')
    const sub = out.find((s) => s.externalId === 'agent-7')!
    expect(sub.isSubagent).toBe(true)
    expect(sub.parentExternalId).toBe('sess-1')
    expect(sub.title).toBeUndefined()
  })

  it('fork 的 forkedAt 之前的拷贝消息跳过', async () => {
    const root = tmpdir('cline-fork')
    const dir = path.join(root, 'fk')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'fk.json'),
      JSON.stringify({ session_id: 'fk', started_at: '2026-11-09T10:00:00Z', metadata: { fork: { forkedAt: '2026-11-09T10:00:30Z' } } })
    )
    fs.writeFileSync(
      path.join(dir, 'fk.messages.json'),
      JSON.stringify({
        messages: [
          { role: 'user', content: '拷贝', ts: 1794218400000 },
          { role: 'user', content: '新的', ts: 1794218431000 }
        ]
      })
    )
    const { parseClineSessionDir } = await import('../src/plugins/capture-cline/cline-parser.ts')
    const out = parseClineSessionDir(dir)
    expect(out[0].messages.map((m) => m.content)).toEqual(['新的'])
  })
})

// ───────────────────────────── pi / omp(JSONL)─────────────────────────────

describe('capture-pi / omp(pi-jsonl)', () => {
  function writePi(dir: string, ...seg: unknown[]): string {
    const lines = seg.pop() as string[]
    const file = path.join(dir, ...(seg as string[]))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, lines.join('\n'))
    return file
  }

  it('session 头 + message 条;toolCall 成工具消息;title_change 覆盖标题', async () => {
    const root = tmpdir('pi')
    const file = writePi(root, 'sessions', 'proj-x', '1794218400000_s1.jsonl', [
      JSON.stringify({ type: 'session', id: 's1', cwd: '/p' }),
      JSON.stringify({ type: 'message', timestamp: '2026-11-09T10:00:00Z', message: { role: 'user', content: '你好' } }),
      JSON.stringify({ type: 'message', timestamp: '2026-11-09T10:00:10Z', message: { role: 'assistant', model: 'glm-5', content: [{ type: 'text', text: '嗨' }, { type: 'toolCall', name: 'read', arguments: { path: 'a.ts' } }] } }),
      JSON.stringify({ type: 'title_change', title: '问候' })
    ])
    const { parsePiSessionFile } = await import('../src/plugins/_lib/pi-jsonl.ts')
    const s = parsePiSessionFile(file, 'pi')!
    expect(s.externalId).toBe('s1')
    expect(s.title).toBe('问候')
    expect(s.startedAt).toBe(Math.floor(Date.parse('2026-11-09T10:00:00Z') / 1000))
    expect(s.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
    expect(s.messages[2].toolName).toBe('read')
  })

  it('fork(parentSession)的拷贝段跳过;omp artifacts → isSubagent', async () => {
    const root = tmpdir('pi-fork')
    const file = writePi(root, 'sessions', 'p', '1794218400000_f1.jsonl', [
      JSON.stringify({ type: 'session', id: 'f1', cwd: '/p', parentSession: 'orig', timestamp: '2026-11-09T10:00:00Z' }),
      JSON.stringify({ type: 'message', timestamp: '2026-11-09T09:00:00Z', message: { role: 'user', content: '拷贝段' } }),
      JSON.stringify({ type: 'message', timestamp: '2026-11-09T10:00:20Z', message: { role: 'user', content: '新的' } })
    ])
    // omp artifacts:<time>_<id>/ 目录里放子代理文件
    const mainFile = writePi(root, 'sessions', 'p', '1794218400000_m1.jsonl', [
      JSON.stringify({ type: 'session', id: 'm1', cwd: '/p' })
    ])
    fs.mkdirSync(path.join(path.dirname(mainFile), '1794218400000_m1'), { recursive: true })
    fs.writeFileSync(
      path.join(path.dirname(mainFile), '1794218400000_m1', 'worker.jsonl'),
      [JSON.stringify({ type: 'session', id: 'w1', cwd: '/p' }), JSON.stringify({ type: 'message', timestamp: '2026-11-09T10:01:00Z', message: { role: 'user', content: '子任务' } })].join('\n')
    )
    const { parsePiSessionFile, parseOmpArtifacts } = await import('../src/plugins/_lib/pi-jsonl.ts')
    const fork = parsePiSessionFile(file, 'pi')!
    expect(fork.messages.map((m) => m.content)).toEqual(['新的'])
    const subs = parseOmpArtifacts(mainFile, 'omp')
    expect(subs).toHaveLength(1)
    expect(subs[0].isSubagent).toBe(true)
    expect(subs[0].parentExternalId).toBe('m1')
    expect(subs[0].agentType).toBe('omp')
  })

  it('没有 session 头的文件返回 null(不合式不算会话)', async () => {
    const root = tmpdir('pi-bad')
    const file = writePi(root, 'sessions', 'p', 'x_loose.jsonl', ['{"type":"message","message":{"role":"user","content":"孤儿"}}'])
    const { parsePiSessionFile } = await import('../src/plugins/_lib/pi-jsonl.ts')
    expect(parsePiSessionFile(file, 'pi')).toBeNull()
  })
})

// ───────────────────────────── grok(JSONL+summary)─────────────────────────────

describe('capture-grok(grok-parser)', () => {
  it('summary.json + updates.jsonl:流式 chunk 合并、tool_call、子代理 kind', async () => {
    const root = tmpdir('grok')
    const dir = path.join(root, 'H-3A-2Fproj', 'g1')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'summary.json'),
      JSON.stringify({
        info: { id: 'g1', cwd: 'H:\\proj' },
        created_at: '2026-11-09T10:00:00Z',
        generated_title: '修构建'
      })
    )
    const upd = (o: unknown): string => JSON.stringify(o)
    fs.writeFileSync(
      path.join(dir, 'updates.jsonl'),
      [
        upd({ timestamp: 1794218400, params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '修' } } } }),
        upd({ timestamp: 1762682401, params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '一下' } } } }),
        upd({ timestamp: 1762682402, params: { update: { sessionUpdate: 'tool_call', _meta: { 'x.ai/tool': { name: 'read_file' } } } } }),
        upd({ timestamp: 1762682403, params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '好了' } } } })
      ].join('\n')
    )
    // 子代理:kind 以 subagent 开头
    const subDir = path.join(root, 'H-3A-2Fproj', 'g2')
    fs.mkdirSync(subDir, { recursive: true })
    fs.writeFileSync(path.join(subDir, 'summary.json'), JSON.stringify({ info: { id: 'g2' }, session_kind: 'subagent-explore', parent_session_id: 'g1' }))
    fs.writeFileSync(
      path.join(subDir, 'updates.jsonl'),
      upd({ timestamp: 1794218500, params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '子' } } } })
    )
    const { parseGrokSessionDir } = await import('../src/plugins/capture-grok/grok-parser.ts')
    const main = parseGrokSessionDir(dir)!
    expect(main.externalId).toBe('g1')
    expect(main.title).toBe('修构建')
    expect(main.cwd).toBe('H:\\proj')
    expect(main.messages.map((m) => m.role)).toEqual(['user', 'tool', 'assistant'])
    expect(main.messages[0].content).toBe('修一下')
    expect(main.messages[1].toolName).toBe('read_file')
    const sub = parseGrokSessionDir(subDir)!
    expect(sub.isSubagent).toBe(true)
    expect(sub.parentExternalId).toBe('g1')
  })
  it('generated_title 为空时回退 session_summary(真实样本回归)', async () => {
    const root = tmpdir('grok-title')
    const dir = path.join(root, 'p', 'g9')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'summary.json'),
      JSON.stringify({ info: { id: 'g9', cwd: '/p' }, generated_title: '', session_summary: '回退标题' })
    )
    fs.writeFileSync(
      path.join(dir, 'updates.jsonl'),
      JSON.stringify({ timestamp: 1794218400, params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' } } } })
    )
    const { parseGrokSessionDir } = await import('../src/plugins/capture-grok/grok-parser.ts')
    expect(parseGrokSessionDir(dir)?.title).toBe('回退标题')
  })
})

// ───────────────────────────── minimax(JSONL)─────────────────────────────

describe('capture-minimax(minimax-parser)', () => {
  it('日期桶目录 + base64 会话 id + messages.jsonl;同 id 多代去重', async () => {
    const root = tmpdir('minimax')
    const dir = path.join(root, 'v2', 'sessions', '2026', '11', '09', '10-00-00-123-session_' + Buffer.from('mvs_abc', 'utf-8').toString('base64url'))
    fs.mkdirSync(dir, { recursive: true })
    const line = (mid: string, role: string, ts: number, content: unknown): string =>
      JSON.stringify({ message_id: mid, message: { role, model: 'm2', timestamp: ts, content } })
    fs.writeFileSync(
      path.join(dir, 'messages.jsonl'),
      [
        line('a1', 'user', 1794218400000, '看看这个库'),
        line('a2', 'assistant', 1794218410000, [{ type: 'text', text: '好' }]),
        // 另一代副本:同 message_id,跳过
        line('a1', 'user', 1794218400000, '看看这个库')
      ].join('\n')
    )
    fs.writeFileSync(path.join(dir, 'history-catalog.json'), JSON.stringify({ generations: 2 }))
    const { parseMinimaxSessionDir } = await import('../src/plugins/capture-minimax/minimax-parser.ts')
    const s = parseMinimaxSessionDir(dir)!
    expect(s.externalId).toBe('mvs_abc')
    expect(s.agentType).toBe('minimax')
    expect(s.startedAt).toBe(1794218400)
    expect(s.messages).toHaveLength(2)
  })
})

// ───────────────────── deveco / mimocode(opencode 系布局)─────────────────────

describe('deveco / mimocode(opencode 系布局复用)', () => {
  it('legacy 三表布局按 deveco/mimocode agentType 解析', async () => {
    const root = tmpdir('opencode-fork')
    const dbPath = path.join(root, 'deveco.db')
    const db = new Database(dbPath)
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, data TEXT);
    `)
    db.prepare("INSERT INTO session VALUES ('o1','H:\\proj','标题',1794218400000,1794218460000)").run()
    db.prepare("INSERT INTO message VALUES ('m1','o1',?)").run(
      JSON.stringify({ role: 'user', time: { created: 1794218400000 } })
    )
    db.prepare("INSERT INTO part VALUES ('p1','m1',?)").run(JSON.stringify({ type: 'text', text: 'fork 会话' }))
    db.close()
    const { parseAgentSqliteSessions } = await import('../src/plugins/_lib/agent-db-parser.ts')
    const out = parseAgentSqliteSessions(dbPath, 'deveco')
    expect(out).toHaveLength(1)
    expect(out[0].agentType).toBe('deveco')
    expect(out[0].messages[0].content).toBe('fork 会话')
    const asMimo = parseAgentSqliteSessions(dbPath, 'mimocode')
    expect(asMimo[0].agentType).toBe('mimocode')
  })
})

// ───────────────────────────── goose-patch(YAML 手术)─────────────────────────────

describe('goose-patch(extensions upsert)', async () => {
  const { upsertGooseExtension, gooseUrlScalar } = await import('../src/main/core/goose-patch.ts')

  it('无 extensions → 文件尾追加;已有 memorysql → 原地替换;兄弟条目保留', () => {
    expect(upsertGooseExtension([], 'http://127.0.0.1:8642/mcp')).toEqual([
      'extensions:',
      '  memorysql:',
      '    enabled: true',
      '    type: streamable_http',
      '    name: memorysql',
      '    uri: "http://127.0.0.1:8642/mcp"'
    ])

    const existing = [
      'GOOSE_PROVIDER: anthropic',
      'extensions:',
      '  developer:',
      '    enabled: true',
      '    type: builtin',
      '  memorysql:',
      '    enabled: false',
      '    type: streamable_http',
      '    uri: "http://127.0.0.1:1/mcp"'
    ]
    const out = upsertGooseExtension(existing, 'http://127.0.0.1:8642/mcp')
    expect(out.filter((l) => l.startsWith('  memorysql')).length).toBe(1)
    expect(out.join('\n')).toContain('uri: "http://127.0.0.1:8642/mcp"')
    expect(out.join('\n')).toContain('enabled: true')
    // developer 条目原样保留
    expect(out.join('\n')).toContain('type: builtin')
  })

  it('幂等:重复写入结果一致;非本机端点拒绝', () => {
    const once = upsertGooseExtension(['extensions:'], 'http://127.0.0.1:8642/mcp')
    const twice = upsertGooseExtension(once, 'http://127.0.0.1:8642/mcp')
    expect(twice).toEqual(once)
    expect(() => gooseUrlScalar('http://evil.example.com/mcp')).toThrow(/非法/)
  })
})
