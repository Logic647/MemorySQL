import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { parseEnvFile, findLoginTarget } from '../scripts/nas-panel.mjs'

/**
 * NAS 探针面板(统一登录 + 上报监测)。
 *
 * 面板能从浏览器触发命令执行,所以最重要的断言是**边界**而不是功能:
 *   1. 登录只可能命中白名单表(POST id → LOGIN_TARGETS),不存在任意命令路径
 *   2. /api/proc 的 key 只允许 login:<id> | probe 两种形态(防把面板当文件读器)
 *   3. /api/report 的 file 只允许 <日期>.md / discover-<stamp>.md 基名(防路径穿越)
 *   4. 内联页面脚本可编译(HTML 无 typecheck 把关,语法错=整页空白)
 * 凭据只经内存注入子进程,面板任何接口都不回显 token。
 */

describe('parseEnvFile', () => {
  it('解析 KEY=VALUE,忽略注释与空行', () => {
    const env = parseEnvFile('# 注释\nA=https://x/y\n\nB=with=equals\n')
    expect(env).toEqual({ A: 'https://x/y', B: 'with=equals' })
  })
  it('行内注释按 bash 语义剥(` #` 之后),URL 不受损', () => {
    const env = parseEnvFile('A=https://x/y  # 说明文字\nB=https://x/z#fragment\n')
    // B 的 # 前没有空格 = 不是注释(bash 同语义),URL fragment 保留
    expect(env).toEqual({ A: 'https://x/y', B: 'https://x/z#fragment' })
  })
  it('空输入/坏行不炸,返回空对象或跳过', () => {
    expect(parseEnvFile('')).toEqual({})
    expect(parseEnvFile('novalue\n=x\nA=1')).toEqual({ A: '1' })
  })
})

describe('登录白名单', () => {
  it('表内 id 命中,其余一律 null', () => {
    expect(findLoginTarget('qoder')?.loginCmd).toEqual(['qoder', 'login'])
    expect(findLoginTarget('kimicli')?.label).toBe('Kimi Code')
    expect(findLoginTarget('nosuch')).toBeNull()
    // 命令注入的常见形态必须进不了白名单
    expect(findLoginTarget('qoder; rm -rf /')).toBeNull()
    expect(findLoginTarget('')).toBeNull()
    expect(findLoginTarget('$(whoami)')).toBeNull()
  })
  /**
   * 看守表在 scripts/nas-targets.mjs 是单一真相源。2026-11-10 踩过:
   * 探针表加了 copilot/droid,面板的登录表还停在 5 家 —— 新装的两家点不到。
   * 这条用例从面板 API 侧断言"面板能看到全部看守家"。
   */
  it('面板覆盖看守表全部家:copilot 可一键登录,droid 只能 SSH(TUI 认证)', () => {
    for (const t of ['qoder', 'codebuddy', 'copilot', 'qwencode', 'gemini', 'kimicli']) {
      const hit = findLoginTarget(t)!
      expect(Array.isArray(hit.loginCmd), `${t} 应有非交互登录命令`).toBe(true)
      expect(hit.loginCmd!.length).toBeGreaterThan(1)
      expect(hit.sshFallback.length).toBeGreaterThan(0)
    }
    // droid 没有 login 子命令(--help 只有 resume/exec/daemon/search/update/mcp/...)
    const droid = findLoginTarget('droid')!
    expect(droid.loginCmd, 'droid 不该被硬塞一个不存在的 login 命令').toBeNull()
    expect(droid.sshFallback).toContain('TUI')
  })
})

