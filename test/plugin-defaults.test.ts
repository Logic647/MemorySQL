import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginHost, type MemorySQLPlugin } from '../src/main/core/plugin-host'
import { SettingsStore } from '../src/main/core/settings'
import { createCapturePlugin } from '../src/plugins/_lib/capture-factory'

/**
 * 0.7.5 退回后的修复:捕获类插件「没检测到源时默认关闭」。
 * 宿主规则:显式 `plugin.<id>.enabled` > 插件 isAvailable() 探测 > 默认启用。
 * 只影响默认值 —— 用户手动开关过的一律以设置为准。
 */

const tmps: string[] = []
function makeSettings(): SettingsStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msql-defaults-'))
  tmps.push(dir)
  return new SettingsStore({ settingsPath: path.join(dir, 'settings.json') } as never)
}
afterEach(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { force: true, recursive: true })
})

function makeHost(settings: SettingsStore, plugins: MemorySQLPlugin[]): PluginHost {
  const host = new PluginHost({} as never, {} as never, settings, {} as never)
  for (const p of plugins) host.add(p)
  return host
}

const plugin = (id: string, isAvailable?: () => boolean): MemorySQLPlugin => ({
  manifest: { id, name: id, version: '0.0.0' },
  init: () => {},
  ...(isAvailable ? { isAvailable } : {})
})

describe('插件默认启停(未检测到源时默认关闭)', () => {
  it('没有 isAvailable 的插件默认启用', () => {
    const host = makeHost(makeSettings(), [plugin('x')])
    expect(host.isPluginEnabled('x')).toBe(true)
  })

  it('isAvailable 返回 false → 默认关闭;返回 true → 默认启用', () => {
    const s = makeSettings()
    const host = makeHost(s, [
      plugin('missing', () => false),
      plugin('present', () => true)
    ])
    expect(host.isPluginEnabled('missing')).toBe(false)
    expect(host.isPluginEnabled('present')).toBe(true)
  })

  it('显式设置优先于探测(两个方向)', () => {
    const s = makeSettings()
    const host = makeHost(s, [
      plugin('missing', () => false),
      plugin('present', () => true)
    ])
    s.set('plugin.missing.enabled', true)
    s.set('plugin.present.enabled', false)
    expect(host.isPluginEnabled('missing')).toBe(true)
    expect(host.isPluginEnabled('present')).toBe(false)
  })

  it('探测抛异常时按启用处理(不能因为探测坏了漏捕获)', () => {
    const host = makeHost(makeSettings(), [
      plugin('boom', () => {
        throw new Error('probe failed')
      })
    ])
    expect(host.isPluginEnabled('boom')).toBe(true)
  })

  it('capture-factory 的默认值来自 sourceExists(源不存在 → 关闭)', () => {
    const s = makeSettings()
    const missing = createCapturePlugin({
      id: 'capture-ghost',
      name: 'Ghost',
      agentType: 'ghost',
      defaultRoot: path.join(os.tmpdir(), 'msql-does-not-exist-' + Date.now()),
      collect: () => []
    })
    expect(missing.isAvailable?.(s)).toBe(false)

    const existing = fs.mkdtempSync(path.join(os.tmpdir(), 'msql-src-'))
    tmps.push(existing)
    const present = createCapturePlugin({
      id: 'capture-real',
      name: 'Real',
      agentType: 'real',
      defaultRoot: existing,
      collect: () => []
    })
    expect(present.isAvailable?.(s)).toBe(true)
  })

  it('capture-factory 尊重用户配置的 sourceRoot(设置过的路径存在 → 启用)', () => {
    const s = makeSettings()
    const configured = fs.mkdtempSync(path.join(os.tmpdir(), 'msql-cfg-'))
    tmps.push(configured)
    s.set('capture-cfg:sourceRoot', configured)
    const p = createCapturePlugin({
      id: 'capture-cfg',
      name: 'Cfg',
      agentType: 'cfg',
      defaultRoot: path.join(os.tmpdir(), 'msql-nope-' + Date.now()),
      collect: () => []
    })
    expect(p.isAvailable?.(s)).toBe(true)
  })
})
