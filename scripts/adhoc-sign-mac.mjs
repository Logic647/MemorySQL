import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/**
 * macOS Ad-Hoc 签名(afterPack 钩子)。
 *
 * 背景(2026-11-28,另一 agent 在 Apple Silicon 实测):
 * `mac.identity: null` + CI 的 `CSC_IDENTITY_AUTO_DISCOVERY: false` 让
 * electron-builder 完全跳过签名,产物 `Contents/` 下没有 `_CodeSignature`,
 * 但 Electron 可执行文件仍带编译期的残缺 `adhoc,linker-signed` 头 →
 * `codesign --verify --deep --strict` 报
 * 「code has no resources but signature indicates they must be present」。
 * 在 macOS 15+/Apple Silicon 上,Gatekeeper 会把「浏览器下载的 quarantine
 * 标记 + 签名结构残缺」判定成**「已损坏,应移到废纸篓」**,连
 * 「系统设置 → 隐私与安全性 → 仍要打开」的入口都不给。
 *
 * 这里在打包后对 .app 补一次**完整合规的 ad-hoc 签名**(`codesign --sign -`),
 * 让用户看到的是正常的「Apple 无法验证」提示,可以在图形界面里点「仍要打开」。
 *
 * 两条硬约束:
 *   1. **不加 `--options runtime`**(Hardened Runtime):本项目运行时加载
 *      better-sqlite3 / sqlite-vec(vec0.dylib)以及从 Release 动态下载的
 *      native-runtime-darwin-*.zip(onnxruntime-node)。开启 Hardened Runtime
 *      但没有 disable-library-validation entitlement 会直接崩在加载动态库。
 *   2. **检测到正式证书(CSC_LINK)就整体跳过**:将来接入 Apple Developer ID
 *      时这里不应干扰 electron-builder 自己的签名与公证流程。
 */

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: 'inherit' })
}

/** 找出需要单独签名的原生二进制(.node / .dylib) */
function collectNativeBinaries(dir, results = []) {
  if (!fs.existsSync(dir)) return results
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      collectNativeBinaries(full, results)
    } else if (entry.name.endsWith('.node') || entry.name.endsWith('.dylib')) {
      results.push(full)
    }
  }
  return results
}

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  if (process.env.CSC_LINK) {
    console.log('[adhoc-sign-mac] CSC_LINK detected — 交给 electron-builder 正式签名,跳过 ad-hoc')
    return
  }

  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${appName}.app`)
  if (!fs.existsSync(appPath)) {
    throw new Error(`[adhoc-sign-mac] 找不到产物: ${appPath}`)
  }
  console.log(`[adhoc-sign-mac] Signing ${appPath}`)

  // 1. 打包产物里可能残留扩展属性(quarantine 等),先清掉
  run('xattr', ['-cr', appPath])

  // 2. 先给 app.asar.unpacked 里的原生二进制逐个签名
  //    (better-sqlite3 的 .node、sqlite-vec 的 vec0.dylib;--deep 也会处理,
  //     但逐个签能让错误信息直接指向出问题的那个文件)
  const unpackedDir = path.join(appPath, 'Contents', 'Resources', 'app.asar.unpacked')
  const binaries = collectNativeBinaries(unpackedDir)
  console.log(`[adhoc-sign-mac] native binaries: ${binaries.length}`)
  for (const bin of binaries) {
    run('codesign', ['--force', '--sign', '-', bin])
  }

  // 3. 整个 .app(含 Frameworks 与 Helper.app)——不加 --options runtime
  run('codesign', ['--force', '--deep', '--sign', '-', appPath])

  // 4. 严格校验 Sealed Resources(失败即让整个 mac job 失败,绝不发出残缺包)
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])

  console.log(`[adhoc-sign-mac] Verified ad-hoc signature for ${appPath}`)
}
