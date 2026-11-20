import test from 'node:test'
import assert from 'node:assert/strict'
import { startService, stopService } from '../service.mjs'
import { resetEndpointCache } from '../lib/endpoint.mjs'
import { fakeMemorySQL } from './helpers.mjs'

test('页面服务：状态/项目/静态页/token/CORS/来源校验', async (t) => {
  const fake = await fakeMemorySQL({
    memory_stats: () => JSON.stringify({ sessions: 7, memories: 9, projects: 2 }),
    memory_list_projects: () =>
      JSON.stringify([{ id: 1, name: 'Demo', path: 'H:/demo', sessions: 3, lastActive: 1700000000, digest: null }])
  })
  const pagePort = 39000 + Math.floor(Math.random() * 500)
  const svc = startService({ pagePort, port: fake.port, backend: 'app' })
  t.after(async () => {
    stopService()
    await fake.close()
  })
  resetEndpointCache()

  const port = await svc.ready
  assert.equal(port, pagePort)
  const base = `http://127.0.0.1:${port}`

  // 页面 HTML 注入 token（sandbox iframe 的 Origin 是 null，API 必须带它）
  const page = await fetch(`${base}/`)
  assert.equal(page.status, 200)
  const html = await page.text()
  assert.match(html, /MemorySQL/)
  const token = html.match(/name="memorysql-token" content="([^"]+)"/)?.[1]
  assert.ok(token && token.length >= 32)
  const auth = { 'x-memorysql-token': token }

  // 没 token → 401
  assert.equal((await fetch(`${base}/api/status`)).status, 401)

  // OPTIONS 预检（浏览器带自定义头会先发它）
  const preflight = await fetch(`${base}/api/status`, {
    method: 'OPTIONS',
    headers: {
      origin: 'null',
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'x-memorysql-token'
    }
  })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'null')

  const status = await (await fetch(`${base}/api/status`, { headers: auth })).json()
  assert.equal(status.ok, true)
  assert.equal(status.stats.sessions, 7)
  assert.equal(status.version, '0.7.8')

  const projects = await (await fetch(`${base}/api/projects`, { headers: auth })).json()
  assert.equal(projects.ok, true)
  assert.equal(projects.projects[0].name, 'Demo')

  const unknown = await fetch(`${base}/api/nope`, { headers: auth })
  assert.equal(unknown.status, 404)

  const foreign = await fetch(`${base}/api/status`, {
    headers: { ...auth, origin: 'https://evil.example' }
  })
  assert.equal(foreign.status, 403)
})
