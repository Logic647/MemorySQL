import test from 'node:test'
import assert from 'node:assert/strict'
import { onRequest, onResponse, reset } from '../hooks.mjs'
import { resetEndpointCache } from '../lib/endpoint.mjs'
import { fakeMemorySQL } from './helpers.mjs'

function options(port, extra = {}) {
  return {
    port,
    recall: true,
    capture: false,
    gatewayTimeoutMs: 1500,
    maxBytes: 6000,
    skipAgents: [],
    ...extra
  }
}

function ctx(port, extra = {}) {
  return {
    protocol: 'chat',
    agent: 'Claude Code',
    session: 's1',
    cwd: 'H:/work/demo',
    origin: 'local',
    options: options(port),
    signal: new AbortController().signal,
    state: {},
    report: () => {},
    ...extra
  }
}

test('recall 注入一次并缓存续接包', async (t) => {
  let contextCalls = 0
  const fake = await fakeMemorySQL({
    memory_get_context: () => {
      contextCalls++
      return '# MemorySQL 续接上下文\n- 项目: demo'
    }
  })
  t.after(() => fake.close())
  reset()
  resetEndpointCache()

  const c = ctx(fake.port)
  const body1 = { messages: [{ role: 'user', content: 'hello' }] }
  const out1 = await onRequest(body1, c)
  assert.ok(out1)
  assert.match(out1.messages[0].content, /<memorysql-context>/)
  assert.equal(contextCalls, 1)

  // 同一 session 的下一轮：复用缓存块，不再打 MemorySQL
  const body2 = {
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'next' }
    ]
  }
  const out2 = await onRequest(body2, c)
  assert.ok(out2)
  assert.match(out2.messages[0].content, /<memorysql-context>/)
  assert.equal(contextCalls, 1)
})

test('skipAgents 与远程 origin 默认不注入', async (t) => {
  let calls = 0
  const fake = await fakeMemorySQL({
    memory_get_context: () => {
      calls++
      return '# ctx'
    }
  })
  t.after(() => fake.close())
  reset()
  resetEndpointCache()

  const body = { messages: [{ role: 'user', content: 'hello' }] }
  const skipped = ctx(fake.port, { agent: 'Mozilla', options: options(fake.port, { skipAgents: ['mozilla'] }) })
  assert.equal(await onRequest(body, skipped), undefined)

  const remote = ctx(fake.port, { origin: 'remote' })
  assert.equal(await onRequest(body, remote), undefined)

  const subagent = ctx(fake.port, { kind: 'subagent' })
  assert.equal(await onRequest(body, subagent), undefined)

  assert.equal(calls, 0)
})

test('capture 回写的是客户端原始历史（不含注入块）', async (t) => {
  let imported = null
  const fake = await fakeMemorySQL({
    memory_get_context: () => '# ctx',
    memory_import_session: (args) => {
      imported = args
      return '{"id":1,"outcome":"imported"}'
    }
  })
  t.after(() => fake.close())
  reset()
  resetEndpointCache()

  const c = ctx(fake.port, { options: options(fake.port, { capture: true }) })
  const body = { messages: [{ role: 'user', content: 'hello' }] }
  const out = await onRequest(body, c)
  assert.ok(out)
  await onResponse({ choices: [{ message: { content: 'the answer' } }] }, c)

  assert.ok(imported)
  assert.equal(imported.agent, 'claudecode')
  assert.equal(imported.externalId, 's1')
  assert.equal(imported.cwd, 'H:/work/demo')
  assert.deepEqual(
    imported.messages.map((m) => [m.role, m.content]),
    [
      ['user', 'hello'],
      ['assistant', 'the answer']
    ]
  )
  assert.ok(!JSON.stringify(imported).includes('<memorysql-context>'))
})

test('capture 默认关：不调用 import', async (t) => {
  let imports = 0
  const fake = await fakeMemorySQL({
    memory_get_context: () => '# ctx',
    memory_import_session: () => {
      imports++
      return '{}'
    }
  })
  t.after(() => fake.close())
  reset()
  resetEndpointCache()

  const c = ctx(fake.port)
  const body = { messages: [{ role: 'user', content: 'hello' }] }
  await onRequest(body, c)
  await onResponse({ choices: [{ message: { content: 'answer' } }] }, c)
  assert.equal(imports, 0)
})

test('MemorySQL 不在线时 fail open', async (t) => {
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('ECONNREFUSED')
  }
  t.after(() => {
    globalThis.fetch = original
  })
  reset()
  resetEndpointCache()

  const reports = []
  const c = ctx(1, { report: (code) => reports.push(code) })
  const body = { messages: [{ role: 'user', content: 'hello' }] }
  assert.equal(await onRequest(body, c), undefined)
  assert.ok(reports.includes('unavailable'))
})