describe('冒烟:面板服务起来后,边界与页面', () => {
  it('白名单外的 login id 拒 400;/api/proc 坏 key 拒 400;页面 200 且可编译', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msql-nas-panel-'))
    // 面板自身状态文件放在临时目录,别碰开发机(面板 import 即启动 http?
    // 不会:server.listen 只在 isMain 分支 —— 这里 spawn 起真进程测)
    const PANEL = path.join(process.cwd(), 'scripts', 'nas-panel.mjs')
    const env = {
      ...process.env,
      PANEL_PORT: '0',
      PANEL_BIND: '127.0.0.1',
      NAS_PROBE_STATE_DIR: path.join(dataDir, 'state'),
      NAS_REPORT_DIR: path.join(dataDir, 'reports'),
      PANEL_TOKEN: ''
    }
    const child = spawn(process.execPath, [PANEL], { env, stdio: ['ignore', 'pipe', 'pipe'] })
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
      expect(port, '面板应在 15 秒内报出端口').toBeGreaterThan(0)
      const base = `http://127.0.0.1:${port}`

      // 状态接口:无状态文件时给空态而不是 500(首次运行前 versions.json 不存在)
      const st = (await fetch(base + '/api/state').then((r) => r.json())) as {
        lastRun: unknown
        targets: Array<{ id: string }>
        reports: unknown[]
      }
      expect(st.lastRun).toBeNull()
      expect(st.targets).toHaveLength(7) // 看守表 7 家(targets 与探针同源)
      expect(st.reports).toEqual([])

      // 白名单外/注入形态的 login id → 400,绝不 spawn
      for (const bad of ['nosuch', 'qoder; rm -rf /', '../x', '']) {
        const r = await fetch(base + '/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: bad })
        })
        expect(r.status, `id=${bad} 应被拒`).toBe(400)
      }

      // 交互式登录的家(droid)必须明确拒绝并给出 SSH 指引,不能硬 spawn 一个卡住的 TUI
      const droidRes = await fetch(base + '/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'droid' })
      })
      expect(droidRes.status).toBe(400)
      expect(((await droidRes.json()) as { error: string; hint?: string }).error).toBe('interactive-only')

      // /api/proc 只认两种 key 形态
      for (const bad of ['', 'login:', 'probe;rm', 'login:qoder extra', 'cat:/etc/passwd']) {
        const r = await fetch(base + '/api/proc?key=' + encodeURIComponent(bad))
        expect(r.status, `key=${bad} 应被拒`).toBe(400)
      }

      // /api/report 文件名白名单(防穿越);发现器报告 discover-<stamp>.md 也要能开
      expect((await fetch(base + '/api/report?file=' + encodeURIComponent('../../probe.env'))).status).toBe(400)
      expect((await fetch(base + '/api/report?file=2026-10-25.md')).status).toBe(404) // 不存在但形态合法
      expect((await fetch(base + '/api/report?file=discover-2026-11-10-05-12-51.md')).status).toBe(404) // 形态合法
      expect((await fetch(base + '/api/report?file=discover-../x.md')).status).toBe(400) // 仍不许穿越

      // 页面 200 + 内联脚本可编译(子进程 node --check,只解析不执行)
      const html = await fetch(base + '/').then((r) => r.text())
      expect(html).toContain('NAS 黑盒探针面板')
      const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? ''
      expect(script.length, '应能取到 <script> 段').toBeGreaterThan(200)
      const tmp = path.join(dataDir, 'panel-page.js')
      fs.writeFileSync(tmp, script, 'utf-8')
      expect(() => execFileSync(process.execPath, ['--check', tmp]), '面板内联脚本应无语法错误').not.toThrow()
    } finally {
      child.kill()
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  }, 40000)
})

describe('随机 token 鉴权(设了 PANEL_TOKEN 才启用)', () => {
  it('无 token 401,带对 token 200', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msql-nas-panel-auth-'))
    const tok = `t-${randomBytes(8).toString('hex')}`
    const PANEL = path.join(process.cwd(), 'scripts', 'nas-panel.mjs')
    const child = spawn(process.execPath, [PANEL], {
      env: {
        ...process.env,
        PANEL_PORT: '0',
        PANEL_BIND: '127.0.0.1',
        PANEL_TOKEN: tok,
        NAS_PROBE_STATE_DIR: path.join(dataDir, 'state'),
        NAS_REPORT_DIR: path.join(dataDir, 'reports')
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const out: string[] = []
    child.stdout.on('data', (d) => out.push(String(d)))
    try {
      const deadline = Date.now() + 15000
      let port = 0
      while (Date.now() < deadline) {
        const m = out.join('').match(/127\.0\.0\.1:(\d+)/)
        if (m) { port = Number(m[1]); break }
        await new Promise((r) => setTimeout(r, 200))
      }
      expect(port).toBeGreaterThan(0)
      const base = `http://127.0.0.1:${port}`
      expect((await fetch(base + '/api/state')).status).toBe(401)
      expect((await fetch(base + '/api/state', { headers: { Authorization: `Bearer ${tok}` } })).status).toBe(200)
    } finally {
      child.kill()
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  }, 40000)
})
