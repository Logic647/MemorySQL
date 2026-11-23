import { describe, expect, it } from 'vitest'
import {
  describeProjectMatch,
  matchProjects,
  type ProjectCandidate
} from '../src/shared/project-match'

/**
 * 项目关键词解析。真实样本(2026-11-23 会话 #574):`new-chat` 用子串命中把
 * 6 月的 `new-chat-7` 并进来,agent 把另一个项目的记忆当成了当前的。
 */

const p = (id: number, name: string, path: string | null, activity = id): ProjectCandidate => ({
  id,
  name,
  path,
  activity
})

const rows: ProjectCandidate[] = [
  p(1, 'MemorySQL', 'F:/code/MemorySQL', 1),
  p(2, 'MemorySQL', 'H:\\桌面\\MemorySQL', 5),
  p(4, 'MemorySQL', 'H:/桌面/MemorySQL', 4),
  p(3, 'src', 'H:/桌面/MemorySQL/src', 2),
  p(60, 'new-chat', 'H:\\桌面\\temp\\new-chat', 60),
  p(8, 'new-chat-7', 'C:\\Users\\Logic\\Documents\\Codex\\2026-06-03\\new-chat-7', 8),
  p(9, '数据库课程设计', 'D:\\code\\db-course', 9),
  p(10, '数据库课程设计-备份', 'D:\\code\\db-course-bak', 7)
]

describe('matchProjects', () => {
  it('项目名精确相等 → 全部合并(换机/换盘的多份登记)', () => {
    const m = matchProjects(rows, 'MemorySQL')!
    expect(m.tier).toBe('exact')
    expect(m.rows.map((r) => r.id).sort()).toEqual([1, 2, 4])
    expect(m.others).toEqual([])
  })

  it('大小写/空白不敏感', () => {
    expect(matchProjects(rows, '  memorysql ')!.rows).toHaveLength(3)
  })

  /**
   * 事故回归:new-chat 不是 new-chat-7 的别名。子串只在不构成精确名时才用。
   */
  it('new-chat 不会把 new-chat-7 并进来', () => {
    const m = matchProjects(rows, 'new-chat')!
    expect(m.tier).toBe('exact')
    expect(m.rows.map((r) => r.id)).toEqual([60])
  })

  it('路径段精确相等(用户直接贴路径/目录名)', () => {
    const m = matchProjects(rows, 'db-course')!
    expect(m.tier).toBe('path')
    expect(m.rows.map((r) => r.id)).toEqual([9])
  })

  it('没有精确命中才退回子串:只取最近活跃的一个,其余列为候选', () => {
    const m = matchProjects(rows, '数据库课程设计')!
    expect(m.tier).toBe('exact') // 恰好精确命中 9?名字完全相同 → 精确
    expect(m.rows.map((r) => r.id)).toEqual([9])

    const sub = matchProjects(rows, '课程')!
    expect(sub.tier).toBe('substring')
    expect(sub.rows.map((r) => r.id)).toEqual([9]) // 9 比 10 活跃
    expect(sub.others.map((r) => r.id)).toEqual([10])
  })

  it('完全没命中返回 null', () => {
    expect(matchProjects(rows, '不存在的项目')).toBeNull()
    expect(matchProjects(rows, '   ')).toBeNull()
  })
})

describe('describeProjectMatch', () => {
  it('精确单命中不啰嗦', () => {
    expect(describeProjectMatch(matchProjects(rows, 'new-chat')!, 'new-chat')).toBeNull()
  })

  it('精确多命中说明"同名项目已合并"', () => {
    const text = describeProjectMatch(matchProjects(rows, 'MemorySQL')!, 'MemorySQL')!
    expect(text).toContain('3 个同名项目')
    expect(text).toContain('#2')
  })

  it('子串兜底必须列出未纳入的候选并给出消歧办法', () => {
    const text = describeProjectMatch(matchProjects(rows, '课程')!, '课程')!
    expect(text).toContain('子串')
    expect(text).toContain('未纳入')
    expect(text).toContain('#10')
    expect(text).toContain('完整项目名或路径')
  })
})
