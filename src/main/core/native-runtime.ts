import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import AdmZip from 'adm-zip'

/**
 * 语义组件(fastembed → onnxruntime-node 等原生栈)的按需下载与加载。
 *
 * 安装包瘦身把这些依赖排除出 asar(electron-builder.yml),首次启用语义检索时
 * 从本版本的 GitHub Release 下载 native-runtime-<plat>-<arch>.zip 到
 * <dataDir>/native-runtime/,再经 createRequire 从该目录树加载 —— 语义检索的
 * 加载失败本来就降级为 no-op(纯 FTS),这套机制与「模型 ~100MB 首次使用才下载」
 * 的既有设计同构。
 *
 * manifest.appVersion 与运行中版本严格相等才视为可用:依赖版本随 lock 固定,
 * 升级后组件必须重下,避免新旧原生模块混用。
 */
export interface NativeRuntimeManifest {
  appVersion: string
  platform: string
  arch: string
  packages: Array<{ name: string; version: string }>
  generatedAt?: string
}

export function nativeRuntimeDir(dataDir: string): string {
  return path.join(dataDir, 'native-runtime')
}

export function readNativeRuntimeManifest(dataDir: string): NativeRuntimeManifest | null {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(nativeRuntimeDir(dataDir), 'manifest.json'), 'utf-8')
    ) as NativeRuntimeManifest
  } catch {
    return null
  }
}

export function isRuntimeCompatible(
  m: NativeRuntimeManifest | null,
  appVersion: string,
  platform: string,
  arch: string
): boolean {
  return (
    m != null &&
    m.appVersion === appVersion &&
    m.platform === platform &&
    m.arch === arch &&
    Array.isArray(m.packages) &&
    m.packages.length > 0
  )
}

export function nativeRuntimeAssetName(platform: string, arch: string): string {
  return `native-runtime-${platform}-${arch}.zip`
}

export function nativeRuntimeAssetUrl(appVersion: string, platform: string, arch: string): string {
  // 环境变量覆盖:测试 / 镜像 / 手动旁路用;不带也会生效(优先级最高)
  const override = process.env.MEMORYSQL_NATIVE_RUNTIME_URL
  if (override) return override
  return `https://github.com/Logic647/MemorySQL/releases/download/v${appVersion}/${nativeRuntimeAssetName(platform, arch)}`
}

/**
 * 下载并原子安装语义组件。旧目录换名挪走、新目录就位后才删旧 —— 中断最多
 * 留下 .old-/.tmp- 垃圾目录,不会留下半新半旧的 native-runtime。
 */
export async function downloadNativeRuntime(opts: {
  dataDir: string
  appVersion: string
  platform: string
  arch: string
}): Promise<NativeRuntimeManifest> {
  const url = nativeRuntimeAssetUrl(opts.appVersion, opts.platform, opts.arch)
  const res = await fetch(url, { signal: AbortSignal.timeout(600_000), redirect: 'follow' })
  if (!res.ok) throw new Error(`下载语义组件失败 HTTP ${res.status}(${url})`)
  const buf = Buffer.from(await res.arrayBuffer())

  const zip = new AdmZip(buf)
  const entry = zip.getEntry('manifest.json')
  if (!entry) throw new Error('组件包缺少 manifest.json')
  const manifest = JSON.parse(zip.readAsText(entry)) as NativeRuntimeManifest
  if (!isRuntimeCompatible(manifest, opts.appVersion, opts.platform, opts.arch)) {
    throw new Error(
      `组件包与当前应用不匹配(包: v${manifest.appVersion} ${manifest.platform}-${manifest.arch},` +
        ` 应用: v${opts.appVersion} ${opts.platform}-${opts.arch})`
    )
  }

  const dir = nativeRuntimeDir(opts.dataDir)
  const tmp = `${dir}.tmp-${Date.now()}`
  const old = `${dir}.old-${Date.now()}`
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(tmp, { recursive: true })
  try {
    zip.extractAllTo(tmp, true)
    if (fs.existsSync(dir)) fs.renameSync(dir, old)
    try {
      fs.renameSync(tmp, dir)
    } catch (err) {
      // 就位失败:把旧目录放回去,别让用户陷入"有 manifest 却没有 node_modules"的半安装态
      if (fs.existsSync(old)) fs.renameSync(old, dir)
      throw err
    }
  } finally {
    // 清理是尽力而为:Windows 下旧组件的 onnxruntime DLL 可能仍被本进程
    // 映射着,rmSync 会 EPERM —— 留下 .tmp-/.old- 垃圾目录无害(下次覆盖),
    // 但不能让它把一次成功的安装误报成失败
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
    try {
      fs.rmSync(old, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
  return manifest
}

/**
 * 从 <dataDir>/native-runtime 的 node_modules 树加载模块(裸包名)。
 * 未安装时抛「语义组件未安装…」——semantic-search 据此给出 runtimeMissing 状态。
 */
export function requireFromNativeRuntime<T>(dataDir: string, spec: string): T {
  const dir = nativeRuntimeDir(dataDir)
  if (!fs.existsSync(path.join(dir, 'node_modules'))) {
    throw new Error('语义组件未安装 —— 在设置 → 智能引擎 → 语义检索点「下载语义组件」')
  }
  const req = createRequire(path.join(dir, 'noop.js'))
  return req(spec) as T
}
