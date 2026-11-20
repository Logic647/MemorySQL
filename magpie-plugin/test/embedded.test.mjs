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

test('网关钩子 + 内置存储：注入默认关，开启后捕获的下一轮才注入；可按 agent 过滤', async (t) => {
  resetHooks()
  resetBackend()
  t.after(() => {
    resetBackend()
    resetHooks()
  })
  const ctx = (session, state = {}, agent = 'Claude Code') => ({
    protocol: 'chat',
    agent,
    session,
    cwd: 'H:/work/demo',
    origin: 'local',
    options: { backend: 'embedded', dataDir: ':memory:', gatewayTimeoutMs: 1500 },
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

  const body2 = () => ({
    messages: [
      { role: 'user', content: '登录一直失败怎么办？' },
      { role: 'assistant', content: '先看 session 过期时间，再查 cookie。' },
      { role: 'user', content: 'cookie 也没问题' }
    ]
  })
  // 记忆注入默认关：即使插件选项 recall=true，也以页面开关为准
  const backend = await getBackend({ backend: 'embedded', dataDir: ':memory:' })
  assert.deepEqual(backend.recallConfig(), { inject: false, agents: [] })
  assert.equal(await onRequest(body2(), ctx('s1', {})), undefined)

  // 打开注入（全部 agent）→ 下一轮注入
  await backend.ui.setDistill({ inject: true, injectAgents: [] })
  assert.deepEqual(backend.recallConfig(), { inject: true, agents: [] })
  const out = await onRequest(body2(), ctx('s1', {}))
  assert.ok(out)
  assert.match(out.messages[0].content, /<memorysql-context>/)
  assert.match(out.messages[0].content, /登录一直失败/)

  // 只注入指定 agent：Claude Code 被挡，ZCode 放行
  await backend.ui.setDistill({ injectAgents: ['zcode'] })
  assert.equal(await onRequest(body2(), ctx('s2')), undefined)
  const z = await onRequest(body2(), ctx('s3', {}, 'ZCode'))
  assert.ok(z)
  assert.match(z.messages[0].content, /<memorysql-context>/)

  // magpie 显示名（不在固定映射表里的）也能选中：Claude Desktop
  await backend.ui.setDistill({ injectAgents: ['Claude Desktop'] })
  const desktop = await onRequest(body2(), ctx('s4', {}, 'Claude Desktop'))
  assert.ok(desktop)
  assert.match(desktop.messages[0].content, /<memorysql-context>/)
})

test('内置存储：结构化搜索（命中片段/会话 id）+ 删除会话 + 回写不复活', async (t) => {
  const backend = await fresh()
  t.after(() => backend.close())
  const call = (name, args = {}) => backend.call(name, args)

  const imported = JSON.parse(
    await call('memory_import_session', {
      agent: 'zcode',
      externalId: 's-del',
      cwd: 'H:/work/demo',
      title: '排查 magpie 插件搜索',
      endedAt: 1_760_000_100,
      messages: [
        { role: 'user', content: 'magpie 插件里搜索为什么不工作？' },
        { role: 'assistant', content: '页面 token 在服务重启后失效，需要重新载入页面。' }
      ]
    })
  )
  assert.equal(imported.outcome, 'imported')

  // 结构化命中：片段围绕关键词、带会话 id（页面据此渲染可点的结果）
  const hits = JSON.parse(await call('memory_search', { query: '搜索', format: 'json' }))
  assert.ok(hits.length >= 1)
  const message = hits.find((h) => h.kind === 'message')
  assert.ok(message)
  assert.equal(message.sessionId, imported.id)
  assert.match(message.snippet, /搜索/)
  assert.equal(message.title, '排查 magpie 插件搜索')
  assert.ok(message.snippet.length <= 200)

  // 删除：列表 / 深读 / 搜索都看不到
  const removed = backend.ui.deleteSessions({ ids: [imported.id] })
  assert.deepEqual(removed, { ok: true, count: 1, ids: [imported.id] })
  assert.equal(JSON.parse(await call('memory_list_sessions', { format: 'json' })).length, 0)
  assert.equal(await call('memory_get_session', { id: imported.id }), `未找到会话 #${imported.id}`)
  assert.equal(JSON.parse(await call('memory_search', { query: '搜索', format: 'json' })).length, 0)

  // 网关回写默认不会把用户删掉的会话复活；显式 revive 才恢复
  const skipped = JSON.parse(
    await call('memory_import_session', {
      agent: 'zcode',
      externalId: 's-del',
      messages: [{ role: 'user', content: '又说了一句' }]
    })
  )
  assert.equal(skipped.outcome, 'skipped-deleted')
  assert.equal(JSON.parse(await call('memory_list_sessions', { format: 'json' })).length, 0)

  const revived = JSON.parse(
    await call('memory_import_session', {
      agent: 'zcode',
      externalId: 's-del',
      revive: true,
      replace: true,
      messages: [{ role: 'user', content: '明确恢复' }]
    })
  )
  assert.equal(revived.outcome, 'updated')
  assert.equal(JSON.parse(await call('memory_list_sessions', { format: 'json' })).length, 1)
})

test('内置存储：记忆注入默认关，开关与目标 agent 可保存', async (t) => {
  const llm = {
    async resolveModel() {
      return 'test/model'
    },
    async models() {
      return []
    },
    async chat() {
      return { model: 'test/model', content: '{}' }
    }
  }
  // 模拟 magpie 的 agents-state.json：claude 还没会话，zcode 有一场
  const backend = await createEmbeddedBackend({
    memory: true,
    llm,
    agentsState: [
      { id: 'claude', name: 'Claude Code' },
      { id: 'zcode', name: 'ZCode' }
    ]
  })
  t.after(() => backend.close())
  const call = (name, args = {}) => backend.call(name, args)

  assert.deepEqual(backend.recallConfig(), { inject: false, agents: [] })

  await call('memory_import_session', {
    agent: 'zcode',
    externalId: 'agent-list',
    cwd: 'H:/work/demo',
    messages: [{ role: 'user', content: '你好' }]
  })
  const saved = await backend.ui.setDistill({
    inject: true,
    injectAgents: ['ZCode', 'zcode', ' ', 'claudecode']
  })
  assert.equal(saved.inject, true)
  assert.deepEqual(saved.injectAgents, ['zcode', 'claudecode'])
  assert.deepEqual(backend.recallConfig(), { inject: true, agents: ['zcode', 'claudecode'] })
  // magpie 识别到的 agent 都在列表里，哪怕还没有会话
  assert.ok(saved.agents.some((agent) => agent.id === 'claudecode' && agent.name === 'Claude Code' && agent.magpie && agent.sessions === 0))
  assert.ok(saved.agents.some((agent) => agent.id === 'zcode' && agent.name === 'ZCode' && agent.sessions === 1))

  // 空列表 = 注入全部 agent
  const all = await backend.ui.setDistill({ injectAgents: [] })
  assert.deepEqual(all.injectAgents, [])
  assert.deepEqual(backend.recallConfig(), { inject: true, agents: [] })

  // 关掉注入
  const off = await backend.ui.setDistill({ inject: false })
  assert.equal(off.inject, false)
  assert.deepEqual(backend.recallConfig(), { inject: false, agents: [] })
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
