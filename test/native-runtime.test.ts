import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// 用 .ts 而非 .mjs:vitest 经 vite 加载 .mjs 在 CI Windows 上稳定炸
// SyntaxError(v4.1.11);脚本本体已改为 .ts(Node ≥23.6 原生 type stripping)
import { collectClosure, keepOrtEntry } from '../scripts/gen-native-runtime'
import {
  downloadNativeRuntime,
  isRuntimeCompatible,
  nativeRuntimeAssetUrl,
  readNativeRuntimeManifest,
  requireFromNativeRuntime
} from '../src/main/core/native-runtime'

describe('collectClosure(依赖闭包收集)', () => {
  it('真实 package-lock:fastembed 闭包含语义栈全部关键包', () => {
    const lockPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package-lock.json')
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as unknown
    const closure = collectClosure(lock as Parameters<typeof collectClosure>[0], 'fastembed')
    for (const want of [
      'node_modules/fastembed',
      'node_modules/onnxruntime-node',
      'node_modules/@huggingface/hub',
      'node_modules/@anush008/tokenizers',
      'node_modules/progress',
      'node_modules/tar'
    ]) {
      expect(closure, `闭包应含 ${want}`).toContain(want)
    }
  })

  it('嵌套 node_modules 按 Node 解析规则回溯', () => {
    const lock = {
      lockfileVersion: 3,
      packages: {
        'node_modules/a': { version: '1.0.0', dependencies: { b: '*', c: '*' } },
        'node_modules/a/node_modules/b': { version: '2.0.0', dependencies: { c: '*' } }, // 嵌套的旧版 c
        'node_modules/b': { version: '9.0.0' },
        'node_modules/c': { version: '1.0.0' }
      }
    }
    const closure = collectClosure(lock, 'a')
    expect(closure).toContain('node_modules/a/node_modules/b') // a 的 b 是嵌套版本
    expect(closure).toContain('node_modules/c') // 嵌套 b 的 c 回溯到顶层
    expect(closure).not.toContain('node_modules/b') // 顶层 b 与 a 无关
  })
})

describe('keepOrtEntry(onnxruntime 平台裁剪)', () => {
  it('win32 只留 win32/x64,其余平台目录剔除;非 bin 目录全保留', () => {
    expect(keepOrtEntry('bin/napi-v3/win32/x64/onnxruntime.node', 'win32')).toBe(true)
    expect(keepOrtEntry('bin/napi-v3/darwin/arm64/onnxruntime.node', 'win32')).toBe(false)
    expect(keepOrtEntry('bin/napi-v3/linux/x64/onnxruntime.node', 'win32')).toBe(false)
    expect(keepOrtEntry('bin/napi-v3/win32/arm64/onnxruntime.node', 'win32')).toBe(false)
    expect(keepOrtEntry('dist/onnxrt.js', 'win32')).toBe(true)
    expect(keepOrtEntry('package.json', 'win32')).toBe(true)
  })

  it('darwin 两个架构都保留', () => {
    expect(keepOrtEntry('bin/napi-v3/darwin/arm64/libonnxruntime.dylib', 'darwin')).toBe(true)
    expect(keepOrtEntry('bin/napi-v3/darwin/x64/libonnxruntime.dylib', 'darwin')).toBe(true)
    expect(keepOrtEntry('bin/napi-v3/win32/x64/onnxruntime.node', 'darwin')).toBe(false)
  })
})

describe('manifest 兼容判定与下载源', () => {
  it('版本/平台/架构任一不匹配即不兼容', () => {
    const m = { appVersion: '0.7.0', platform: 'win32', arch: 'x64', packages: [{ name: 'x', version: '1' }] }
    expect(isRuntimeCompatible(m, '0.7.0', 'win32', 'x64')).toBe(true)
    expect(isRuntimeCompatible(m, '0.7.1', 'win32', 'x64')).toBe(false)
    expect(isRuntimeCompatible(m, '0.7.0', 'linux', 'x64')).toBe(false)
    expect(isRuntimeCompatible(m, '0.7.0', 'win32', 'arm64')).toBe(false)
    expect(isRuntimeCompatible(null, '0.7.0', 'win32', 'x64')).toBe(false)
    expect(isRuntimeCompatible({ ...m, packages: [] }, '0.7.0', 'win32', 'x64')).toBe(false)
  })

  it('下载源指向本版本 Release;环境变量可覆盖(测试/镜像)', () => {
    expect(nativeRuntimeAssetUrl('0.7.0', 'win32', 'x64')).toBe(
      'https://github.com/Logic647/MemorySQL/releases/download/v0.7.0/native-runtime-win32-x64.zip'
    )
    process.env.MEMORYSQL_NATIVE_RUNTIME_URL = 'http://127.0.0.1:1/test.zip'
    try {
      expect(nativeRuntimeAssetUrl('0.7.0', 'win32', 'x64')).toBe('http://127.0.0.1:1/test.zip')
    } finally {
      delete process.env.MEMORYSQL_NATIVE_RUNTIME_URL
    }
  })
})

describe('downloadNativeRuntime / requireFromNativeRuntime(端到端,本地 http 服务)', () => {
  let tmp: string
  let server: http.Server
  let url: string

  const buildZip = (appVersion: string): Buffer => {
    const zip = new AdmZip()
    zip.addFile(
      'manifest.json',
      Buffer.from(JSON.stringify({ appVersion, platform: 'linux', arch: 'x64', packages: [{ name: 'node_modules/fastembed', version: '1.0.0' }] }))
    )
    zip.addFile('node_modules/fastembed/package.json', Buffer.from(JSON.stringify({ name: 'fastembed', version: '1.0.0', main: 'index.js' })))
    zip.addFile('node_modules/fastembed/index.js', Buffer.from("module.exports = { hello: 'from-runtime' }\n"))
    return zip.toBuffer()
  }

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'native-runtime-'))
    // platform 用 linux(与运行机无关的假想目标,只考验下载/安装逻辑本身)
    server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'application/zip')
      res.end(buildZip('0.7.0'))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address() as { port: number }
    url = `http://127.0.0.1:${addr.port}/runtime.zip`
    process.env.MEMORYSQL_NATIVE_RUNTIME_URL = url
  })

  afterEach(async () => {
    delete process.env.MEMORYSQL_NATIVE_RUNTIME_URL
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('下载 → 解压 → manifest 就位 → 可从 runtime 树 require 模块', async () => {
    // 同步 API:未安装时当场抛错,不是 reject
    expect(() => requireFromNativeRuntime(tmp, 'fastembed')).toThrow('语义组件未安装')
    const m = await downloadNativeRuntime({ dataDir: tmp, appVersion: '0.7.0', platform: 'linux', arch: 'x64' })
    expect(m.appVersion).toBe('0.7.0')
    expect(readNativeRuntimeManifest(tmp)?.appVersion).toBe('0.7.0')
    const mod = requireFromNativeRuntime<{ hello: string }>(tmp, 'fastembed')
    expect(mod.hello).toBe('from-runtime')
  })

  it('版本不匹配的组件包被拒绝,不落任何文件', async () => {
    // 服务端固定回 0.7.0 的包,应用侧自称 0.8.0 → 必须拒装
    await expect(
      downloadNativeRuntime({ dataDir: tmp, appVersion: '0.8.0', platform: 'linux', arch: 'x64' })
    ).rejects.toThrow('不匹配')
    expect(fs.existsSync(path.join(tmp, 'native-runtime'))).toBe(false)
  })
})
