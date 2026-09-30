import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { resolveHermesHome, stripQuotes } from '../src/plugins/capture-hermes/resolve-home'
import { checkOne, runChecks } from '../upstream/check'
import { AGENTS } from '../src/shared/upstream-agents'

/**
 * Hermes 探测链的三条不变式。
 *
 * 背景:2026-09-30 黑盒对 hermes 长期报「本机未检测到源(非故障)」,而用户
 * 明明装在 D 盘、state.db 有 15MB。两处叠加造成:
 *   ① resolveHome 住在插件 index 里,而那个文件 import 了 sqlite-ro →
 *      better-sqlite3 原生模块;check.ts 的动态 import 又漏了 `.ts` 扩展名,
 *      于是 import 必然抛 ERR_MODULE_NOT_FOUND
 *   ② 抛出的异常被 resolveRoot 的 `catch {}` 吞掉,注释写着「resolver 失败
 *      视为未找到」—— 把「工具坏了」翻译成了「用户没装」
 *
 * 后果不是报错,而是一个装着、有真实数据、正在用的 agent 被当成"未验证",
 * 看板上的盲区白白留着。**这两条都必须锁住,否则会以别的形式复发。**
 */

describe('resolveHermesHome 探测链', () => {
  it('注册表 InstallLocation 带引号时也能命中(实测本机就是 "D:\\Hermes..." 这种)', () => {
    // 旧实现把引号 strip 掉后才拼路径;若调用方自己拼,带引号会得到非法路径且
    // existsSync 恒 false,没有任何提示。现在两层都试,先试去引号版。
    const hit = resolveHermesHome(
      undefined,
      (p) => p === 'D:\\Hermes Agent CN Desktop\\data\\hermes-home',
      () => '"D:\\Hermes Agent CN Desktop"'
    )
    expect(hit).toBe('D:\\Hermes Agent CN Desktop\\data\\hermes-home')
  })

  it('注册表无引号时同样命中', () => {
    const hit = resolveHermesHome(
      undefined,
      (p) => p === 'D:\\Hermes Agent CN Desktop\\data\\hermes-home',
      () => 'D:\\Hermes Agent CN Desktop'
    )
    expect(hit).toBe('D:\\Hermes Agent CN Desktop\\data\\hermes-home')
  })

  it('configured 存在时优先用它', () => {
    const hit = resolveHermesHome('E:\\custom\\hermes-home', (p) => p === 'E:\\custom\\hermes-home', () => null)
    expect(hit).toBe('E:\\custom\\hermes-home')
  })

  it('全都没有时返回原样的 configured(不返回 undefined,调用方据此判断"从未成功过")', () => {
    expect(resolveHermesHome('E:\\gone', () => false, () => null)).toBe('E:\\gone')
  })

  it('盘符扫描在注册表失败时仍能工作', () => {
    const hit = resolveHermesHome(
      undefined,
      (p) => p === 'F:\\Hermes Agent CN Desktop\\data\\hermes-home',
      () => null
    )
    expect(hit).toBe('F:\\Hermes Agent CN Desktop\\data\\hermes-home')
  })

  it('stripQuotes 只脱成对引号', () => {
    expect(stripQuotes('"D:\\x"')).toBe('D:\\x')
    expect(stripQuotes('D:\\x')).toBe('D:\\x')
    expect(stripQuotes('"')).toBe('"')
    expect(stripQuotes('  "D:\\x"  ')).toBe('D:\\x')
  })
})

describe('探测链与 sqlite 解耦(这正是当初失效的根因)', () => {
  it('resolve-home.ts 不得 import 任何 sqlite / electron / plugin-host', () => {
    const src = fs.readFileSync(
      new URL('../src/plugins/capture-hermes/resolve-home.ts', import.meta.url),
      'utf8'
    )
    const imports = [...src.matchAll(/^\s*import\s+(?!type\s)([^\n]+)/gm)].map((m) => m[1])
    for (const line of imports) {
      expect(line, `探测链不得依赖 ${line}`).not.toMatch(/sqlite|electron|plugin-host|better-sqlite3/)
    }
  })

  it('check.ts 的 hermes resolver 只能 import resolve-home,且必须带 .ts 扩展名', () => {
    const src = fs.readFileSync(new URL('../upstream/check.ts', import.meta.url), 'utf8')
    // 动态 import 缺 .ts 扩展名 → Node ESM 直接 ERR_MODULE_NOT_FOUND,
    // 而该异常曾被吞成「未找到」,于是装着也报没装
    const dyn = [...src.matchAll(/await import\('([^']+)'\)/g)].map((m) => m[1])
    expect(dyn.length).toBeGreaterThan(0)
    for (const spec of dyn) {
      expect(spec, `动态 import 缺扩展名:${spec}`).toMatch(/\.ts$/)
      expect(spec, `resolver 不该导入插件 index:${spec}`).not.toMatch(/capture-hermes\/index/)
    }
    expect(dyn.some((s) => s.includes('resolve-home'))).toBe(true)
  })
})

describe('解析器故障不得被记成「本机未装」', () => {
  it('源码里不能存在把 resolver 异常吞掉的 catch', () => {
    const src = fs.readFileSync(new URL('../upstream/check.ts', import.meta.url), 'utf8')
    // resolveRoot 的 catch 必须带 error 字段上抛,而不是空的
    expect(src).not.toMatch(/catch\s*\{\s*\/\*[^*]*resolver 失败视为未找到/)
    expect(src).toMatch(/error: `resolver <\$\{r\.resolver\}> 失败/)
  })

  it('absent 的措辞不得再说「非故障」——那句话会掩盖探测从未成功', async () => {
    // 测**运行时行为**而不是扫源码文本:文档注释里引用旧措辞来解释问题是合理的,
    // 真正要保证的是别再把这句话发给使用者。
    const qoder = AGENTS.find((a) => a.id === 'qoder')! // 本机没装,必然走 absent 分支
    const r = await checkOne(qoder)
    expect(r.verdict).toBe('blackbox_only')
    expect(r.detail).toContain('探测已正常执行,不是故障')
    expect(r.detail).not.toContain('(非故障)')
  })

  it('checkOne 对 hermes 走真实探测链,不再退化成 absent', async () => {
    const h = AGENTS.find((a) => a.id === 'hermes')!
    const r = await checkOne(h)
    // 无论本机装没装,都**不能**是 checker_error:那条 import 链现在是通的
    expect(r.verdict).not.toBe('checker_error')
  })
})

describe('黑盒仍能跑完(回归护栏)', () => {
  it('runChecks 对 hermes 不抛异常,且 verdict 属于已知集合', async () => {
    const [r] = await runChecks(['hermes'])
    expect(['ok', 'drift', 'checker_error', 'absent', 'blackbox_only']).toContain(r.verdict)
    expect(r.detail).toBeTruthy()
  })

  it('hermes 台账的 sqlite 契约仍与真实布局一致(sessions/messages)', () => {
    const h = AGENTS.find((a) => a.id === 'hermes')!
    expect(h.source.kind).toBe('sqlite')
    const spec = h.source as { sqlite: { tablesAnyOf: string[][]; requiredColumns: Record<string, string[]> } }
    expect(spec.sqlite.tablesAnyOf[0]).toEqual(['sessions', 'messages'])
    // 这两列是本项目解析时真正读的,少一列就会静默解析出空内容
    expect(spec.sqlite.requiredColumns.sessions).toContain('id')
    expect(spec.sqlite.requiredColumns.messages).toContain('session_id')
  })
})
