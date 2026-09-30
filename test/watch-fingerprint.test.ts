import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { ledgerFingerprint, compareFingerprints } from '../tools/upstream-watch/fingerprint.mjs'
import { buildBrief } from '../tools/upstream-watch/summarize.mjs'

/**
 * 契约指纹 —— 防止「台账版本差」被误读成「上游漂移」。
 *
 * 白盒在云端算、黑盒在开发机算,两边各带一份 ledger.json。台账不一致时,
 * 「布局不匹配」可能只是版本差,而这个判断会直接触发一次适配发版 ——
 * 整个工具最不该出错的一处,以前却完全看不出来。
 */

interface Rec {
  [k: string]: unknown
}

const clone = (o: unknown): Rec => JSON.parse(JSON.stringify(o)) as Rec
const LEDGER = clone(
  JSON.parse(fs.readFileSync(new URL('../upstream/ledger.json', import.meta.url), 'utf8'))
)
const BASE = ledgerFingerprint(LEDGER)
const ags = (l: Rec): Rec[] => l.agents as Rec[]

describe('ledgerFingerprint', () => {
  it('对真实台账算得出稳定值', () => {
    expect(BASE).toMatch(/^[0-9a-f]{8}$/)
    // 同一份内容反复算必须一致 —— 否则指纹毫无意义
    expect(ledgerFingerprint(clone(LEDGER))).toBe(BASE)
  })

  it('**改 note 不改变指纹**(否则改一次措辞就让全部历史结论失效)', () => {
    const b = clone(LEDGER)
    const a0 = ags(b)[0] as Rec
    a0.note = '随便改点什么'
    ;(ags(b)[1] as Rec).mcp = { ...((ags(b)[1] as Rec).mcp as Rec), note: '也改' }
    expect(ledgerFingerprint(b)).toBe(BASE)
  })

  it('改 name 也不改变(纯显示字段)', () => {
    const b = clone(LEDGER)
    ;(ags(b)[0] as Rec).name = 'Renamed Agent'
    expect(ledgerFingerprint(b)).toBe(BASE)
  })

  it('改 requiredKeys → 指纹必须变(这正是要抓的漂移源)', () => {
    const b = clone(LEDGER)
    const target = ags(b).find((a) => ((a.mcp as Rec | undefined)?.requiredKeys as unknown[])?.length)
    expect(target, '台账里应至少有一个带 requiredKeys 的 agent').toBeTruthy()
    const mcp = { ...(target!.mcp as Rec) }
    mcp.requiredKeys = [...((mcp.requiredKeys as unknown[]) as string[]), '__probe_marker__']
    target!.mcp = mcp
    expect(ledgerFingerprint(b)).not.toBe(BASE)
  })

  it('改 tablesAnyOf → 指纹变', () => {
    const b = clone(LEDGER)
    const target = ags(b).find((a) => ((a.source as Rec)?.sqlite as Rec | undefined)?.tablesAnyOf)
    expect(target, '台账里应至少有一个 sqlite agent').toBeTruthy()
    const source = { ...(target!.source as Rec) }
    source.sqlite = { ...((source.sqlite as Rec)), tablesAnyOf: [['__probe_marker__']] }
    target!.source = source
    expect(ledgerFingerprint(b)).not.toBe(BASE)
  })

  it('改 upstream.repo → 指纹变(等于换了数据源)', () => {
    const b = clone(LEDGER)
    ;(ags(b)[0] as Rec).upstream = { kind: 'github', repo: 'someone/else' }
    expect(ledgerFingerprint(b)).not.toBe(BASE)
  })

  it('改 riskKeywords → 指纹变(白盒分级依据变了)', () => {
    const b = clone(LEDGER)
    ;(ags(b)[0] as Rec).riskKeywords = ['__probe_marker__']
    expect(ledgerFingerprint(b)).not.toBe(BASE)
  })

  it('改 monitor → 指纹变(判定口径变了)', () => {
    const b = clone(LEDGER)
    const a = ags(b)[0] as Rec
    a.monitor = a.monitor === 'tracked' ? 'blackbox_only' : 'tracked'
    expect(ledgerFingerprint(b)).not.toBe(BASE)
  })

  it('对空/畸形输入不炸', () => {
    expect(ledgerFingerprint(null)).toMatch(/^[0-9a-f]{8}$/)
    expect(ledgerFingerprint({})).toMatch(/^[0-9a-f]{8}$/)
    expect(ledgerFingerprint({ agents: [] })).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe('compareFingerprints — 三态,不是两态', () => {
  it('两边相同 → match', () => {
    expect(compareFingerprints('abc12345', 'abc12345').state).toBe('match')
  })

  it('两边不同 → mismatch', () => {
    expect(compareFingerprints('abc12345', 'ffff0000').state).toBe('mismatch')
  })

  it('探针没上报 → unknown,**不是 mismatch**', () => {
    // 旧版探针不带这个字段。报成冲突会让人去排查一个不存在的问题 ——
    // 一个天天误报的信号等于没有信号。
    expect(compareFingerprints('abc12345', null).state).toBe('unknown')
    expect(compareFingerprints('abc12345', undefined).state).toBe('unknown')
    expect(compareFingerprints('abc12345', '').state).toBe('unknown')
  })

  it('本机台账读不到 → unknown', () => {
    expect(compareFingerprints(null, 'abc12345').state).toBe('unknown')
  })

  it('保留原值以便面板展示', () => {
    const r = compareFingerprints('aaa', 'bbb')
    expect(r.server).toBe('aaa')
    expect(r.probe).toBe('bbb')
  })
})

describe('brief 携带契约一致性', () => {
  it('默认是 unknown(不传 ledger 参数时)', () => {
    expect(buildBrief([], null).ledger.state).toBe('unknown')
  })

  it('传入时原样带上', () => {
    expect(buildBrief([], null, compareFingerprints('aaa', 'bbb')).ledger.state).toBe('mismatch')
  })
})

describe('探针与服务端都上报指纹', () => {
  it('探针 payload 带 ledgerHash', () => {
    const src = fs.readFileSync(
      new URL('../scripts/upstream-probe.mjs', import.meta.url), 'utf8')
    expect(src).toMatch(/ledgerFingerprint/)
    expect(src).toMatch(/ledgerHash/)
  })

  it('服务端记录探针带来的指纹,缺字段时为 null 而非 undefined', () => {
    const src = fs.readFileSync(
      new URL('../tools/upstream-watch/server.mjs', import.meta.url), 'utf8')
    expect(src).toMatch(/ledgerHash: typeof data\.ledgerHash === 'string'/)
  })

  it('服务端每次现算指纹而不是缓存 —— 台账会被 git pull 换掉', () => {
    const src = fs.readFileSync(
      new URL('../tools/upstream-watch/server.mjs', import.meta.url), 'utf8')
    const fn = src.slice(src.indexOf('function currentLedgerHash'))
    expect(fn.slice(0, 400)).toMatch(/readFileSync\(LEDGER/)
  })
})

describe('面板必须把不一致显示成不容错过的样子', () => {
  const web = fs.readFileSync(
    new URL('../tools/upstream-watch/web/index.html', import.meta.url), 'utf8')

  it('有专门的 ledgerBlock 渲染', () => {
    expect(web).toMatch(/function ledgerBlock/)
    expect(web).toMatch(/ledgerBlock\(b\.ledger\)/)
  })

  it('mismatch 用红色警示样式并点明「结论不可比」', () => {
    const fn = web.slice(web.indexOf('function ledgerBlock'))
    expect(fn.slice(0, 1400)).toMatch(/ledger-warn/)
    expect(fn.slice(0, 1400)).toMatch(/不可比/)
  })

  it('unknown 与 mismatch 走不同分支,不会混淆', () => {
    const fn = web.slice(web.indexOf('function ledgerBlock'))
    expect(fn.slice(0, 1400)).toMatch(/state === 'mismatch'/)
    expect(fn.slice(0, 1400)).toMatch(/state === 'unknown'/)
    const unknownPart = fn.slice(fn.indexOf("state === 'unknown'"))
    expect(unknownPart.slice(0, 300)).toMatch(/ledger-ok/)
  })
})
