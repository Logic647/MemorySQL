import test from 'node:test'
import assert from 'node:assert/strict'
import { startService, stopService } from '../service.mjs'
import { resetBackend, getBackend } from '../lib/backend/index.mjs'

const llm = {
  async resolveModel() {
    return 'test/model'
  },
  async models() {
    return [{ id: 'test/model', name: 'Test Model', provider: 'test' }]
  },
  async chat() {
    return { model: 'test/model', content: '[]' }
  }
}

test('记忆页 API：token + 新增/列表/设置/蒸馏状态', async (t) => {
  resetBackend()
  const pagePort = 39500 + Math.floor(Math.random() * 400)
  const svc = startService({ pagePort, backend: 'embedded', dataDir: ':memory:', llm })
  t.after(() => {
    stopService()
    resetBackend()
  })
  const port = await svc.ready
  const base = `http://127.0.0.1:${port}`

  const html = await (await fetch(`${base}/`)).text()
  const token = html.match(/name="memorysql-token" content="([^"]+)"/)?.[1]
  assert.ok(token)
  const auth = { 'x-memorysql-token': token, 'content-type': 'application/json' }

  // 新增
  const created = await (
    await fetch(`${base}/api/memories`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ text: '用户偏好中文注释', kind: 'preference', scope: 'global' })
    })
  ).json()
  assert.equal(created.ok, true)
  assert.ok(created.id > 0)

  // 列表（状态分段）
  const list = await (await fetch(`${base}/api/memories?status=active`, { headers: auth })).json()
  assert.equal(list.ok, true)
  assert.equal(list.memories.length, 1)
  assert.equal(list.memories[0].text, '用户偏好中文注释')
  assert.equal(list.counts.active, 1)

  // 归档 / 恢复 / 删除
  const archived = await (
    await fetch(`${base}/api/memories/status`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ ids: [created.id], status: 'archived' })
    })
  ).json()
  assert.equal(archived.ok, true)
  const archivedList = await (
    await fetch(`${base}/api/memories?status=archived`, { headers: auth })
  ).json()
  assert.equal(archivedList.memories.length, 1)
  const removed = await (
    await fetch(`${base}/api/memories/remove`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ ids: [created.id] })
    })
  ).json()
  assert.equal(removed.ok, true)
  const gone = await (await fetch(`${base}/api/memories?status=archived`, { headers: auth })).json()
  assert.equal(gone.memories.length, 0)

  // 蒸馏状态 / 设置
  const state = await (await fetch(`${base}/api/distill`, { headers: auth })).json()
  assert.equal(state.ok, true)
  assert.equal(state.models[0].id, 'test/model')
  assert.equal(state.inject, false)
  assert.deepEqual(state.injectAgents, [])
  assert.equal(state.injectAll, true)
  assert.ok(Array.isArray(state.agents))
  const patched = await (
    await fetch(`${base}/api/distill`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ on: true, model: 'test/model', days: 30, autoDigest: true })
    })
  ).json()
  assert.equal(patched.on, true)
  assert.equal(patched.days, 30)
  assert.equal(patched.autoDigest, true)

  // 记忆注入：默认关，可开并指定 agent
  const injecting = await (
    await fetch(`${base}/api/distill`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ inject: true, injectAgents: ['zcode', 'claudecode'] })
    })
  ).json()
  assert.equal(injecting.inject, true)
  assert.deepEqual(injecting.injectAgents, ['zcode', 'claudecode'])
  assert.equal(injecting.injectAll, false)

  // 不带 token 的 POST 被拒
  const unauthorized = await fetch(`${base}/api/memories`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'x', kind: 'fact' })
  })
  assert.equal(unauthorized.status, 401)
})

test('页面搜索返回结构化命中；会话可从页面删除', async (t) => {
  resetBackend()
  const pagePort = 40000 + Math.floor(Math.random() * 400)
  const svc = startService({ pagePort, backend: 'embedded', dataDir: ':memory:', llm })
  t.after(() => {
    stopService()
    resetBackend()
  })
  const port = await svc.ready
  const base = `http://127.0.0.1:${port}`
  const html = await (await fetch(`${base}/`)).text()
  const token = html.match(/name="memorysql-token" content="([^"]+)"/)?.[1]
  const auth = { 'x-memorysql-token': token, 'content-type': 'application/json' }

  // 页面服务与测试共用同一个 embedded 后端实例（getBackend 的缓存 key 相同）
  const backend = await getBackend({ backend: 'embedded', dataDir: ':memory:', llm })
  const imported = JSON.parse(
    await backend.call('memory_import_session', {
      agent: 'zcode',
      externalId: 'svc-del',
      cwd: 'H:/work/demo',
      title: '页面里的搜索和删除',
      messages: [
        { role: 'user', content: '搜索框输入插件没有结果' },
        { role: 'assistant', content: '因为 token 过期，页面重载即可。' }
      ]
    })
  )

  const search = await (
    await fetch(`${base}/api/search?q=${encodeURIComponent('搜索')}`, { headers: auth })
  ).json()
  assert.equal(search.ok, true)
  assert.ok(Array.isArray(search.hits))
  assert.ok(search.hits.some((hit) => hit.sessionId === imported.id && hit.kind === 'message'))

  const removed = await (
    await fetch(`${base}/api/sessions/remove`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ ids: [imported.id] })
    })
  ).json()
  assert.equal(removed.ok, true)
  assert.equal(removed.count, 1)

  const sessions = await (await fetch(`${base}/api/sessions?limit=10`, { headers: auth })).json()
  assert.equal(sessions.sessions.length, 0)
  const after = await (
    await fetch(`${base}/api/search?q=${encodeURIComponent('搜索')}`, { headers: auth })
  ).json()
  assert.equal(after.hits.length, 0)
})
