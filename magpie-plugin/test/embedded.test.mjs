import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEmbeddedBackend } from '../lib/backend/embedded.mjs'
import { getBackend, resetBackend } from '../lib/backend/index.mjs'
import { onRequest, onResponse, reset as resetHooks } from '../hooks.mjs'

async function fresh() {
  return createEmbeddedBackend({ memory: true })
}

function tempDir(prefix = 'msql-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function cleanup(dir) {
  try {
    // Windows 上 SQLite 的 WAL 句柄偶尔晚一拍释放；清理失败不应让用例变红。
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    /* temp dir left for the OS */
  }
}

function mockLLM(replies) {
  let i = 0
  return {
    async models() {
      return [{ id: 'test/model', name: 'Test Model' }]
    },
    async resolveModel() {
      return 'test/model'
    },
    async chat() {
      const reply = replies[i]
      i += 1
      if (reply instanceof Error) throw reply
      return {
        model: 'test/model',
        content: typeof reply === 'string' ? reply : JSON.stringify(reply ?? {})
      }
    }
  }
}

async function waitIdle(backend) {
  for (let i = 0; i < 200; i += 1) {
    const state = await backend.ui.distillState()
    if (!state.running) return state
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('job did not finish')
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

  // 网关回写变短（客户端裁过上下文）：不删已存历史，只追加对不上的尾部。
  const shorter = JSON.parse(
    await call('memory_import_session', {
      agent: 'claudecode',
      externalId: 's1',
      messages: [{ role: 'user', content: '只有一条' }]
    })
  )
  assert.equal(shorter.outcome, 'updated')
  assert.equal(shorter.messages, 4)

  const sessions = JSON.parse(await call('memory_list_sessions', { format: 'json' }))
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].messageCount, 4)
  assert.equal(sessions[0].project, 'demo')

  // cwd 子目录也能解析到项目根
  const context = await call('memory_get_context', { cwd: 'H:/work/demo/src/plugins' })
  assert.match(context, /## 项目: demo/)
  assert.match(context, /最近会话/)
  assert.match(context, /修登录 bug/)

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
  const hookLlm = mockLLM([])
  const ctx = (session, state = {}, agent = 'Claude Code') => ({
    protocol: 'chat',
    agent,
    session,
    cwd: 'H:/work/demo',
    origin: 'local',
    options: { backend: 'embedded', dataDir: ':memory:', gatewayTimeoutMs: 1500, llm: hookLlm },
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
  const backend = await getBackend({
    backend: 'embedded',
    dataDir: ':memory:',
    llm: mockLLM([])
  })
  assert.deepEqual(backend.recallConfig(), { inject: false, all: true, agents: [] })
  assert.equal(await onRequest(body2(), ctx('s1', {})), undefined)

  // 打开注入（全部 agent）→ 下一轮注入
  await backend.ui.setDistill({ inject: true, injectAgents: [] })
  assert.deepEqual(backend.recallConfig(), { inject: true, all: true, agents: [] })
  const out = await onRequest(body2(), ctx('s1', {}))
  assert.ok(out)
  assert.match(out.messages[0].content, /<memorysql-context>/)
  assert.match(out.messages[0].content, /登录一直失败/)
  assert.equal(backend.ui.activity(7).totals.injected, 1)

  // 同一会话后续请求复用缓存块，不再算一次注入
  assert.ok(await onRequest(body2(), ctx('s1', {})))
  assert.equal(backend.ui.activity(7).totals.injected, 1)

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

  // s1 / s3 / s4 各注入一次；被挡掉的 s2 不计
  assert.equal(backend.ui.activity(7).totals.injected, 3)
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

  assert.deepEqual(backend.recallConfig(), { inject: false, all: true, agents: [] })

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
  assert.deepEqual(backend.recallConfig(), { inject: true, all: false, agents: ['zcode', 'claudecode'] })
  // magpie 识别到的 agent 都在列表里，哪怕还没有会话
  assert.ok(saved.agents.some((agent) => agent.id === 'claudecode' && agent.name === 'Claude Code' && agent.magpie && agent.sessions === 0))
  assert.ok(saved.agents.some((agent) => agent.id === 'zcode' && agent.name === 'ZCode' && agent.sessions === 1))

  // 空列表 = 注入全部 agent
  const all = await backend.ui.setDistill({ injectAgents: [] })
  assert.deepEqual(all.injectAgents, [])
  assert.deepEqual(backend.recallConfig(), { inject: true, all: true, agents: [] })

  // 指定模式下一个都不选 = 不注入（不能变回全部）
  const none = await backend.ui.setDistill({ inject: true, injectAll: false, injectAgents: [] })
  assert.equal(none.injectAll, false)
  assert.deepEqual(backend.recallConfig(), { inject: true, all: false, agents: [] })

  // 关掉注入
  const off = await backend.ui.setDistill({ inject: false, injectAll: true, injectAgents: [] })
  assert.equal(off.inject, false)
  assert.deepEqual(backend.recallConfig(), { inject: false, all: true, agents: [] })
})

test('内置存储：项目总结按安静期用 LLM 生成', async (t) => {
  const llm = {
    async models() {
      return [{ id: 'test/model', name: 'Test Model' }]
    },
    async resolveModel() {
      return 'test/model'
    },
    async chat() {
      return {
        model: 'test/model',
        content: JSON.stringify({ summary: '项目总览', recent: '最近进展', todos: ['补测试'] })
      }
    }
  }
  const backend = await createEmbeddedBackend({ memory: true, llm })
  t.after(() => backend.close())
  const call = (name, args = {}) => backend.call(name, args)

  await call('memory_import_session', {
    agent: 'zcode',
    externalId: 'digest-1',
    cwd: 'H:/work/demo',
    title: '做项目',
    endedAt: Math.floor(Date.now() / 1000) - 3600,
    messages: [
      { role: 'user', content: '开始做项目' },
      { role: 'assistant', content: '先搭骨架' }
    ]
  })

  await backend.ui.setDistill({ digestOn: true, digestQuietMinutes: 30, model: 'test/model' })
  backend.ui.runDigest()
  let state = null
  for (let i = 0; i < 100; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    state = await backend.ui.distillState()
    if (!state.running) break
  }
  assert.equal(state.running, false)
  assert.equal(state.digestAdded, 1)
  assert.ok(state.digestLast > 0)
  assert.equal(state.digestError, '')

  const digest = await call('memory_get_project_digest', { project: 'demo' })
  assert.match(digest, /项目总览/)
  assert.match(digest, /补测试/)
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

test('内置存储：多行记忆在续接包里保留换行，并声明项目文件优先', async (t) => {
  const backend = await fresh()
  t.after(() => backend.close())
  const call = (name, args = {}) => backend.call(name, args)

  await call('memory_write', { kind: 'fact', content: '第一行\n第二行\n\n第四行' })
  const context = await call('memory_get_context', {})
  assert.match(context, /- 第一行\n {2}第二行\n\n {2}第四行/)
  assert.match(context, /AGENTS\.md/)
  assert.match(context, /项目文件为准/)
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

test('内置存储：记忆活动按日统计（新增/更新/清理/搜索/注入，页面搜索不计）', async (t) => {
  const backend = await fresh()
  t.after(() => backend.close())
  const call = (name, args = {}, opts = {}) => backend.call(name, args, opts)

  await call('memory_write', { kind: 'fact', content: '活动统计：第一条' })
  await call('memory_write', { kind: 'fact', content: '活动统计：第二条' })
  const user = backend.ui.saveMemory({ text: '活动统计：手写', scope: 'global' })
  assert.equal(user.ok, true)

  // 页面自己的搜索不计入 agent 召回率
  await call('memory_search', { query: '活动统计', format: 'json' }, { internal: true })
  const hits = JSON.parse(await call('memory_search', { query: '活动统计', format: 'json' }))
  assert.ok(hits.some((hit) => hit.kind === 'memory'))

  // 编辑 = 更新；归档 = 清理；删已归档的不重复计
  const edited = backend.ui.saveMemory({
    id: user.id,
    text: '活动统计：手写（改）',
    kind: 'fact',
    scope: 'global'
  })
  assert.equal(edited.ok, true)
  backend.ui.setMemoryStatus({ ids: [user.id], status: 'archived' })
  backend.ui.removeMemories({ ids: [user.id] })
  backend.noteInjection()
  backend.noteInjection()

  const activity = backend.ui.activity(7)
  assert.equal(activity.days, 7)
  assert.equal(activity.series.length, 7)
  assert.equal(activity.series[6].day, activity.today)
  assert.equal(activity.series[6].recorded, true)
  assert.equal(activity.totals.created, 3)
  assert.equal(activity.totals.createdBy.agent, 2)
  assert.equal(activity.totals.createdBy.user, 1)
  assert.equal(activity.totals.updated, 1)
  assert.equal(activity.totals.cleaned, 1)
  assert.deepEqual(activity.totals.cleanedBy, { you: 1 })
  assert.equal(activity.totals.searches, 1)
  assert.equal(activity.totals.found, 1)
  assert.ok(activity.totals.recalled >= 1)
  assert.equal(activity.totals.injected, 2)
  assert.equal(activity.active, 2)
  assert.ok(activity.used >= 1)

  // 30 天窗口也成立；since 不晚于今天
  const month = backend.ui.activity(30)
  assert.equal(month.series.length, 30)
  assert.ok(month.since <= month.today)
})

test('内置存储：开始统计前的新增按记忆自身日期回填（其余指标无历史）', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memorysql-stats-'))
  const first = await createEmbeddedBackend({ dataDir: dir })
  await first.call('memory_write', { kind: 'fact', content: '十天前写的记忆' })
  first.close()

  // 把这条记忆的创建时间改到 10 天前，并清掉当天实时计数，模拟「升级前的老记忆」
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path.join(dir, 'memory.db'))
  db.prepare('UPDATE memories SET created_at = ?').run(Date.now() - 10 * 86400_000)
  db.prepare('DELETE FROM memory_stats').run()
  db.close()

  const second = await createEmbeddedBackend({ dataDir: dir })
  t.after(() => {
    second.close()
    cleanup(dir)
  })

  const activity = second.ui.activity(30)
  assert.equal(activity.series.length, 30)
  assert.equal(activity.totals.created, 1)
  assert.equal(activity.totals.updated, 0)
  assert.equal(activity.totals.searches, 0)
  const backfilled = activity.series.find((day) => day.backfilled)
  assert.ok(backfilled)
  assert.equal(backfilled.recorded, false)
  assert.equal(Object.values(backfilled.created).reduce((n, v) => n + v, 0), 1)
  assert.equal(activity.series.filter((day) => day.recorded).length, 1)
})

test('内置存储：整理记忆可撤销；用户之后改过的合并结果保留', async (t) => {
  const llm = {
    async models() {
      return [{ id: 'test/model', name: 'Test Model' }]
    },
    async resolveModel() {
      return 'test/model'
    },
    async chat() {
      return {
        model: 'test/model',
        content: JSON.stringify({
          merge: [{ ids: [1, 2], text: '合并后的记忆', kind: 'fact' }],
          archive: [{ id: 3, why: '已经过时' }]
        })
      }
    }
  }
  const backend = await createEmbeddedBackend({ memory: true, llm })
  t.after(() => backend.close())
  const call = (name, args = {}) => backend.call(name, args)
  const settle = async () => {
    for (let i = 0; i < 100; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      const state = await backend.ui.distillState()
      if (!state.running) return state
    }
    throw new Error('整理没有结束')
  }

  for (const text of ['记忆 A', '记忆 B', '记忆 C']) {
    await call('memory_write', { kind: 'fact', content: text })
  }
  await backend.ui.setDistill({ model: 'test/model' })
  backend.ui.runDream()
  let state = await settle()
  assert.equal(state.dreamError, '')
  assert.equal(state.changes.length, 2)
  assert.ok(state.changes.every((change) => Number.isFinite(change.at)))

  const list = (status) => backend.ui.listMemories({ status, limit: 100 }).memories
  assert.equal(list('active').filter((m) => m.source === 'llm-tidy').length, 1)
  assert.equal(list('archived').filter((m) => m.status === 'archived').length, 1)
  assert.equal(list('archived').filter((m) => m.status === 'superseded').length, 2)

  const undone = backend.ui.undoDream()
  assert.deepEqual(
    { ok: undone.ok, restored: undone.restored, removed: undone.removed, kept: undone.kept },
    { ok: true, restored: 3, removed: 1, kept: 0 }
  )
  assert.equal(list('active').length, 3)
  assert.equal(list('archived').length, 0)
  assert.equal((await backend.ui.distillState()).changes.length, 0)

  // 再整理一次，然后用户编辑合并结果；撤销时整个合并保留，只恢复归档的那条
  backend.ui.runDream()
  state = await settle()
  assert.equal(state.changes.length, 2)
  const merged = list('active').find((m) => m.source === 'llm-tidy')
  assert.ok(merged)
  backend.ui.saveMemory({ id: merged.id, text: '我改过的合并结果', kind: 'fact', scope: 'global' })
  const second = backend.ui.undoDream()
  assert.equal(second.ok, true)
  assert.equal(second.kept, 1)
  assert.equal(second.restored, 1)
  assert.equal(second.removed, 0)
  const after = list('active')
  assert.ok(after.some((m) => m.id === merged.id && m.text === '我改过的合并结果'))
  assert.equal(after.filter((m) => m.status === 'active').length, 2)
})

async function seedScopes(backend) {
  await backend.call('memory_import_session', {
    agent: 'claudecode',
    externalId: 'seed',
    cwd: '/work/alpha',
    messages: [
      { role: 'user', content: 'alpha question' },
      { role: 'assistant', content: 'alpha answer' }
    ]
  })
  await backend.call('memory_write', { kind: 'fact', content: 'global fact A' })
  await backend.call('memory_write', { kind: 'fact', content: 'global fact A again' })
  await backend.call('memory_write', { kind: 'fact', content: 'alpha fact 1', cwd: '/work/alpha' })
  await backend.call('memory_write', { kind: 'fact', content: 'alpha fact 2', cwd: '/work/alpha' })
}

function dbRows(dir) {
  return new Promise((resolve, reject) => {
    import('node:sqlite')
      .then(({ DatabaseSync }) => {
        const db = new DatabaseSync(path.join(dir, 'memory.db'))
        const rows = db.prepare('SELECT id, content, status, source FROM memories ORDER BY id').all()
        db.close()
        resolve(rows)
      })
      .catch(reject)
  })
}

test('整理撤销：重启后仍在（记录在 tidy_changes，不靠 distill.json）', async (t) => {
  const dir = tempDir('msql-restart-')
  let backend = await createEmbeddedBackend({
    dataDir: dir,
    llm: mockLLM([{ merge: [{ ids: [1, 2], text: 'merged global', kind: 'fact' }] }, {}])
  })
  t.after(() => {
    try {
      backend.close()
    } catch {
      /* already closed */
    }
    cleanup(dir)
  })
  await seedScopes(backend)
  backend.ui.runDream()
  await waitIdle(backend)
  assert.equal((await dbRows(dir)).filter((row) => row.status === 'superseded').length, 2)
  backend.close()

  backend = await createEmbeddedBackend({ dataDir: dir, llm: mockLLM([]) })
  const state = await backend.ui.distillState()
  assert.ok(state.undoCount > 0)
  const undone = backend.ui.undoDream()
  assert.deepEqual(
    { ok: undone.ok, restored: undone.restored, removed: undone.removed },
    { ok: true, restored: 2, removed: 1 }
  )
  assert.equal((await dbRows(dir)).filter((row) => row.status === 'superseded').length, 0)
})

test('整理撤销：后面的作用域失败，前面已提交的合并仍可撤销', async (t) => {
  const dir = tempDir('msql-partial-')
  const backend = await createEmbeddedBackend({
    dataDir: dir,
    llm: mockLLM([{ merge: [{ ids: [1, 2], text: 'merged global', kind: 'fact' }] }, new Error('HTTP 429')])
  })
  t.after(() => {
    backend.close()
    cleanup(dir)
  })
  await seedScopes(backend)
  backend.ui.runDream()
  const state = await waitIdle(backend)
  assert.match(state.dreamError, /429/)
  assert.equal(state.changes.length, 1)
  assert.equal(state.undoCount, 1)
  assert.equal((await dbRows(dir)).filter((row) => row.status === 'superseded').length, 2)
  const undone = backend.ui.undoDream()
  assert.equal(undone.ok, true)
  assert.equal(undone.restored, 2)
  assert.equal(undone.removed, 1)
})

test('设置文件半截：坏文件备份，撤销记录与设置不丢', async (t) => {
  const dir = tempDir('msql-badstate-')
  let backend = await createEmbeddedBackend({
    dataDir: dir,
    llm: mockLLM([{ merge: [{ ids: [1, 2], text: 'merged global', kind: 'fact' }] }, {}])
  })
  t.after(() => {
    try {
      backend.close()
    } catch {
      /* already closed */
    }
    cleanup(dir)
  })
  await seedScopes(backend)
  backend.ui.runDream()
  await waitIdle(backend)
  backend.close()

  const statePath = path.join(dir, 'distill.json')
  const good = fs.readFileSync(statePath, 'utf8')
  fs.writeFileSync(statePath, good.slice(0, Math.floor(good.length / 2)))

  backend = await createEmbeddedBackend({ dataDir: dir, llm: mockLLM([]) })
  await backend.ui.setDistill({ inject: false })
  assert.ok(fs.readdirSync(dir).some((name) => name.startsWith('distill.json.bad-')))
  const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  assert.ok((saved.changes ?? []).length > 0)
  assert.ok((await backend.ui.distillState()).undoCount > 0)
  assert.equal(backend.ui.undoDream().ok, true)
})

test('项目范围：给了没命中的 cwd 只给全局记忆，不落到最近活跃项目', async (t) => {
  const backend = await fresh()
  t.after(() => backend.close())
  await seedScopes(backend)
  const context = await backend.call('memory_get_context', {
    cwd: '/work/beta',
    include_last_session: false
  })
  assert.match(context, /global fact A/)
  assert.doesNotMatch(context, /alpha fact/)
  assert.doesNotMatch(context, /\/work\/alpha/)
  assert.doesNotMatch(context, /alpha question/)
})

test('项目归属：$HOME 会话不再吞掉子目录项目', async (t) => {
  const backend = await fresh()
  t.after(() => backend.close())
  await backend.call('memory_import_session', {
    agent: 'claudecode',
    externalId: 'home',
    cwd: '/Users/u',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' }
    ]
  })
  await backend.call('memory_import_session', {
    agent: 'claudecode',
    externalId: 'proj',
    cwd: '/Users/u/code/secret-proj',
    messages: [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' }
    ]
  })
  const projects = JSON.parse(await backend.call('memory_list_projects', { format: 'json', limit: 10 }))
  assert.equal(projects.length, 2)
  assert.ok(projects.some((project) => /secret-proj/.test(project.path ?? '')))
})

test('会话压缩：客户端历史变短也不删已存档案', async (t) => {
  const backend = await fresh()
  t.after(() => backend.close())
  const original = []
  for (let i = 0; i < 10; i += 1) {
    original.push({ role: i % 2 ? 'assistant' : 'user', content: `before-compaction ${i}` })
  }
  await backend.call('memory_import_session', {
    agent: 'claudecode',
    externalId: 'compact',
    cwd: '/work/alpha',
    messages: original
  })
  const after = [{ role: 'user', content: 'summary of earlier work' }]
  for (let i = 0; i < 12; i += 1) {
    after.push({ role: i % 2 ? 'user' : 'assistant', content: `after-compaction ${i}` })
    await backend.call('memory_import_session', {
      agent: 'claudecode',
      externalId: 'compact',
      cwd: '/work/alpha',
      messages: after
    })
  }
  const hits = JSON.parse(
    await backend.call('memory_search', { query: 'before-compaction', format: 'json' }, { internal: true })
  )
  assert.ok(hits.length > 0)
  const session = JSON.parse(await backend.call('memory_list_sessions', { format: 'json' }))[0]
  assert.ok(session.messageCount > 10)
})

test('整理并发：LLM 期间用户归档/改过的记忆不被合并', async (t) => {
  let backend
  const llm = {
    async models() {
      return [{ id: 'test/model', name: 'Test Model' }]
    },
    async resolveModel() {
      return 'test/model'
    },
    async chat() {
      const first = backend.ui.listMemories({ status: 'active', limit: 10 }).memories[0]
      backend.ui.setMemoryStatus({ ids: [first.id], status: 'archived' })
      return {
        model: 'test/model',
        content: JSON.stringify({ merge: [{ ids: [1, 2], text: 'merged', kind: 'fact' }] })
      }
    }
  }
  backend = await createEmbeddedBackend({ memory: true, llm })
  t.after(() => backend.close())
  await backend.call('memory_write', { kind: 'fact', content: '并发 A' })
  await backend.call('memory_write', { kind: 'fact', content: '并发 B' })
  backend.ui.runDream()
  const state = await waitIdle(backend)
  assert.equal(state.changes.length, 0)
  assert.equal(state.undoCount, 0)
  assert.equal(
    backend.ui.listMemories({ status: 'active', limit: 10 }).memories.filter((m) => m.source === 'llm-tidy').length,
    0
  )
})

test('internal 只能由调用方选项设置：工具参数不能跳过召回统计', async (t) => {
  const backend = await fresh()
  t.after(() => backend.close())
  await backend.call('memory_write', { kind: 'fact', content: '统计边界记忆' })
  await backend.call('memory_search', { query: '边界', format: 'json', internal: true })
  await backend.call('memory_search', { query: '边界', format: 'json' }, { internal: true })
  await backend.call('memory_search', { query: '边界', format: 'json' })
  assert.equal(backend.ui.activity(7).totals.searches, 2)
})


test('文件权限：数据目录 0700，库与设置 0600（POSIX）', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows 不保留 POSIX 权限位')
    return
  }
  const dir = path.join(tempDir('msql-modes-'), 'memorysql')
  const backend = await createEmbeddedBackend({ dataDir: dir })
  t.after(() => {
    try {
      backend.close()
    } catch {
      /* already closed */
    }
    cleanup(path.dirname(dir))
  })
  await backend.call('memory_write', { kind: 'fact', content: '权限测试' })
  await backend.ui.setDistill({ inject: false })
  backend.close()
  const mode = (file) => (fs.statSync(file).mode & 0o777).toString(8)
  assert.equal(mode(dir), '700')
  assert.equal(mode(path.join(dir, 'memory.db')), '600')
  assert.equal(mode(path.join(dir, 'distill.json')), '600')
})

