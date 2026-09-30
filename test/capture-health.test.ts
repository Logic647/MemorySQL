import { describe, expect, it } from 'vitest'
import { FAILING_THRESHOLD, failureDetail, healthFrom } from '../src/plugins/_lib/capture-health'

/**
 * 捕获健康度判定 —— 第 1 期的核心逻辑。
 *
 * 这套判定存在的唯一理由:过去增量捕获失败只写日志,状态面板永远显示正常。
 * 上游改格式后,每条新会话都解析失败却无人知晓(真实事故:opencode 2.x 换表)。
 * 判定必须满足:偶发失败不误报、持续失败必升级、恢复后立即归零。
 */
describe('healthFrom', () => {
  it('未捕获过且无失败 → unknown(不是 healthy,别假装确定)', () => {
    expect(healthFrom(0, false)).toBe('unknown')
  })

  it('有成功记录且无失败 → healthy', () => {
    expect(healthFrom(0, true)).toBe('healthy')
  })

  it('1~2 次连续失败 → suspect(留出偶发空间:文件写入中、权限抖动)', () => {
    expect(healthFrom(1, true)).toBe('suspect')
    expect(healthFrom(FAILING_THRESHOLD - 1, true)).toBe('suspect')
  })

  it(`≥${FAILING_THRESHOLD} 次连续失败 → failing(需要适配发版)`, () => {
    expect(healthFrom(FAILING_THRESHOLD, true)).toBe('failing')
    expect(healthFrom(FAILING_THRESHOLD + 5, false)).toBe('failing')
  })

  it('失败计数优先于是否有成功记录(曾成功过不代表现在没坏)', () => {
    expect(healthFrom(FAILING_THRESHOLD, true)).toBe('failing')
  })

  it('阈值是 3 而不是 1 —— 一次失败不该惊动用户', () => {
    expect(FAILING_THRESHOLD).toBeGreaterThan(1)
  })
})

describe('failureDetail', () => {
  it('Error 取 message', () => {
    expect(failureDetail(new Error('no such table: session'))).toContain('no such table')
  })

  it('非 Error 也能成文', () => {
    expect(failureDetail('boom')).toContain('boom')
    expect(failureDetail({ weird: true })).toContain('object')
  })

  it('附上出错文件,便于定位是哪条会话读不懂', () => {
    const d = failureDetail(new Error('parse failed'), 'rollout-abc.jsonl')
    expect(d).toContain('rollout-abc.jsonl')
    expect(d).toContain('parse failed')
  })

  it('压掉换行并截断,避免把整个堆栈塞进状态面板', () => {
    const d = failureDetail(new Error('x'.repeat(500)))
    expect(d.length).toBeLessThanOrEqual(201)
    expect(d.endsWith('…')).toBe(true)
  })

  it('无文件时不留下多余 @', () => {
    expect(failureDetail(new Error('oops'))).not.toContain('@')
  })
})
