import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { probeHealthView, LATE_AFTER_HOURS, LOST_AFTER_HOURS } from '../tools/upstream-watch/probe-health.mjs'

/**
 * 黑盒探针中心:源心跳健康 + /probe 聚合页 + 统一登录。
 *
 * 心跳是整个聚合平台的底线功能:黑盒监控的价值建立在「探针每天真的在上报」
 * 上,NAS 断电 / cron 被清 / 开发机计划任务错过(实测发生过)都会让看板停在
 * 最后一份数据上照常发绿。探针失联必须自己长一张红脸。
 */

const NOW = new Date('2026-10-25T12:00:00Z')

describe('probeHealthView — 心跳阈值', () => {
  const src = (hoursAgo: number, count = 12) => ({
    checkedAt: new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString(),
    results: Array.from({ length: count }, () => ({ id: 'x', verdict: 'ok' }))
  })

  it('默认阈值 36h/72h(对齐每日一跑 + 余量)', () => {
    expect(LATE_AFTER_HOURS).toBe(36)
    expect(LOST_AFTER_HOURS).toBe(72)
  })

  it('当天内上报 = ok;错过一整天 = late;超过两天 = lost', () => {
    const v = probeHealthView({ a: src(2), b: src(40), c: src(80) }, NOW)
    expect(v.a.state).toBe('ok')
    expect(v.b.state).toBe('late')
    expect(v.c.state).toBe('lost')
    expect(v.a.ageHours).toBe(2)
  })

  it('空上报单独一态 empty(探针活着但交白卷,与失联处置不同)', () => {
    const v = probeHealthView({ a: { checkedAt: new Date(NOW.getTime() - 3600_000).toISOString(), results: [] } }, NOW)
    expect(v.a.state).toBe('empty')
    expect(v.a.ageHours).toBeNull()
  })

  it('缺 checkedAt / 坏时间戳 / null 源都归 empty,不抛异常', () => {
    const v = probeHealthView({ a: { results: [1] }, b: { checkedAt: 'not-a-date', results: [1] }, c: null }, NOW)
    expect(v.a.state).toBe('empty')
    expect(v.b.state).toBe('empty')
    expect(v.c.state).toBe('empty')
  })

  it('阈值可被测试覆盖', () => {
    const v = probeHealthView({ a: src(10) }, NOW, { lateAfterHours: 8, lostAfterHours: 16 })
    expect(v.a.state).toBe('late') // 8h < 10h < 16h
  })

  it('空对象返回空视图', () => {
    expect(probeHealthView({}, NOW)).toEqual({})
    expect(probeHealthView(undefined as never, NOW)).toEqual({})
  })
})

describe('边界澄清:≤lateAfter 是 ok', () => {
  it('恰好 36h 仍算 ok(给 cron 抖动留余量)', () => {
    const at = new Date(NOW.getTime() - 36 * 3600_000).toISOString()
    const v = probeHealthView({ a: { checkedAt: at, results: [1] } }, NOW)
    expect(v.a.state).toBe('ok')
  })
})

describe('冒烟:真服务 /probe 页 + probeHealth 注入 /api/state', () => {
  it('双源上报后 /api/state 带 probeHealth;/probe 返回聚合页;两页互链', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msql-probe-center-'))
    const authToken = `test-${randomBytes(12).toString('hex')}`
    const env = {
      ...process.env,
      PORT: '0',
      AUTH_TOKEN: authToken,
      STATE_PATH: path.join(dataDir, 'state.json'),
      LEDGER_PATH: path.join(process.cwd(), 'upstream', 'ledger.json'),
      LLM_API_KEY: '',
      REFRESH_HOURS: '9999'
    }
    const SERVER = path.join(process.cwd(), 'tools', 'upstream-watch', 'server.mjs')
    const child = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    const out: string[] = []
    child.stdout.on('data', (d) => out.push(String(d)))
    child.stderr.on('data', (d) => out.push(String(d)))

    try {
      const deadline = Date.now() + 15000
      let port = 0
      while (Date.now() < deadline) {
        const m = out.join('').match(/127\.0\.0\.1:(\d+)/)
        if (m) { port = Number(m[1]); break }
        await new Promise((r) => setTimeout(r, 200))
      }
      expect(port, '服务应在 15 秒内报出端口').toBeGreaterThan(0)
      const base = `http://127.0.0.1:${port}`
      const auth = { Authorization: `Bearer ${authToken}` }

      // 无 token:/probe 也要吃 401(聚合页与主看板同一道鉴权 = 统一登录的前提)
      expect((await fetch(base + '/probe')).status).toBe(401)
      // POST /probe 不是读页面 → 404,不许又出现「误 POST 得 200」的老坑
      expect((await fetch(base + '/probe', { method: 'POST', headers: auth })).status).toBe(404)

      // 双源上报
      const post = (p: string, body: unknown) =>
        fetch(base + p, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...auth },
          body: JSON.stringify(body)
        })
      await post('/api/probe', { source: 'dev', checkedAt: new Date().toISOString(), results: [{ id: 'zcode', verdict: 'ok', detail: '' }] })
      await post('/api/probe', { source: 'nas', checkedAt: new Date().toISOString(), results: [{ id: 'qoder', verdict: 'ok', detail: '', version: '1.1.78' }] })

      const st = (await fetch(base + '/api/state', { headers: auth }).then((r) => r.json())) as {
        probeHealth: Record<string, { state: string; count: number }>
      }
      // 刚上报的两个源都是 ok 心跳
      expect(st.probeHealth.dev).toMatchObject({ state: 'ok', count: 1 })
      expect(st.probeHealth.nas).toMatchObject({ state: 'ok', count: 1 })

      // 聚合页:200 + 关键渲染逻辑存在 + 判定矩阵/心跳/登录的标志串
      const page = await fetch(base + '/probe', { headers: auth })
      expect(page.status).toBe(200)
      const html = await page.text()
      expect(html).toContain('黑盒探针中心')
      expect(html).toContain('renderMatrix')
      expect(html).toContain('probeHealth')
      expect(html).toContain("localStorage.setItem('msql_token'") // 统一登录:同主看板一个键
      expect(html).toContain('stale') // 登录态(🟠)面板

      // 内联脚本必须可编译 —— 页面 JS 没有 typecheck/bundler 把关,
      // 一个语法错就是整页空白(DEVLOG 里记过同类事故)。
      // 用子进程 `node --check` 只解析不执行;不用 new Function/eval ——
      // 那是动态代码执行 sink,会被安全扫描正确地拦下。
      const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? ''
      expect(script.length, '应能取到 <script> 段').toBeGreaterThan(100)
      const tmp = path.join(dataDir, 'probe-page.js')
      fs.writeFileSync(tmp, script, 'utf-8')
      expect(() => execFileSync(process.execPath, ['--check', tmp]), 'probe.html 内联脚本应无语法错误').not.toThrow()

      // 主看板与聚合页互链 + 主看板也有登录表单
      const main = await fetch(base + '/', { headers: auth }).then((r) => r.text())
      expect(main).toContain('./probe')
      expect(main).toContain('saveTok')
    } finally {
      child.kill()
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  }, 40000)
})
