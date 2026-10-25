import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mergeProbes } from '../tools/upstream-watch/merge-probes.mjs'
import { applyFreshness, scanLatestMtime } from '../tools/upstream-watch/nas-freshness.mjs'

/**
 * 多源探针合并 + NAS 数据新鲜度降级。
 *
 * 背景:闭源 agent 只有 NAS 装了,开发机专属五家只有开发机装了 —— 两边各是
 * 另一半真相。/api/probe 若仍是单槽位,后上报的一方会把前者整个冲掉。
 * 这组测试锁三件事:
 *   1. 合并按 verdict 优先级,不是按时间 —— NAS 的 🟢 不能盖住 dev 的 🔴,
 *      NAS 的 🟢 要能覆盖 dev 的 ⚪(后者正是 NAS 探针存在的意义)
 *   2. 新鲜度降级:agent 升级了但没跑出新会话时,旧数据上的 🟢 必须变 🟠 ——
 *      否则看板会把"三个月前的格式"当成"当前版本已验证"(最危险的假阴性)
 *   3. 真服务双源上报互不覆盖,旧格式 payload(无 source 字段)兼容
 */

describe('mergeProbes — 按 agent 合并,verdict 优先级高于时间', () => {
  it('NAS 的 ok 覆盖 dev 的 blackbox_only(闭源五家的核心价值)', () => {
    const m = mergeProbes({
      dev: {
        checkedAt: '2026-01-02T00:00:00Z',
        ledgerHash: 'h1',
        results: [{ id: 'qoder', verdict: 'blackbox_only', detail: '本机未检测到源' }]
      },
      nas: {
        checkedAt: '2026-01-01T00:00:00Z',
        ledgerHash: 'h1',
        results: [{ id: 'qoder', verdict: 'ok', detail: '布局匹配', version: '1.0' }]
      }
    })!
    // dev 的时间更新,但 blackbox_only 是"没数据"档,ok 是"有结论"档 ——
    // 优先级必须压过时间,否则 NAS 白跑
    expect(m.results[0].verdict).toBe('ok')
    expect(m.results[0].src).toBe('nas')
    expect(m.results[0].version).toBe('1.0')
  })

  it('dev 的 drift 不被 NAS 的 ok 掩盖(优先级 > 时间)', () => {
    const m = mergeProbes({
      dev: {
        checkedAt: '2026-01-01T00:00:00Z',
        results: [{ id: 'zcode', verdict: 'drift', detail: '表结构对不上' }]
      },
      nas: {
        checkedAt: '2026-01-02T00:00:00Z',
        results: [{ id: 'zcode', verdict: 'ok', detail: '布局匹配' }]
      }
    })!
    expect(m.results[0].verdict).toBe('drift')
    expect(m.results[0].src).toBe('dev')
  })

  it('同级取 checkedAt 较新者', () => {
    const m = mergeProbes({
      dev: {
        checkedAt: '2026-01-01T00:00:00Z',
        results: [{ id: 'codex', verdict: 'ok', detail: 'dev 旧' }]
      },
      nas: {
        checkedAt: '2026-01-02T00:00:00Z',
        results: [{ id: 'codex', verdict: 'ok', detail: 'nas 新' }]
      }
    })!
    expect(m.results[0].detail).toBe('nas 新')
    expect(m.results[0].src).toBe('nas')
  })

  it('两源各自的 agent 都保留(各是另一半真相)', () => {
    const m = mergeProbes({
      dev: {
        checkedAt: '2026-01-01T00:00:00Z',
        results: [
          { id: 'zcode', verdict: 'ok', detail: '' },
          { id: 'opencode', verdict: 'ok', detail: '' }
        ]
      },
      nas: {
        checkedAt: '2026-01-01T00:00:00Z',
        results: [
          { id: 'qoder', verdict: 'ok', detail: '' },
          { id: 'codebuddy', verdict: 'ok', detail: '' }
        ]
      }
    })!
    expect(m.results.map((r) => r.id).sort()).toEqual(['codebuddy', 'opencode', 'qoder', 'zcode'])
  })

  it('空 results 的上报不参与代表权 —— 顶不掉时间与指纹', () => {
    // 一次失败的探测若能顶掉面板时间和指纹,"上报于刚刚"底下就是旧数据,
    // 又是"看起来有结论其实缺失"一族
    const m = mergeProbes({
      dev: {
        checkedAt: '2026-01-01T00:00:00Z',
        ledgerHash: 'h-real',
        results: [{ id: 'zcode', verdict: 'ok', detail: '' }]
      },
      nas: { checkedAt: '2026-01-02T00:00:00Z', ledgerHash: 'h-empty', results: [] }
    })!
    expect(m.checkedAt).toBe('2026-01-01T00:00:00Z')
    expect(m.ledgerHash).toBe('h-real')
  })

  it('没有任何有效结果时返回 null(调用方保留旧视图)', () => {
    expect(mergeProbes({})).toBeNull()
    expect(mergeProbes({ dev: { checkedAt: 'x', results: [] } })).toBeNull()
    expect(mergeProbes(undefined as never)).toBeNull()
  })

  it('结果缺 id 的垃圾条目被丢弃', () => {
    const m = mergeProbes({
      dev: { checkedAt: 'x', results: [{ verdict: 'ok' } as never, { id: 'ok-agent', verdict: 'ok', detail: '' }] }
    })!
    expect(m.results).toHaveLength(1)
    expect(m.results[0].id).toBe('ok-agent')
  })
})

