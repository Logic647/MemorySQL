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

  /**
   * harness 注入的系统文本在库里也是 user 角色(2026-11-22 真库实测):不滤掉的话
   * ①英文噪声误中 don't/remember 信号词 ②users 被撑大、短句画像失真
   */
  it('harness 噪声不参与提炼:不产候选、不进画像比例', () => {
    const noise = [
      '# Environment\nYou have been invoked in the following environment: \n - Primary working directory: C:\\',
      "The TodoWrite tool hasn't been used recently. If you are working on tasks that would benefit from TodoWrite, remember to use it. Don't repeat tracked items.",
      '<task-notification>\n<task-id>exec_x</task-id>\n<status>failed</status>\n</task-notification>',
      '<total_tokens>15000000 tokens left</total_tokens>'
    ]
    const msgs: RawMessage[] = []
    for (const n of noise) msgs.push(msg('user', n), msg('assistant', '好的,继续。'))
    const out = distill('zcode', 7, msgs)
    expect(out).toHaveLength(0)
    // 噪声不进分母:6 条噪声 + 5 条真短句(占比 5/5=100%)→ 画像规则照常触发
    const mixed: RawMessage[] = noise.flatMap((n) => [msg('user', n), msg('assistant', '好')])
    for (let i = 0; i < 5; i++) mixed.push(msg('user', '继续'), msg('assistant', '继续推进并汇报。'))
    const out2 = distill('zcode', 8, mixed)
    expect(out2.some((c) => c.kind === 'persona' && c.content.includes('极简指令'))).toBe(true)
  })
})
