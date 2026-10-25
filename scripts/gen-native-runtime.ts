#!/usr/bin/env node
/**
 * 打包「语义组件」zip —— 语义检索的原生栈(fastembed → onnxruntime-node /
 * @anush008/tokenizers / @huggingface/* 等)从安装包剥离后,首次启用时下载
 * (见 docs/DEVLOG 2026-10-25 瘦身条)。
 *
 * 闭包从 package-lock.json(v3 packages 树)以 fastembed 为根 BFS 收集,
 * 嵌套 node_modules 按 Node 解析规则逐级回溯;onnxruntime-node 包内带全平台
 * 二进制(~200MB),只保留目标平台的 bin/napi-v3/<plat>/<arch>,不裁剪的话
 * zip 会到 ~70MB。
 *
 * 用法:node scripts/gen-native-runtime.ts [--out dist] [--platform win32] [--arch x64]
 * 产物:<out>/native-runtime-<platform>-<arch>.zip(zip 根含 manifest.json + node_modules/…)
 *      manifest 的 appVersion 必须与运行中的应用版本一致(升级后重下组件)。
 *
 * ⚠ 用 .ts 而非 .mjs 是刻意的:Node ≥23.6 原生跑 type stripping(CI/本机均
 * Node 24),而单测要 import 这里的纯函数 —— 测试经 vitest import .mjs 在
 * CI Windows 上稳定炸 SyntaxError(v4.1.11,根因未明),纯 TS 链路则一路绿。
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')

interface LockPackage {
  version?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

interface LockFile {
  packages?: Record<string, LockPackage>
}

/** 从 lock 的 packages 树收集依赖闭包(含 optionalDependencies;按 Node 解析回溯嵌套)。 */
export function collectClosure(lock: LockFile, rootName: string): string[] {
  const packages = lock.packages ?? {}
  const resolveFrom = (dir: string, name: string): string | null => {
    let d = dir
    for (;;) {
      const cand = d ? `${d}/node_modules/${name}` : `node_modules/${name}`
      if (packages[cand]) return cand
      if (!d) return null
      const i = d.lastIndexOf('/node_modules/')
      d = i >= 0 ? d.slice(0, i) : ''
    }
  }
  const root = resolveFrom('', rootName)
  if (!root) throw new Error(`package-lock 中找不到 ${rootName}`)
  const seen = new Set<string>()
  const queue = [root]
  while (queue.length) {
    const cur = queue.shift() as string
    if (seen.has(cur)) continue
    seen.add(cur)
    const meta = packages[cur] ?? {}
    for (const sec of ['dependencies', 'optionalDependencies'] as const) {
      for (const name of Object.keys(meta[sec] ?? {})) {
        const r = resolveFrom(cur, name)
        if (r && !seen.has(r)) queue.push(r)
      }
    }
  }
  return [...seen]
}

/** onnxruntime-node 包内只留**目标平台**的推理二进制。rel 为相对包根的 POSIX 路径。 */
const ORT_BIN_KEEP: Record<string, string[]> = { win32: ['x64'], linux: ['x64'], darwin: ['arm64', 'x64'] }
export function keepOrtEntry(rel: string, platform: string): boolean {
  if (!rel.startsWith('bin/napi-v3/')) return true
  const rest = rel.slice('bin/napi-v3/'.length)
  const [plat, archDir = ''] = rest.split('/')
  return plat === platform && (ORT_BIN_KEEP[platform] ?? []).includes(archDir)
}

/**
 * 任意闭包包内都剔除的路径:CI 上 `npx electron-rebuild` 会在 gen 之前跑,
 * linux 上对 onnxruntime-node 走源码重编译,build/ 里几百 MB 中间产物——
 * 不剔除的话 linux 组件 zip 从 ~21MB 膨胀到 ~230MB(实测踩坑)。deps/ 是
 * 各原生包携带的 C/C++ 源码树,运行时同样不需要。DirectML.dll 是 Windows
 * GPU 推理后端(fastembed 默认 CPU,安装包 yml 早已排除,这里对齐)。
 * libonnxruntime_providers_* 是 CUDA/TensorRT 等 GPU provider 共享库
 * (linux 包内带了一个 327MB 的 cuda provider)——CPU 推理用不到,ORT
 * 加载 provider 失败会自动回落内置 EP。
 */
