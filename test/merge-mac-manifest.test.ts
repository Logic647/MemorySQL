import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import {
  parseManifest,
  mergeManifests,
  formatManifest,
  assertBothArchesResolve
} from '../scripts/merge-mac-manifest.mjs'

/**
 * macOS 清单合并 —— 防的是「发出去才发现装错架构」。
 *
 * 背景:macOS 拆成两个 CI job(macos-14 出 arm64、macos-13 出 x64),
 * 但两个 job 都产出一份叫 `latest-mac.yml` 的清单,后上传的覆盖先上传的。
 * electron-updater 读**这一份**清单再按架构过滤,于是:
 *
 *   只剩 x64 条目时,Apple Silicon 会解析出 x64 包 → 装上 Intel 版,
 *   而 sqlite-vec / onnxruntime 是按架构编译的原生模块,换架构即损坏。
 *
 * 这个 bug 不会在 CI 里报错,也不会在发版时被发现 —— 只有一个 Apple Silicon
 * 用户点了「检查更新」、装了、应用用起来开始崩,才可能归因回来。
 * 所以测试要专门锁住这个方向。
 */

const require_ = createRequire(import.meta.url)
const M = require_('electron-updater/out/MacUpdater.js')
const C = M.MacUpdater ?? M.default ?? M

const sha = (s: string) => `sha-${s}`

/** 造一份 electron-builder 风格的单架构清单 */
const mk = (arch: string, version = '0.5.6') => `version: ${version}
files:
  - url: MemorySQL-${version}-${arch}.zip
    sha512: ${sha(arch + 'zip')}
    size: 196349485
  - url: MemorySQL-${version}-${arch}.dmg
    sha512: ${sha(arch + 'dmg')}
    size: 196729957
path: MemorySQL-${version}-${arch}.zip
sha512: ${sha(arch + 'zip')}
releaseDate: '2026-09-30T13:57:46.886Z'
`

/** 直接问 electron-updater:这个架构从 files 列表里能拿到哪个 zip */
const resolve = (files: { url: string }[], isArm: boolean): string | null => {
  const shaped = files.map((f) => ({ url: { pathname: '/d/' + f.url }, info: { url: f.url } }))
  const kept = C.filterFilesForArch(shaped, isArm) as { info: { url: string } }[]
  return kept.find((f: { info: { url: string } }) => f.info.url.endsWith('.zip'))?.info.url ?? null
}

describe('前提:electron-updater 真的是这么挑包的', () => {
  // 这几条不是测我们的代码,是确认我们理解的上游行为没变。
  // 万一 electron-updater 改了策略,这里会先红,提醒我们重新评估。
  it('单架构清单在另一架构上取不到 zip', () => {
    const arm = parseManifest(mk('arm64')).files
    expect(resolve(arm, true)).toContain('arm64')
    expect(resolve(arm, false)).toBeNull()
  })

  it('**x64-only 清单会被 arm64 Mac 当成可更新包**(这就是要防的坑)', () => {
    const x64 = parseManifest(mk('x64')).files
    // arm64 Mac 拿到的是 x64 包 → 会装上 Intel 版
    expect(resolve(x64, true)).toContain('x64')
    expect(resolve(x64, false)).toContain('x64')
  })
})

