import { describe, expect, it } from 'vitest'
import { segmentSource, splitHermesMemoryFile } from '../src/plugins/capture-hermes/split'

describe('splitHermesMemoryFile', () => {
  it('splits on § marker lines and keeps every segment', () => {
    const content = [
      '本机网络环境：移动宽带原生IPv6可用，稳定地址后缀固定。',
      '§',
      'GitHub细粒度PAT的仓库访问是白名单制：未勾选的仓库即使public也返回404。',
      '诊断顺序：先GET api.github.com/user验证token有效性。',
      '§',
      '数据库课程设计：技术栈 Node.js Express + SQL Server + Neo4j。'
    ].join('\n')
    const segments = splitHermesMemoryFile(content)
    expect(segments).toHaveLength(3)
    expect(segments[0]).toContain('IPv6')
    expect(segments[1]).toContain('白名单制')
    expect(segments[2]).toContain('Neo4j')
  })

  it('keeps text after the marker as the first line of the new segment', () => {
    const segments = splitHermesMemoryFile('第一条记忆内容\n§ 标题行\n正文内容')
    expect(segments).toHaveLength(2)
    expect(segments[1]).toBe('标题行\n正文内容')
  })

  it('returns the whole content as one segment without markers', () => {
    const content = '# User Profile\n- 语言: 中文\n- 平台: Windows'
    expect(splitHermesMemoryFile(content)).toEqual([content])
  })

  it('drops empty segments and handles CRLF', () => {
    const content = '第一条\r\n§\r\n§\r\n第二条\r\n'
    expect(splitHermesMemoryFile(content)).toEqual(['第一条', '第二条'])
  })
})

describe('segmentSource', () => {
  it('is content-addressed and stable for identical segments', () => {
    expect(segmentSource('profiles/daily/memories/MEMORY.md', '同一段内容')).toBe(
      segmentSource('profiles/daily/memories/MEMORY.md', '同一段内容')
    )
  })

  it('differs across content edits and file paths', () => {
    const a = segmentSource('x/MEMORY.md', '旧内容')
    const b = segmentSource('x/MEMORY.md', '新内容')
    const c = segmentSource('y/MEMORY.md', '旧内容')
    expect(a).not.toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(/^hermes:x\/MEMORY\.md#[0-9a-f]{10}$/)
  })
})