const PKG_PATH_EXCLUDE: RegExp[] = [
  /^build\//,
  /^deps\//,
  /\.o$/,
  /\.obj$/,
  /DirectML\.dll$/,
  /libonnxruntime_providers_/
]

/** tokenizers 平台包名里与平台/架构对应的标识;非目标平台的平台包整包跳过。 */
const TOKENIZER_PLATFORM_TAG: Record<string, string> = {
  win32: 'win32-x64',
  linux: 'linux-x64',
  darwin: 'darwin-universal'
}
export function isTokenizerPlatformPkg(key: string, platform: string): boolean {
  if (!/^node_modules\/@anush008\/tokenizers-/.test(key)) return true
  const tag = TOKENIZER_PLATFORM_TAG[platform] ?? ''
  return key.includes(tag)
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const argOf = (name: string): string | null => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : null
  }
  const appPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as { version: string }
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf-8')) as LockFile
  const platform = argOf('--platform') ?? process.platform
  const arch = argOf('--arch') ?? process.arch
  const outDir = path.resolve(ROOT, argOf('--out') ?? 'dist')

  if (!(platform in ORT_BIN_KEEP)) throw new Error(`不支持的平台: ${platform}`)

  const closure = collectClosure(lock, 'fastembed').sort()
  const zip = new AdmZip()
  const manifest = {
    appVersion: appPkg.version,
    platform,
    arch,
    packages: [] as Array<{ name: string; version: string }>,
    generatedAt: new Date().toISOString()
  }

  for (const key of closure) {
    const meta = lock.packages?.[key] ?? {}
    const srcDir = path.join(ROOT, key)
    if (!isTokenizerPlatformPkg(key, platform)) {
      console.warn(`跳过(非目标平台的 tokenizers 平台包): ${key}`)
      continue
    }
    if (!fs.existsSync(srcDir)) {
      // 平台相关的 optional 包在当前 runner 未装——CI 每平台各自构建,
      // 本 runner 没有就说明目标平台由 lock 里对应平台包装载
      console.warn(`跳过(本机未安装,平台相关 optional): ${key}`)
      continue
    }
    manifest.packages.push({ name: key, version: meta.version ?? '' })
    for (const f of walk(srcDir)) {
      const rel = path.relative(srcDir, f).split(path.sep).join('/')
      if (key === 'node_modules/onnxruntime-node' && !keepOrtEntry(rel, platform)) continue
      if (PKG_PATH_EXCLUDE.some((re) => re.test(rel))) continue
      zip.addLocalFile(f, path.posix.dirname(path.posix.join(key, rel)))
    }
  }

  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)))
  fs.mkdirSync(outDir, { recursive: true })
  const out = path.join(outDir, `native-runtime-${platform}-${arch}.zip`)
  zip.writeZip(out)
  const mb = (fs.statSync(out).size / 1024 / 1024).toFixed(1)
  console.log(`native runtime zip: ${out} (${mb} MB, ${manifest.packages.length} packages, v${appPkg.version} ${platform}-${arch})`)
  // 体积体检:>3MB 的条目打印出来 —— zip 意外膨胀时日志直接指出元凶
  // (CI linux 曾出现 229MB vs 本地 19MB,见 DEVLOG 2026-10-25)
  const big = zip
    .getEntries()
    .filter((e) => !e.isDirectory && e.header.size > 3 * 1024 * 1024)
    .sort((a, b) => b.header.size - a.header.size)
  for (const e of big) console.warn(`  大文件 ${(e.header.size / 1048576).toFixed(1)}MB  ${e.entryName}`)
}

const invokedDirectly =
  process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
