import { describe, expect, it } from 'vitest'
import { extractLinks, extractTags, noteTitle, parseNote } from '../src/plugins/core-vault/note-parser'

describe('note-parser (wikilinks / tags / title)', () => {
  it('extracts wikilinks, stripping anchors and aliases', () => {
    const content = '见 [[MemorySQL 架构#决策]] 与 [[隐私模型|隐私]] 以及 [[MemorySQL 架构]]'
    expect(extractLinks(content)).toEqual(['MemorySQL 架构', '隐私模型'])
  })

  it('extracts inline CJK tags and frontmatter tags', () => {
    const content = '---\ntags: [rust, tauri]\n---\n用 #前端美化 和 #数据库课程 完成任务'
    const tags = extractTags(content)
    expect(tags).toContain('rust')
    expect(tags).toContain('tauri')
    expect(tags).toContain('前端美化')
    expect(tags).toContain('数据库课程')
  })

  it('does not treat hex colors or 123 as tags', () => {
    const content = 'color: #336699; value #42'
    const tags = extractTags(content)
    expect(tags).not.toContain('336699')
    expect(tags).not.toContain('42')
  })

  it('prefers the first heading as title, falls back to first line / file stem', () => {
    expect(noteTitle('---\ntags: x\n---\n\n# 真正的标题\n正文', 'file')).toBe('真正的标题')
    expect(noteTitle('普通第一行\n# 标题', 'file')).toBe('普通第一行')
    expect(noteTitle('', 'fallback')).toBe('fallback')
  })

  it('parseNote bundles everything', () => {
    const meta = parseNote('链接 [[A]] 标签 #t1', 'note')
    expect(meta.links).toEqual(['A'])
    expect(meta.tags).toEqual(['t1'])
  })
})
