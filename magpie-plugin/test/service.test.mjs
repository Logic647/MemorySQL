import test from 'node:test'
import assert from 'node:assert/strict'
import { startService, stopService } from '../service.mjs'
import { resetEndpointCache } from '../lib/endpoint.mjs'
import { fakeMemorySQL } from './helpers.mjs'

test('页面服务：状态/项目/静态页/来源校验', async (t) => {
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

  const status = await (await fetch(`${base}/api/status`)).json()
  assert.equal(status.ok, true)
  assert.equal(status.stats.sessions, 7)
  assert.equal(status.version, '0.7.8')

  const projects = await (await fetch(`${base}/api/projects`)).json()
  assert.equal(projects.ok, true)
  assert.equal(projects.projects[0].name, 'Demo')

  const page = await fetch(`${base}/`)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /MemorySQL/)

  const unknown = await fetch(`${base}/api/nope`)
  assert.equal(unknown.status, 404)

  const foreign = await fetch(`${base}/api/status`, { headers: { origin: 'https://evil.example' } })
  assert.equal(foreign.status, 403)
})
