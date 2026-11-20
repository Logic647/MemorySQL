import test from 'node:test'
import assert from 'node:assert/strict'
import { callTool, discoverEndpoint, resetEndpointCache } from '../lib/endpoint.mjs'
import { fakeMemorySQL } from './helpers.mjs'

test('发现运行中的 MemorySQL 并调用工具', async (t) => {
  const fake = await fakeMemorySQL({ memory_search: (args) => `found:${args.query}` })
  t.after(() => fake.close())
  resetEndpointCache()

  const found = await discoverEndpoint({ port: fake.port }, { scan: false })
  assert.ok(found)
  assert.equal(found.port, fake.port)
  assert.equal(found.version, '0.7.8')
  assert.equal(found.stats.sessions, 3)

  const text = await callTool('memory_search', { query: 'x' }, { port: fake.port })
  assert.equal(text, 'found:x')
  assert.equal(fake.calls.length, 1)
  assert.equal(fake.calls[0].params.name, 'memory_search')
})

test('工具错误以异常形式抛出', async (t) => {
  const fake = await fakeMemorySQL({
    memory_write: () => {
      throw new Error('写入失败')
    }
  })
  t.after(() => fake.close())
  resetEndpointCache()
  await assert.rejects(
    () => callTool('memory_write', { kind: 'fact', content: 'x' }, { port: fake.port }),
    /写入失败/
  )
})

test('没有 MemorySQL 时 discover 返回 null', async (t) => {
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('ECONNREFUSED')
  }
  t.after(() => {
    globalThis.fetch = original
  })
  resetEndpointCache()
  assert.equal(await discoverEndpoint({ port: 1 }, { scan: false }), null)
})
