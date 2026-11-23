import { describe, expect, it } from 'vitest'
import { canonicalProjectPath, projectPathKey } from '../src/shared/project-path'

/**
 * 项目路径归一。2026-11-23 测试报告 P2-5:同一物理目录被不同 agent 的 cwd
 * 写法(`H:\桌面\MemorySQL` 与 `H:/桌面/MemorySQL`)拆成两个项目。
 */
const win = process.platform === 'win32'

describe('canonicalProjectPath', () => {
  it.skipIf(!win)('Windows:统一分隔符、去尾斜杠、盘符大写、保留盘根', () => {
    expect(canonicalProjectPath('H:/桌面/MemorySQL')).toBe('H:\\桌面\\MemorySQL')
    expect(canonicalProjectPath('H:\\桌面\\MemorySQL\\')).toBe('H:\\桌面\\MemorySQL')
    expect(canonicalProjectPath('h:\\桌面\\\\MemorySQL')).toBe('H:\\桌面\\MemorySQL')
    expect(canonicalProjectPath('C:\\')).toBe('C:\\')
    expect(canonicalProjectPath('  D:/dev/x  ')).toBe('D:\\dev\\x')
  })

  it.skipIf(!win)('Windows:UNC 前缀不被合并', () => {
    expect(canonicalProjectPath('//nas/share/x/')).toBe('\\\\nas\\share\\x')
    expect(canonicalProjectPath('\\\\nas\\share\\x')).toBe('\\\\nas\\share\\x')
  })

  it.skipIf(win)('POSIX:合并重复斜杠、去尾斜杠', () => {
    expect(canonicalProjectPath('/dev//demo/')).toBe('/dev/demo')
    expect(canonicalProjectPath('/dev/demo')).toBe('/dev/demo')
    expect(canonicalProjectPath('/')).toBe('/')
  })

  it('空值原样返回(调用方按无 cwd 处理)', () => {
    expect(canonicalProjectPath('')).toBe('')
    expect(canonicalProjectPath('   ')).toBe('')
  })

  it('比较键:Windows 大小写不敏感,其余平台区分', () => {
    if (win) {
      expect(projectPathKey('H:\\桌面\\MemorySQL')).toBe(projectPathKey('h:/桌面/memorysql'))
    } else {
      expect(projectPathKey('/dev/Demo')).not.toBe(projectPathKey('/dev/demo'))
    }
  })
})
