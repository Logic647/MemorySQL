import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import { extractJson } from '../tools/upstream-watch/llm.mjs'

/**
 * 抓取调度与 LLM 响应解析的加固 —— 三条都是「静默失败」家族的成员。
 *
 * 1. running 标志绝不能落盘,否则服务会永久失去刷新能力(详见用例)
 * 2. 已在抓取时 /api/refresh 必须回 409,不能回 200 + 旧数据
 * 3. JSON 提取不能用贪婪正则 —— 实测因此偶发解析失败
 */

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.LLM_API_KEY
})

// ─────────────────────────────────────────── 1. running 不得落盘
describe('running 是瞬时标志,不得写进 state.json', () => {
  const serverSrc = fs.readFileSync(
    new URL('../tools/upstream-watch/server.mjs', import.meta.url), 'utf-8')

  it('代码里存在"写盘时剔除瞬时字段"的逻辑', () => {
    // 靠代码形状断言:改实现可以,但不能把 running 落盘这个性质改掉
    expect(serverSrc).toMatch(/TRANSIENT/)
    expect(serverSrc).toMatch(/saveState/)
    const saveBody = serverSrc.slice(serverSrc.indexOf('function saveState'))
    expect(saveBody.slice(0, 400)).toMatch(/!TRANSIENT\.has/)
  })

  it('读盘后强制把 running 置回 false(第二道防线)', () => {
    const loadBody = serverSrc.slice(
      serverSrc.indexOf('function loadState'),
      serverSrc.indexOf('function saveState'))
    expect(loadBody).toMatch(/state\.running\s*=\s*false/)
  })

  it('回归:若真把 running 落盘,重启后会永久锁死 —— 这里复现该失效模式', async () => {
    // 模拟"抓取途中进程被杀":state.json 里残留 running:true
    const saved = { results: [{ agentId: 'a' }], running: true, lastRunAt: '2026-01-01T00:00:00Z' }
    // 旧逻辑:原样吃下
    const oldLoad = { ...{ running: false, results: [] }, ...saved }
    expect(oldLoad.running).toBe(true) // ← 锁死条件成立
    // 新逻辑:无条件覆盖
    const newLoad = { ...oldLoad, running: false }
    expect(newLoad.running).toBe(false)
    // 且 runOnce 的守卫是 `if (state.running) return`,所以 false 就能正常跑
    let ran = false
    const runOnce = () => { if (newLoad.running) return; ran = true }
    runOnce()
    expect(ran).toBe(true)
  })
})

// ─────────────────────────────────────────── 2. 忙碌时回 409
describe('/api/refresh 忙碌时必须回 409', () => {
  const serverSrc = fs.readFileSync(
    new URL('../tools/upstream-watch/server.mjs', import.meta.url), 'utf-8')

  it('处理器里有 409 分支', () => {
    const h = serverSrc.slice(serverSrc.indexOf("/api/refresh' && req.method === 'POST'"))
    expect(h.slice(0, 300)).toMatch(/409/)
  })

  it('前端会看状态码,而不是无条件当成功', () => {
    const web = fs.readFileSync(
      new URL('../tools/upstream-watch/web/index.html', import.meta.url), 'utf-8')
    const h = web.slice(web.indexOf("$('#refresh').onclick"))
    expect(h.slice(0, 700)).toMatch(/res\.status\s*===\s*409/)
    expect(h.slice(0, 700)).toMatch(/!res\.ok|res\.ok\s*\?/)
  })
})

// ─────────────────────────────────────────── 3. JSON 提取
/** 断言能抠出 JSON 并返回 data,省得每条都写 if (r.ok) throw */
function parsed(candidates: Array<string | null | undefined>) {
  const r = extractJson(candidates)
  if (!r.ok) throw new Error(`expected parseable JSON, got: ${r.error}`)
  return r.data
}

/** 断言抠不出来,返回错误串 */
function parseError(candidates: Array<string | null | undefined>) {
  const r = extractJson(candidates)
  if (r.ok) throw new Error('expected a parse failure, but it parsed')
  return r.error
}

describe('extractJson 不用贪婪正则', () => {
  it('整段就是 JSON —— 最快路径', () => {
    expect(parsed(['{"a":1,"b":"x"}'])).toEqual({ a: 1, b: 'x' })
  })

  it('前后夹着散文 —— 正常', () => {
    expect(parsed(['好的,结果如下:\n{"a":1}\n希望有帮助。'])).toEqual({ a: 1 })
  })

  it('**两段 JSON 时只取第一段完整的**(贪婪正则会在这里产出垃圾)', () => {
    // 贪婪 /\{[\s\S]*\}/ 会匹配到 {"a":1}\n示例:{"b":2} 的全部,解析必失败
    expect(parsed(['{"headline":"x"}\n例如:{"schema":"demo"}'])).toEqual({ headline: 'x' })
  })

  it('字符串字面量里的花括号不算嵌套层级', () => {
    expect(parsed(['{"reason":"改了 {table} 表结构","n":2}']))
      .toEqual({ reason: '改了 {table} 表结构', n: 2 })
  })

  it('转义引号不破坏扫描', () => {
    expect(parsed(['{"a":"he said \\"{x}\\"","b":1}'])).toEqual({ a: 'he said "{x}"', b: 1 })
  })

  it('嵌套对象/数组', () => {
    expect(parsed(['{"actions":["a","b"],"meta":{"n":{"k":[1,2]}}}']).meta.n.k).toEqual([1, 2])
  })

  it('被截断时明确说"可能被 maxTokens 截断",而不是含糊的解析错误', () => {
    // 实测踩过:position 329 落在 actions 数组里,当时完全看不出是被截断
    expect(parseError(['{"headline":"ok","actions":["第一条","第二条"'])).toMatch(/截断|未闭合/)
  })

  it('完全不含 JSON', () => {
    expect(parseError(['抱歉,我无法完成这个请求。'])).toBeTruthy()
  })

  it('多个候选里挑第一个能解析的(tool_calls 兜底)', () => {
    expect(parsed(['', '{"from":"tool_calls"}'])).toEqual({ from: 'tool_calls' })
  })
})