describe('applyFreshness — 陈旧数据假阴性防线', () => {
  const R = (over: Record<string, unknown> = {}) => ({
    id: 'qoder',
    verdict: 'ok',
    detail: '布局匹配',
    ...over
  })

  it('数据早于版本更新时间 → stale,详情点名"可能登录过期"', () => {
    const { results, downgraded } = applyFreshness([R()], {
      qoder: {
        version: '2.0',
        updatedAt: '2026-01-03T10:00:00Z',
        dataAt: '2026-01-01T10:00:00Z'
      }
    })
    expect(downgraded).toEqual(['qoder'])
    expect(results[0].verdict).toBe('stale')
    expect(String(results[0].detail)).toContain('登录过期')
  })

  it('数据新于版本更新 → 保持 ok,并附上 version/dataAt', () => {
    const { results, downgraded } = applyFreshness([R()], {
      qoder: {
        version: '2.0',
        updatedAt: '2026-01-01T10:00:00Z',
        dataAt: '2026-01-03T10:00:00Z'
      }
    })
    expect(downgraded).toEqual([])
    expect(results[0].verdict).toBe('ok')
    expect(results[0].version).toBe('2.0')
    expect(results[0].dataAt).toBe('2026-01-03T10:00:00Z')
  })

  it('版本探测失败 → stale(无法确认数据出自当前版本,宁可黄也不假绿)', () => {
    const { results, downgraded } = applyFreshness([R()], {
      qoder: { version: null, updatedAt: null, dataAt: '2026-01-03T10:00:00Z', versionError: 'command not found' }
    })
    expect(downgraded).toEqual(['qoder'])
    expect(results[0].verdict).toBe('stale')
    expect(String(results[0].detail)).toContain('版本探测失败')
  })

  it('扫描不到数据文件 → stale(扫描根与台账不符,新鲜度无法确认)', () => {
    const { results } = applyFreshness([R()], {
      qoder: { version: '2.0', updatedAt: '2026-01-01T00:00:00Z', dataAt: null }
    })
    expect(results[0].verdict).toBe('stale')
  })

  it('drift / absent 不被降级逻辑触碰(它们本身就是结论)', () => {
    const { results, downgraded } = applyFreshness(
      [R({ verdict: 'drift' }), R({ id: 'zcode', verdict: 'absent' })],
      {
        qoder: { version: '2.0', updatedAt: '2026-01-03T00:00:00Z', dataAt: '2026-01-01T00:00:00Z' },
        zcode: { version: '1.0', updatedAt: null, dataAt: null }
      }
    )
    expect(downgraded).toEqual([])
    expect(results[0].verdict).toBe('drift')
    expect(results[1].verdict).toBe('absent')
  })

  it('未赞助的 agent(开发机专属)原样放行', () => {
    const { results } = applyFreshness([R({ id: 'hermes' })], {})
    expect(results[0]).toEqual(R({ id: 'hermes' }))
  })
})