describe('parseManifest', () => {
  it('读出真实 arm64 清单的全部字段', () => {
    const m = parseManifest(mk('arm64'))
    expect(m.version).toBe('0.5.6')
    expect(m.files).toHaveLength(2)
    expect(m.path).toBe('MemorySQL-0.5.6-arm64.zip')
    expect(m.sha512).toBe(sha('arm64zip'))
    expect(m.releaseDate).toBe('2026-09-30T13:57:46.886Z')
  })

  it('真实产物里的那份清单也能解析', () => {
    // 就是刚从 7cbbda7 的 artifact 里抠出来的那份原文
    const real = `version: 0.5.5
files:
  - url: MemorySQL-0.5.5-arm64.zip
    sha512: dYykAb2k7xqyVf/m7EN49+hpPsGHXhA0gM93GYdDhM8acecmNYj1DjjN8ooRrIO7tRBqDNe8+LClDL/hDiQOfw==
    size: 196349485
  - url: MemorySQL-0.5.5-arm64.dmg
    sha512: Wop3yz4P+B+t0zVrGDlJ5QWJ0anfaSEEi308+uwVlxp9kSlolvJPsbrO2f3yYURt75elx/vEwPr8YUeRRrDnyg==
    size: 196729957
path: MemorySQL-0.5.5-arm64.zip
sha512: dYykAb2k7xqyVf/m7EN49+hpPsGHXhA0gM93GYdDhM8acecmNYj1DjjN8ooRrIO7tRBqDNe8+LClDL/hDiQOfw==
releaseDate: '2026-09-30T13:57:46.886Z'
`
    const m = parseManifest(real, 'artifact')
    expect(m.version).toBe('0.5.5')
    expect(m.files).toHaveLength(2)
  })

  it('缺 version / path / sha512 一律抛错,不猜', () => {
    const noVersion = mk('arm64').replace('version: 0.5.6\n', '')
    const noPath = mk('arm64').replace(/^path: .*$/m, '')
    const noSha = mk('arm64').replace(/^    sha512: sha-arm64zip$/m, '')
    expect(() => parseManifest(noVersion)).toThrow(/version/)
    expect(() => parseManifest(noPath)).toThrow(/path/)
    expect(() => parseManifest(noSha)).toThrow(/sha512/)
  })

  it('文件条目缺 size 也抛错 —— 缺了 updater 无法校验下载', () => {
    const noSize = mk('arm64').replace(/^    size: 196349485$/m, '')
    expect(() => parseManifest(noSize)).toThrow(/size/)
  })

  it('认出无法解析的行,不静默丢掉', () => {
    expect(() => parseManifest('version: 1\nfiles:\n  - something: weird\n')).toThrow()
  })

  it('容忍 CRLF、注释、空行', () => {
    const messy = '# 注释\r\n\r\n' + mk('arm64').replace(/\n/g, '\r\n')
    expect(parseManifest(messy).version).toBe('0.5.6')
  })
})

describe('mergeManifests', () => {
  it('两架构合并后 files 是并集(4 个文件)', () => {
    const m = mergeManifests([parseManifest(mk('arm64')), parseManifest(mk('x64'))])
    expect(m.files).toHaveLength(4)
    expect(m.files.map((f) => f.url)).toEqual([
      'MemorySQL-0.5.6-arm64.dmg',
      'MemorySQL-0.5.6-arm64.zip',
      'MemorySQL-0.5.6-x64.dmg',
      'MemorySQL-0.5.6-x64.zip'
    ])
  })

  it('**合并后两个架构都能解析到各自的 zip**(核心保证)', () => {
    const m = mergeManifests([parseManifest(mk('arm64')), parseManifest(mk('x64'))])
    expect(resolve(m.files, true)).toBe('MemorySQL-0.5.6-arm64.zip')
    expect(resolve(m.files, false)).toBe('MemorySQL-0.5.6-x64.zip')
  })

  it('**关键回归:合并前 arm64 会被喂 x64 包,合并后不会**', () => {
    const x64Only = parseManifest(mk('x64')).files
    expect(resolve(x64Only, true)).toBe('MemorySQL-0.5.6-x64.zip') // 合并前的错误行为
    const merged = mergeManifests([parseManifest(mk('arm64')), parseManifest(mk('x64'))]).files
    expect(resolve(merged, true)).toBe('MemorySQL-0.5.6-arm64.zip') // 合并后修正
  })

  it('path 优先指向 arm64 包(Apple Silicon 是主要受众)', () => {
    const m = mergeManifests([parseManifest(mk('x64')), parseManifest(mk('arm64'))])
    expect(m.path).toBe('MemorySQL-0.5.6-arm64.zip')
    expect(m.sha512).toBe(sha('arm64zip'))
  })

  it('**版本不一致必须抛错** —— 那是两个不同的发布,混起来就是发坏更新', () => {
    expect(() => mergeManifests([parseManifest(mk('arm64', '0.5.6')), parseManifest(mk('x64', '0.5.5'))])).toThrow(
      /版本不一致/
    )
  })

  it('同一 url 出现两次只保留一条', () => {
    const m = mergeManifests([parseManifest(mk('arm64')), parseManifest(mk('arm64'))])
    expect(m.files).toHaveLength(2)
  })

  it('releaseDate 取最新的一份', () => {
    const a = parseManifest(mk('arm64'))
    const b = parseManifest(mk('x64'))
    b.releaseDate = '2026-09-30T23:59:59.000Z'
    expect(mergeManifests([a, b]).releaseDate).toBe('2026-09-30T23:59:59.000Z')
  })

  it('只有一份时原样返回(不丢字段)', () => {
    const m = mergeManifests([parseManifest(mk('arm64'))])
    expect(m.version).toBe('0.5.6')
    expect(m.files).toHaveLength(2)
  })
})

