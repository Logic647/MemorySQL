import { describe, expect, it } from 'vitest'
import { distill } from '../src/plugins/memory-core/distill'
import type { RawMessage } from '../src/shared/types'

const msg = (role: 'user' | 'assistant', content: string): RawMessage => ({ role, content })

describe('memory distill (规则提炼)', () => {
  it('extracts decision sentences from user messages', () => {
    const out = distill('codex', 1, [
      msg('user', '我们决定用 SQLite 做存储,不再用 JSON 文件。'),
      msg('assistant', '好的。')
    ])
    expect(out.some((c) => c.kind === 'decision' && c.content.includes('SQLite'))).toBe(true)
  })

  it('extracts preference sentences with 记住/以后', () => {
    const out = distill('hermes', 2, [
      msg('user', '记住:以后所有提交都用 conventional commits 格式。'),
      msg('assistant', '明白。')
    ])
    expect(out.some((c) => c.kind === 'preference' && c.content.includes('conventional'))).toBe(true)
  })

  it('generates a terse-style persona when user messages are mostly short', () => {
    const msgs: RawMessage[] = []
    for (let i = 0; i < 6; i++) {
      msgs.push(msg('user', '继续'), msg('assistant', '好,我继续推进当前任务并汇报进展。'))
    }
    const out = distill('zcode', 3, msgs)
    expect(out.some((c) => c.kind === 'persona' && c.content.includes('极简指令'))).toBe(true)
  })

  it('does not fire the persona rule for few messages', () => {
    const out = distill('codex', 4, [msg('user', '继续'), msg('assistant', '好')])
    expect(out.some((c) => c.kind === 'persona')).toBe(false)
  })

  it('caps at 3 candidates per session and dedupes', () => {
    const msgs: RawMessage[] = [
      msg('user', '记住:用 pnpm。记住:用 pnpm。决定:用 vite。以后都写 TS 严格模式。再来一条决定:用 vitest。最后:记住部署用 pm2。')
    ]
    const out = distill('codex', 5, msgs)
    expect(out.length).toBeLessThanOrEqual(3)
    const contents = new Set(out.map((c) => c.content))
    expect(contents.size).toBe(out.length)
  })

  it('ignores assistant-only conversations', () => {
    const out = distill('hermes', 6, [msg('assistant', '记住这个结果:一切正常。')])
    expect(out).toHaveLength(0)
  })
})
