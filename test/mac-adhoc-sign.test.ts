import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * macOS ad-hoc 签名钩子的护栏。
 *
 * 2026-11-28 另一 agent 在 Apple Silicon 实测:未签名产物缺 `_CodeSignature`
 * 但可执行文件带残缺 adhoc 头 → macOS 15+ 判「已损坏」,连「仍要打开」都不给。
 * 由 `afterPack: ./scripts/adhoc-sign-mac.mjs` 补完整 ad-hoc 签名并严格校验。
 *
 * 不能在测试里 import .mjs(vitest 经 vite 加载 .mjs 在 CI Windows 会炸),所以这里
 * 做源码级断言 —— 锁住「必须校验」与「绝不能加 Hardened Runtime」这两条。
 */
const root = path.resolve(import.meta.dirname, '..')
const hook = fs.readFileSync(path.join(root, 'scripts', 'adhoc-sign-mac.mjs'), 'utf-8')
const builder = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf-8')

describe('mac ad-hoc 签名钩子', () => {
  it('electron-builder 配置里挂上了 afterPack 钩子', () => {
    expect(builder).toMatch(/^afterPack:\s*\.\/scripts\/adhoc-sign-mac\.mjs$/m)
  })

  it('签名后会跑 codesign --verify --deep --strict(失败即让构建失败)', () => {
    expect(hook).toContain("'--verify'")
    expect(hook).toContain("'--deep'")
    expect(hook).toContain("'--strict'")
  })

  it('不对 ad-hoc 包加 Hardened Runtime(否则 vec0.dylib / native-runtime 加载即崩)', () => {
    // 注释里解释「为什么不用 --options runtime」是允许的;实际参数里不能出现
    expect(hook).not.toMatch(/['"]--options['"]/)
    // 整包签名必须是「--force --deep --sign -」这一种形态
    expect(hook).toMatch(/\['--force', '--deep', '--sign', '-', appPath\]/)
  })

  it('只在 macOS 且没有正式证书时执行', () => {
    expect(hook).toContain("electronPlatformName !== 'darwin'")
    expect(hook).toContain('process.env.CSC_LINK')
  })

  it('先签 app.asar.unpacked 里的原生二进制,再签整个 .app', () => {
    expect(hook).toContain("'app.asar.unpacked'")
    expect(hook).toContain('.node')
    expect(hook).toContain('.dylib')
  })
})
