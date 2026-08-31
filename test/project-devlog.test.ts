import { describe, expect, it } from 'vitest'
import { buildDevlogMd, type DevlogSession } from '../src/plugins/project-devlog/generate'

const sec = (daysAgo: number, hour = 10): number => {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  d.setHours(hour, 0, 0, 0)
  return Math.floor(d.getTime() / 1000)
}

const baseSession = (over: Partial<DevlogSession>): DevlogSession => ({
  id: 1,
  agent_type: 'codex',
  title: '某次工作',
  summary: '第一行摘要',
  started_at: sec(0),
  message_count: 5,
  ...over
})

describe('buildDevlogMd', () => {
  it('renders marker, overview with agent counts and span', () => {
    const md = buildDevlogMd({
      project: { name: 'Demo', path: 'F:/code/Demo', tech_stack: 'Node.js' },
      sessions: [
        baseSession({ id: 1, agent_type: 'codex', started_at: sec(0) }),
        baseSession({ id: 2, agent_type: 'zcode', started_at: sec(3) }),
        baseSession({ id: 3, agent_type: 'zcode', started_at: sec(3) })
      ],
      activeMemories: [],
      pendingProgress: [],
      generatedAt: new Date()
    })
    expect(md).toContain('memorysql:auto-devlog v1')
    expect(md).toContain('# Demo 开发日志')
    expect(md).toContain('- 会话: 3 个(codex 1 · zcode 2)')
    expect(md).toContain('- 技术栈: Node.js')
    expect(md).toContain('- 路径: F:/code/Demo')
    expect(md).toMatch(/- 时间跨度: \d{4}\/\d+\/\d+ ~ \d{4}\/\d+\/\d+/)
  })

  it('groups the timeline by day, newest first', () => {
    const md = buildDevlogMd({
      project: { name: 'Demo', path: null, tech_stack: null },
      sessions: [
        baseSession({ id: 1, started_at: sec(0) }),
        baseSession({ id: 2, started_at: sec(2, 9) }),
        baseSession({ id: 3, started_at: sec(2, 15) })
      ],
      activeMemories: [],
      pendingProgress: [],
      generatedAt: new Date()
    })
    const days = [...md.matchAll(/^### (\d{4}-\d{2}-\d{2})$/gm)].map((m) => m[1])
    expect(days).toHaveLength(2)
    expect(md.indexOf(`### ${days[0]}`)).toBeLessThan(md.indexOf(`### ${days[1]}`)) // newest day first
    const day2Block = md.slice(md.indexOf(`### ${days[1]}`), md.indexOf('## 决策与结论'))
    expect(day2Block.indexOf('#2')).toBeLessThan(day2Block.indexOf('#3')) // same day: asc
    expect(md).toContain('[#1 codex]')
    expect(md).toContain('— 第一行摘要')
    expect(md).toContain('(5 条消息)')
  })

  it('includes memory sections and empty-state hints', () => {
    const md = buildDevlogMd({
      project: { name: 'Demo', path: null, tech_stack: null },
      sessions: [],
      activeMemories: [{ kind: 'decision', content: '放弃方案 A,改用方案 B 的原因很长很长很长' }],
      pendingProgress: [{ kind: 'fact', content: '[进度] 项目「Demo」\n- 完成: 一半' }],
      generatedAt: new Date()
    })
    expect(md).toContain('## 时间线')
    expect(md).toContain('(暂无会话记录)')
    expect(md).toContain('## 决策与结论(活跃记忆)')
    expect(md).toContain('- [decision] 放弃方案 A')
    expect(md).toContain('## 未竟与待办(待确认进度)')
    expect(md).toContain('- [进度] 项目「Demo」')
  })
})