test('迁移：0.6.0（schema 2）的库升级后一行不丢', async (t) => {
  const dir = tempDir('msql-migrate-')
  let backend = await createEmbeddedBackend({ dataDir: dir })
  t.after(() => {
    try {
      backend.close()
    } catch {
      /* already closed */
    }
    cleanup(dir)
  })
  await seedScopes(backend)
  backend.close()

  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path.join(dir, 'memory.db'))
  const before = db.prepare('SELECT id, content, status, source FROM memories ORDER BY id').all()
  db.exec("DROP TABLE tidy_changes; DROP TABLE memory_stats; DELETE FROM meta WHERE key='stats_since'")
  db.exec("UPDATE meta SET value='2' WHERE key='schema_version'")
  db.close()

  backend = await createEmbeddedBackend({ dataDir: dir, llm: mockLLM([]) })
  assert.deepEqual(await dbRows(dir), before)
  const hits = JSON.parse(
    await backend.call('memory_search', { query: 'alpha', format: 'json' }, { internal: true })
  )
  assert.ok(hits.length > 0)
  const context = await backend.call('memory_get_context', { cwd: '/work/alpha' })
  assert.match(context, /alpha fact 1/)
  const check = new DatabaseSync(path.join(dir, 'memory.db'))
  assert.equal(check.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '4')
  check.close()
})

