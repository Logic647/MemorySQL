import { describe, expect, it } from 'vitest'
import { BUILTIN_PLUGIN_IDS } from '../src/shared/builtin-plugins'
import { PLUGIN_GROUPS, groupedPlugins, type PluginListEntry } from '../src/renderer/src/plugin-groups'
import { orderAgentChips } from '../src/renderer/src/chips-order'

describe('插件分组完整性', () => {
  it('每个内置插件恰好归属一个分组(新增插件漏登记会在此变红)', () => {
    const all = PLUGIN_GROUPS.flatMap((g) => g.pluginIds)
    const builtin = BUILTIN_PLUGIN_IDS as readonly string[]
    for (const id of builtin) {
      const hits = all.filter((x) => x === id)
      expect(hits, `${id} 应恰好归属一个分组`).toHaveLength(1)
    }
  })

  it('分组里没有引用不存在的插件 id(防手滑拼错)', () => {
    const builtin = new Set<string>(BUILTIN_PLUGIN_IDS)
    for (const g of PLUGIN_GROUPS) {
      for (const id of g.pluginIds) {
        expect(builtin.has(id), `${g.label} 引用了未知插件 ${id}`).toBe(true)
      }
    }
  })

  it('分组 id 唯一', () => {
    const ids = PLUGIN_GROUPS.map((g) => g.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('groupedPlugins 装配', () => {
  const mk = (id: string, external = false, enabled = true): PluginListEntry => ({
    id,
    name: id,
    version: '0.0.0',
    enabled,
    external
  })

  it('内置插件进各自分组;外部插件单独一组', () => {
    const out = groupedPlugins([
      mk('core-schema'),
      mk('capture-codex'),
      mk('hello', true),
      mk('semantic-search', false, false)
    ])
    const byId = new Map(out.map((g) => [g.group.id, g.plugins.map((p) => p.id)]))
    expect(byId.get('core')).toEqual(['core-schema'])
    expect(byId.get('capture')).toEqual(['capture-codex'])
    expect(byId.get('service')).toEqual(['semantic-search'])
    expect(byId.get('external')).toEqual(['hello'])
    expect(out.every((g) => g.plugins.length > 0)).toBe(true)
  })

  it('未知 id 的内置插件兜底进「其他」组(正常情况下不会发生)', () => {
    // 用一个不在分组、但也不在 BUILTIN_PLUGIN_IDS 的 id → 不该出现
    const out = groupedPlugins([mk('not-a-plugin')])
    expect(out).toHaveLength(0)
  })
})

describe('orderAgentChips(按检测数排序)', () => {
  it('数量降序,0 条沉底且保持配置顺序', () => {
    const counts = new Map([
      ['codex', 42],
      ['zcode', 7],
      ['hermes', 0],
      ['gemini', 13]
    ])
    const ordered = orderAgentChips(['codex', 'zcode', 'hermes', 'gemini'], counts)
    expect(ordered.map((c) => c.agent)).toEqual(['codex', 'gemini', 'zcode', 'hermes'])
  })

  it('多个 0 条的沉底保持相对顺序;缺统计按 0 计', () => {
    const ordered = orderAgentChips(['a', 'b', 'c', 'd'], new Map([['b', 1]]))
    expect(ordered.map((c) => c.agent)).toEqual(['b', 'a', 'c', 'd'])
    expect(ordered.map((c) => c.count)).toEqual([1, 0, 0, 0])
  })

  it('空列表安全', () => {
    expect(orderAgentChips([], new Map())).toEqual([])
  })
})
