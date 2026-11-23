import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { explainModelError, sanitizeModelCache } from '../src/plugins/semantic-search/model-cache'

/**
 * 2026-11-23 测试报告 P2-3:模型源 403 的错误响应体被 fastembed 写成
 * `fast-bge-small-zh-v1.5.tar.gz`(399 字节),解压永久失败且不自愈。
 */
let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msql-model-cache-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('sanitizeModelCache', () => {
  it('删掉伪装成 .tar.gz 的错误响应体,保留真 gzip', () => {
    // 坏包:403 XML,399 字节
    const bad = path.join(dir, 'fast-bge-small-zh-v1.5.tar.gz')
    fs.writeFileSync(bad, '<Error><Code>AccessDenied</Code></Error>')
    // 好包:gzip 魔数 + 足够大
    const good = path.join(dir, 'other-model.tar.gz')
    const buf = Buffer.alloc(2 * 1024 * 1024, 0)
    buf[0] = 0x1f
    buf[1] = 0x8b
    fs.writeFileSync(good, buf)
    // 无关文件不动
    const txt = path.join(dir, 'readme.txt')
    fs.writeFileSync(txt, 'keep me')

    const removed = sanitizeModelCache(dir)

    expect(removed).toEqual(['fast-bge-small-zh-v1.5.tar.gz'])
    expect(fs.existsSync(bad)).toBe(false)
    expect(fs.existsSync(good)).toBe(true)
    expect(fs.existsSync(txt)).toBe(true)
  })

  it('过小但魔数正确的包也删(截断的下载)', () => {
    const truncated = path.join(dir, 'x.tar.gz')
    fs.writeFileSync(truncated, Buffer.from([0x1f, 0x8b, 0x08, 0x00]))
    expect(sanitizeModelCache(dir)).toEqual(['x.tar.gz'])
  })

  it('目录不存在时安静返回(首次启用)', () => {
    expect(sanitizeModelCache(path.join(dir, 'nope'))).toEqual([])
  })
})

describe('explainModelError', () => {
  it('解压类错误翻译成可行动的中文提示', () => {
    const text = explainModelError(new Error('TAR_BAD_ARCHIVE: Unrecognized archive format'))
    expect(text).toContain('上游模型源')
    expect(text).toContain('坏缓存已自动清理')
  })

  it('其它错误原样透传(不吞掉真实原因)', () => {
    expect(explainModelError(new Error('ENOSPC: no space left'))).toContain('ENOSPC')
  })
})