test('并发：两个连接同时写同一个库不会互相覆盖', async (t) => {
  const dir = tempDir('msql-concurrent-')
  const first = await createEmbeddedBackend({ dataDir: dir })
  const second = await createEmbeddedBackend({ dataDir: dir })
  t.after(() => {
    try {
      first.close()
    } catch {
      /* already closed */
    }
    try {
      second.close()
    } catch {
      /* already closed */
    }
    cleanup(dir)
  })
  await Promise.all([
    first.call('memory_write', { kind: 'fact', content: '并发写入 A' }),
    second.call('memory_write', { kind: 'fact', content: '并发写入 B' }),
    first.call('memory_log_progress', { project: 'demo', done: '并发进度 A' }),
    second.call('memory_log_progress', { project: 'demo', done: '并发进度 B' })
  ])
  const list = first.ui.listMemories({ status: 'active', limit: 20 }).memories
  assert.ok(list.some((memory) => memory.text === '并发写入 A'))
  assert.ok(list.some((memory) => memory.text === '并发写入 B'))
  const candidates = second.ui.listMemories({ status: 'candidate', limit: 20 }).memories
  assert.ok(candidates.some((memory) => memory.text.includes('并发进度 A')))
  assert.ok(candidates.some((memory) => memory.text.includes('并发进度 B')))
})
