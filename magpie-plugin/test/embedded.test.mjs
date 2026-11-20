import test from 'node:test'
import assert from 'node:assert/strict'
import { createEmbeddedBackend } from '../lib/backend/embedded.mjs'
import { getBackend, resetBackend } from '../lib/backend/index.mjs'
import { onRequest, onResponse, reset as resetHooks } from '../hooks.mjs'

async function fresh() {
  return createEmbeddedBackend({ memory: true })
}

test('内置存储：导入、追加、短列表跳过、项目/会话/检索', async (t) => {
  const backend = await fresh()
  t.after(() => backend.close())
  const call = (name, args = {}) => backend.call(name, args)

  const first = JSON.parse(
    await call('memory_import_session', {
      agent: 'claudecode',
      externalId: 's1',
      cwd: 'H:/work/demo',
      title: '修登录 bug',
      endedAt: 1_760_000_000,
      messages: [
        { role: 'user', content: '登录一直失败怎么办？' },
        { role: 'assistant', content: '先看 session 过期时间，再查 cookie。' }
      ]
    })
  )
  assert.equal(first.outcome, 'imported')
  assert.ok(first.id > 0)

  const appended = JSON.parse(
    await call('memory_import_session', {
      agent: 'claudecode',
      externalId: 's1',
      messages: [
        { role: 'user', content: '登录一直失败怎么办？' },
        { role: 'assistant', content: '先看 session 过期时间，再查 cookie。' },
        { role: 'user', content: 'cookie 也没问题' }
      ]
    })
  )
  assert.equal(appended.outcome, 'updated')

  const shorter = await call('memory_import_session', {
    agent: 'claudecode',
    externalId: 's1',
    messages: [{ role: 'user', content: '只有一条' }]
  })
  assert.match(shorter, /跳过/)

  const sessions = JSON.parse(await call('memory_list_sessions', { format: 'json' }))
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].messageCount, 3)
  assert.equal(sessions[0].project, 'demo')

  // cwd 子目录也能解析到项目根
  const context = await call('memory_get_context', { cwd: 'H:/work/demo/src/plugins' })
  assert.match(context, /## 项目: demo/)
  assert.match(context, /最近会话/)
  assert.match(context, /登录一直失败/)

  await call('memory_write', { kind: 'decision', content: '登录问题优先查 session 过期', cwd: 'H:/work/demo' })
  const twoChar = await call('memory_search', { query: '登录' })
  assert.match(twoChar, /登录问题优先查 session 过期/)

  const projects = JSON.parse(await call('memory_list_projects', { format: 'json' }))
  assert.equal(projects[0].name, 'demo')
  assert.equal(projects[0].sessions, 1)

  const session = await call('memory_get_session', { id: first.id, tail: 2 })
  assert.match(session, /cookie 也没问题/)

  const stats = JSON.parse(await call('memory_stats'))
  assert.equal(stats.sessions, 1)
  assert.equal(stats.projects, 1)

  const digest = await call('memory_get_project_digest', {})
  assert.match(digest, /内置存储/)
})

test('内置存储：收工汇报进入待确认进度与简报', async (t) => {
  const backend = await fresh()
  t.after(() => backend.close())
  const call = (name, args = {}) => backend.call(name, args)

  await call('memory_import_session', {
    agent: 'codex',
    externalId: 's2',
    cwd: 'H:/work/demo',
    messages: [{ role: 'user', content: '开工' }]
  })
  const out = await call('memory_log_progress', {
    project: 'demo',
    done: '把登录修了',
    next: '补测试',
    issues: 'cookie 还是不稳'
  })
  assert.match(out, /已记录收工进度/)

  const brief = await call('memory_get_project_brief', { project: 'demo' })
  assert.match(brief, /待确认进度/)
  assert.match(brief, /补测试/)
  assert.match(brief, /cookie 还是不稳/)
})

test('内置存储：全新库的 context 为空（钩子据此不注入）', async (t) => {
  const backend = await fresh()
  t.after(() => backend.close())
  assert.equal(await backend.call('memory_get_context', {}), '')
})

test('网关钩子 + 内置存储：首次空跳过，捕获后下一轮自动注入', async (t) => {
  resetHooks()
  resetBackend()
  t.after(() => {
    resetBackend()
    resetHooks()
  })
  const ctx = (session, state = {}) => ({
    protocol: 'chat',
    agent: 'Claude Code',
    session,
    cwd: 'H:/work/demo',
    origin: 'local',
    options: { backend: 'embedded', dataDir: ':memory:', recall: true, gatewayTimeoutMs: 1500 },
    signal: new AbortController().signal,
    state,
    report: () => {}
  })

  const first = ctx('s1')
  const body1 = { messages: [{ role: 'user', content: '登录一直失败怎么办？' }] }
  assert.equal(await onRequest(body1, first), undefined) // 空库：不注入

  await onResponse(
    { choices: [{ message: { content: '先看 session 过期时间，再查 cookie。' } }] },
    first
  )

  // 同一场对话的新请求（新 state），现在库里已有会话 → 注入
  const second = ctx('s1', {})
  const body2 = {
    messages: [
      { role: 'user', content: '登录一直失败怎么办？' },
      { role: 'assistant', content: '先看 session 过期时间，再查 cookie。' },
      { role: 'user', content: 'cookie 也没问题' }
    ]
  }
  const out = await onRequest(body2, second)
  assert.ok(out)
  assert.match(out.messages[0].content, /<memorysql-context>/)
  assert.match(out.messages[0].content, /登录一直失败/)
})

test('后端工厂：默认 embedded，backend=app 走代理', async () => {
  resetBackend()
  const embedded = await getBackend({ dataDir: ':memory:' })
  assert.equal(embedded.kind, 'embedded')
  resetBackend()
  const app = await getBackend({ backend: 'app', port: 9 })
  assert.equal(app.kind, 'app')
  resetBackend()
})

test('内置存储：status 报告后端与统计', async (t) => {
  const backend = await fresh()
  t.after(() => backend.close())
  const status = await backend.status()
  assert.equal(status.ok, true)
  assert.equal(status.backend, 'embedded')
  assert.equal(status.port, null)
  assert.equal(status.stats.sessions, 0)
})
