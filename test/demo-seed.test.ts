import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUILTIN_PLUGIN_IDS } from '../src/shared/builtin-plugins'

/**
 * 演示库的隔离名单必须**从 BUILTIN_PLUGIN_IDS 派生**。
 *
 * 2026-11-23 测试报告 P1-1:手写名单停在 14 家,新增的 mimocode 等 10 家捕获
 * 插件不在名单里 → 应用按「源存在即默认启用」把真实会话灌进演示库
 * (13 条 → 465 条),`take-screenshots.mjs` 走同一份 seed,宣传图会泄露真实数据。
 */
const src = fs.readFileSync(
  path.resolve(import.meta.dirname, '..', 'scripts', 'seed-demo.ts'),
  'utf-8'
)

describe('seed-demo 隔离名单', () => {
  it('从 BUILTIN_PLUGIN_IDS 派生(不再手写插件数组)', () => {
    expect(src).toContain('BUILTIN_PLUGIN_IDS')
    expect(src).toMatch(/BUILTIN_PLUGIN_IDS\.filter/)
    // 旧实现的手写名单会写成 'capture-codex', 'capture-zcode' 这种相邻字面量
    expect(src).not.toMatch(/'capture-codex',\s*'capture-zcode'/)
  })

  it('内置清单里的捕获插件数量足以让兜底断言成立', () => {
    const captures = BUILTIN_PLUGIN_IDS.filter((id) => id.startsWith('capture-'))
    expect(captures.length).toBeGreaterThanOrEqual(20)
  })
})
