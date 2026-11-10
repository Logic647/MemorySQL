import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { normalizeThemeSetting, resolveTheme, themeBackground, titleBarColors } from '../src/main/core/theme'

const ROOT = path.resolve(import.meta.dirname, '..')
const TOKENS = fs.readFileSync(path.join(ROOT, 'src/renderer/src/styles/tokens.css'), 'utf-8')
const STYLES = fs.readFileSync(path.join(ROOT, 'src/renderer/src/styles.css'), 'utf-8')

/** 取出某个 CSS 块的声明(body 不嵌套,够用) */
function blockBody(source: string, selector: string): string {
  const at = source.indexOf(selector)
  expect(at, `找不到选择器 ${selector}`).toBeGreaterThanOrEqual(0)
  const open = source.indexOf('{', at)
  const close = source.indexOf('}', open)
  return source.slice(open + 1, close)
}

function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>()
  // 先去掉注释,再按声明正则抓 —— 按 ';' 切会把「注释 + 第一个 token」切成一块,
  // 于是每个分区里紧跟注释的那一行会被整块跳过(漏掉 --msql-bg 这种)
  const clean = body.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const m of clean.matchAll(/(--msql-[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    out.set(m[1], m[2].trim())
  }
  return out
}

const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|color-mix\(/

describe('主题解析', () => {
  it('显式主题不受系统影响', () => {
    expect(resolveTheme('dark', false)).toBe('dark')
    expect(resolveTheme('light', true)).toBe('light')
  })

  it('跟随系统时取系统偏好', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })

  it('脏值一律回落到跟随系统(0.7.5 起默认 system,此前是 dark)', () => {
    expect(normalizeThemeSetting(undefined)).toBe('system')
    expect(normalizeThemeSetting('')).toBe('system')
    expect(normalizeThemeSetting('DARK')).toBe('system')
    expect(normalizeThemeSetting(42)).toBe('system')
    // 显式选过的值必须保持,不能被默认值吞掉
    expect(normalizeThemeSetting('dark')).toBe('dark')
    expect(normalizeThemeSetting('light')).toBe('light')
    expect(normalizeThemeSetting('system')).toBe('system')
  })

  it('窗口底色与标题栏随主题', () => {
    expect(themeBackground('dark')).not.toBe(themeBackground('light'))
    expect(titleBarColors('dark').symbolColor).not.toBe(titleBarColors('light').symbolColor)
  })
})

describe('token 层自洽(新增颜色必须给浅色值)', () => {
  const dark = declarations(blockBody(TOKENS, ':root'))
  const light = declarations(blockBody(TOKENS, "[data-theme='light']"))

  it('深色定义了 token', () => {
    expect(dark.size).toBeGreaterThan(40)
    expect(dark.has('--msql-bg')).toBe(true)
  })

  it('深色里每个颜色 token 都有浅色覆盖', () => {
    const missing: string[] = []
    for (const [name, value] of dark) {
      if (!COLOR_RE.test(value)) continue
      if (!light.has(name)) missing.push(name)
    }
    expect(missing, `这些颜色 token 缺少 [data-theme='light'] 覆盖: ${missing.join(', ')}`).toEqual([])
  })

  it('浅色块不定义深色块里没有的 token(拼写错误会被抓出来)', () => {
    const extra = [...light.keys()].filter((k) => !dark.has(k))
    expect(extra).toEqual([])
  })

  it('styles.css 用到的每个 token 都有定义', () => {
    const used = new Set<string>()
    for (const m of STYLES.matchAll(/var\((--msql-[a-z0-9-]+)/gi)) used.add(m[1])
    const missing = [...used].filter((k) => !dark.has(k))
    expect(missing, `styles.css 引用了未定义的 token: ${missing.join(', ')}`).toEqual([])
  })

  it('组件样式里没有字面颜色(否则浅色主题会漏掉那一处)', () => {
    const offenders: string[] = []
    for (const m of STYLES.matchAll(/[^\n]*#[0-9a-fA-F]{3,8}\b[^\n]*|(?<![a-z-])rgba?\([^\n]*/g)) {
      offenders.push(m[0].trim())
    }
    expect(offenders, `styles.css 里仍有硬编码颜色:\n${offenders.join('\n')}`).toEqual([])
  })
})
