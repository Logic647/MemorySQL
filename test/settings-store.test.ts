import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SettingsStore } from '../src/main/core/settings'
import type { AppEnv } from '../src/main/core/env'

/**
 * settings.json 读取容错。2026-11-23 测试报告 P2-2:带 UTF-8 BOM(记事本保存)
 * 时 JSON.parse 抛错 → 旧实现静默降级为 {},随后任何 set() 用空对象覆盖原文件,
 * 用户全部设置与同步身份(deviceId)凭空丢失。
 */
let dir: string
let file: string

const store = (): SettingsStore =>
  new SettingsStore({ settingsPath: file } as unknown as AppEnv)

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msql-settings-'))
  file = path.join(dir, 'settings.json')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('SettingsStore 读取容错', () => {
  it('首次启动(无文件)不报错', () => {
    const s = store()
    expect(s.loadError).toBeNull()
    expect(s.get('x', 1)).toBe(1)
  })

  it('带 BOM 的文件照常解析(不再整份丢失)', () => {
    fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ 'sync-folder:plaintextAck': true, other: 2 }), 'utf-8')
    const s = store()
    expect(s.loadError).toBeNull()
    expect(s.get('sync-folder:plaintextAck', false)).toBe(true)
    expect(s.get('other', 0)).toBe(2)
    // 文件没有被改名
    expect(fs.existsSync(file)).toBe(true)
  })

  it('真损坏:备份原文件、记录错误,绝不用空对象覆盖原文件', () => {
    fs.writeFileSync(file, '{ 这不是 JSON', 'utf-8')
    const s = store()
    expect(s.loadError).toContain('settings.json 解析失败')
    expect(s.corruptBackupPath).toBeTruthy()
    const backup = s.corruptBackupPath!
    expect(fs.existsSync(backup)).toBe(true)
    expect(fs.readFileSync(backup, 'utf-8')).toBe('{ 这不是 JSON')
    // 原文件已被移走(下一次 set 写的是新文件,不是把备份盖掉)
    expect(fs.existsSync(file)).toBe(false)

    s.set('a', 1)
    expect(fs.readFileSync(file, 'utf-8')).toContain('"a": 1')
    expect(fs.readFileSync(backup, 'utf-8')).toBe('{ 这不是 JSON')
  })

  it('顶层不是对象也算损坏(数组/字符串不静默接受)', () => {
    fs.writeFileSync(file, '[1,2,3]', 'utf-8')
    const s = store()
    expect(s.loadError).toBeTruthy()
    expect(fs.existsSync(file)).toBe(false)
  })
})