describe('scanLatestMtime', () => {
  it('嵌套文件里取最新 mtime;根不存在返回 null', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msql-fresh-'))
    try {
      const sub = path.join(dir, 'projects', 'slug')
      fs.mkdirSync(sub, { recursive: true })
      const f1 = path.join(sub, 'a.jsonl')
      const f2 = path.join(sub, 'b.jsonl')
      fs.writeFileSync(f1, '{}\n')
      fs.writeFileSync(f2, '{}\n')
      const old = new Date('2026-01-01T00:00:00Z')
      const neu = new Date('2026-01-02T00:00:00Z')
      fs.utimesSync(f1, old, old)
      fs.utimesSync(f2, neu, neu)

      const got = scanLatestMtime(['projects'], dir)
      expect(got).toBe('2026-01-02T00:00:00.000Z')
      expect(scanLatestMtime(['no-such-root'], dir)).toBeNull()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('冒烟:真服务双源上报互不覆盖', () => {
  it('dev+nas 两次 POST 后合并视图正确,旧格式 payload 兼容', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msql-watch-merge-'))
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
      const post = (p: string, body: unknown) =>
        fetch(base + p, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
          body: JSON.stringify(body)
        })
      const getState = () =>
        fetch(base + '/api/state', { headers: { Authorization: `Bearer ${authToken}` } }).then((r) => r.json())

      // dev 上报:zcode ok(NAS 上没有 zcode),qoder 仍 blackbox_only
      const r1 = await post('/api/probe', {
        source: 'dev',
        checkedAt: '2026-01-01T00:00:00.000Z',
        ledgerHash: 'h1',
        results: [
          { id: 'zcode', verdict: 'ok', detail: 'dev 看 zcode' },
          { id: 'qoder', verdict: 'blackbox_only', detail: '本机未检测到源' }
        ]
      })
      expect(r1.status).toBe(200)
      expect(((await r1.json()) as { source?: string }).source).toBe('dev')

      // nas 上报:qoder ok(闭源五家由 NAS 看守);zcode 缺席
      const r2 = await post('/api/probe', {
        source: 'nas',
        checkedAt: '2026-01-02T00:00:00.000Z',
        ledgerHash: 'h1',
        results: [{ id: 'qoder', verdict: 'ok', detail: '布局匹配', version: '1.2.3', dataAt: '2026-01-02' }]
      })
      expect(r2.status).toBe(200)

      let st = await getState()
      const byId = new Map(
        (st.probe.results as Array<{ id: string; verdict: string; src?: string; version?: string }>).map((r) => [r.id, r])
      )
      expect(byId.get('qoder')).toMatchObject({ verdict: 'ok', src: 'nas', version: '1.2.3' })
      expect(byId.get('zcode')).toMatchObject({ verdict: 'ok', src: 'dev' })
      expect(st.probe.checkedAt).toBe('2026-01-02T00:00:00.000Z')
      expect(Object.keys(st.probeSources).sort()).toEqual(['dev', 'nas'])

      // 旧格式(无 source 字段,如升级前的开发机探针)→ 归入 dev,不炸、不清空
      const r3 = await post('/api/probe', {
        checkedAt: '2026-01-03T00:00:00.000Z',
        results: [{ id: 'zcode', verdict: 'ok', detail: 'dev 更新' }]
      })
      expect(r3.status).toBe(200)
      st = await getState()
      expect(Object.keys(st.probeSources).sort()).toEqual(['dev', 'nas'])
      const byId2 = new Map(
        (st.probe.results as Array<{ id: string; src?: string; detail?: string }>).map((r) => [r.id, r])
      )
      expect(byId2.get('zcode')?.src).toBe('dev')
      expect(byId2.get('zcode')?.detail).toBe('dev 更新')
      // nas 的 qoder 不因 dev 二次上报而消失
      expect(byId2.get('qoder')?.src).toBe('nas')

      // 空 results 的上报:存档但不清空看板
      const r4 = await post('/api/probe', { source: 'nas', checkedAt: '2026-01-04T00:00:00.000Z', results: [] })
      expect(r4.status).toBe(200)
      st = await getState()
      expect((st.probe.results as unknown[]).length).toBeGreaterThan(0)
    } finally {
      child.kill()
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  }, 40000)
})