describe('formatManifest — 合并结果要能被自己再解析', () => {
  it('往返一致(写出的文本再读回来,内容不变)', () => {
    const m = mergeManifests([parseManifest(mk('arm64')), parseManifest(mk('x64'))])
    const round = parseManifest(formatManifest(m))
    expect(round).toEqual({ ...m, files: m.files })
  })

  it('写出的文本能让两个架构都解析到 zip', () => {
    const m = parseManifest(formatManifest(mergeManifests([parseManifest(mk('arm64')), parseManifest(mk('x64'))])))
    expect(resolve(m.files, true)).toContain('arm64')
    expect(resolve(m.files, false)).toContain('x64')
  })
})

describe('assertBothArchesResolve', () => {
  it('双架构清单通过,返回两个不同的包名', () => {
    const m = mergeManifests([parseManifest(mk('arm64')), parseManifest(mk('x64'))])
    const r = assertBothArchesResolve(m)
    expect(r.arm).toContain('arm64')
    expect(r.x64).toContain('x64')
  })

  it('**单架构 x64 清单必须被拒** —— 那会让 Apple Silicon 装上 Intel 版', () => {
    // 脚本实际报的错比「某个架构取不到包」更准:x64-only 清单里两个架构
    // 解析到的是**同一个包**,因为 filterFilesForArch 在「没有 arm64 条目」
    // 时会退回到不过滤。锁住这条具体信息,免得以后把危险方向放过去。
    expect(() => assertBothArchesResolve(parseManifest(mk('x64')))).toThrow(
      /arm64 与 x64 解析到了同一个包/
    )
  })

  it('单架构 arm64 清单也必须被拒(Intel 会 ERR_UPDATER_ZIP_FILE_NOT_FOUND)', () => {
    expect(() => assertBothArchesResolve(parseManifest(mk('arm64')))).toThrow()
  })
})

describe('发版清单的前置条件', () => {
  it('electron-builder.yml 的 mac 目标必须同时含 dmg 与 zip', () => {
    // 少 zip = mac 用户装上后永远收不到自动更新,且没有任何报错
    const yml = fs.readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8')
    const macBlock = yml.slice(yml.indexOf('\nmac:'))
    expect(macBlock).toMatch(/- target: dmg/)
    expect(macBlock).toMatch(/- target: zip/)
  })

  it('CI 必须同时排 arm64 与 x64 两个 mac job(否则清单永远单架构)', () => {
    const ci = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
    expect(ci).toMatch(/macos-14/)
    expect(ci).toMatch(/macos-13/)
  })

  it('RELEASE.md 必须写明要合并,否则下一个人会直接上传覆盖', () => {
    const doc = fs.readFileSync(new URL('../docs/RELEASE.md', import.meta.url), 'utf8')
    expect(doc).toMatch(/merge-mac-manifest/)
    expect(doc).toMatch(/latest-mac\.yml/)
  })
})
