import { describe, expect, it } from 'vitest'
import { buildConflictPrompt, parseConflictResponse } from '../src/plugins/memory-core/conflicts'

const items = [
  { id: 1, kind: 'fact', content: '服务器 GitHub 推送使用 SSH 密钥认证' },
  { id: 2, kind: 'fact', content: '服务器 GitHub 推送已改用 HTTPS + PAT 认证' },
  { id: 3, kind: 'preference', content: '偏好深色主题' }
]

describe('buildConflictPrompt', () => {
  it('embeds ids, kinds and clipped contents with strict output format', () => {
    const p = buildConflictPrompt(items)
    expect(p).toContain('"id":1')
    expect(p).toContain('"kind":"fact"')
    expect(p).toContain('SSH 密钥认证')
    expect(p).toContain('只输出 JSON 数组')
    expect(p).toContain('互相矛盾')
    const long = buildConflictPrompt([{ id: 9, kind: 'fact', content: 'x'.repeat(500) }])
    expect(long.length).toBeLessThan(600)
  })
})

describe('parseConflictResponse', () => {
  const ids = new Set([1, 2, 3])

  it('parses plain and fenced JSON arrays', () => {
    const plain = '[{"a":1,"b":2,"reason":"新旧认证方式矛盾"}]'
    expect(parseConflictResponse(plain, ids)).toEqual([{ aId: 1, bId: 2, reason: '新旧认证方式矛盾' }])
    const fenced = '结论如下:\n```json\n[{"a":2,"b":1,"reason":"同上,方向相反"}]\n```'
    expect(parseConflictResponse(fenced, ids)).toHaveLength(1)
  })

  it('dedupes mirrored pairs and drops invalid ids / self pairs / missing reason', () => {
    const raw = JSON.stringify([
      { a: 1, b: 2, reason: 'r1' },
      { a: 2, b: 1, reason: 'mirror' },
      { a: 1, b: 99, reason: 'bad id' },
      { a: 3, b: 3, reason: 'self' },
      { a: 2, b: 3, reason: '' }
    ])
    const out = parseConflictResponse(raw, ids)
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({ aId: 1, bId: 2, reason: 'r1' })
  })

  it('returns empty on malformed output', () => {
    expect(parseConflictResponse('我觉得没有矛盾', ids)).toEqual([])
    expect(parseConflictResponse('[{broken json]', ids)).toEqual([])
    expect(parseConflictResponse('[]', ids)).toEqual([])
  })
})
