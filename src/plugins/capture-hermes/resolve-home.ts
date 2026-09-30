/**
 * Hermes 安装位置探测 —— **刻意与 sqlite / electron 完全解耦**。
 *
 * 为什么单独拆出来:这段逻辑只用到 node 内置的 fs / path / os / child_process,
 * 一行数据库代码都不碰。但它原先住在 `capture-hermes/index.ts` 里,而那个文件
 * import 了 `sqlite-ro`(→ better-sqlite3 原生模块)与 plugin-host。
 *
 * 后果是实打实的:`upstream/check.ts` 里的 hermes resolver 走
 * `await import('../src/plugins/capture-hermes/index')`,**import 语句缺 `.ts`
 * 扩展名**(check.ts 自己的静态 import 是带扩展名的,所以它能跑),Node ESM 直接
 * ERR_MODULE_NOT_FOUND;而 check.ts 当时的 catch 又把异常吞成「未找到」,
 * 于是报出「本机未检测到源(非故障)」—— **用户明明装着,看板却说没装**。
 * 这正是 checker_error 判定要防的那类事,只是当时漏在了 resolveRoot 这一层。
 *
 * 放在这里,探测链可以被任何纯 Node 环境(黑盒检查器、脚本、CI)直接复用。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 读取卸载注册表项里的 InstallLocation。
 *
 * **必须原样返回,不要在这里 strip 引号** —— 注册表 REG_SZ 的值有时带引号
 * (`"D:\Hermes Agent CN Desktop"`),但盘符扫描那条路是直接拼 `D:\Hermes...`
 * 的,两者都试一遍最省事;而调用方若自己拼路径,带引号就会得到一个
 * 以 `"` 开头结尾的非法路径,existsSync 恒 false 且毫无提示。
 */
function readRegistryInstallDir(): string | null {
  if (process.platform !== 'win32') return null
  try {
    const out = execFileSync(
      'reg',
      [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Hermes Agent CN Desktop',
        '/v',
        'InstallLocation'
      ],
      { encoding: 'utf-8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }
    )
    const m = out.match(/REG_SZ\s+(.+)/)
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}

/** 去掉注册表值可能带的成对引号 */
export function stripQuotes(p: string): string {
  const s = p.trim()
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s
}

/**
 * Hermes installs register an uninstall entry (installer builds) or live at a
 * drive root (portable layout "<install>\data\hermes-home"). A profilesRoot
 * recorded on another machine must not wedge detection, so probe: configured →
 * registry InstallLocation → every drive root → user home.
 *
 * @param configured 已知路径(来自配置/上次成功记录);不存在则继续探测
 * @param exists     注入以便单测
 * @param registry   注入以便单测
 */
export function resolveHermesHome(
  configured: string | undefined,
  exists: (p: string) => boolean = fs.existsSync,
  registryInstallDir: () => string | null = readRegistryInstallDir
): string | undefined {
  if (configured && exists(configured)) return configured
  const candidates: string[] = []
  const regDir = registryInstallDir()
  // 注册表值可能带引号,两条都试;顺序上先去引号版,命中就直接用
  if (regDir) {
    const bare = stripQuotes(regDir)
    candidates.push(path.join(bare, 'data', 'hermes-home'))
    if (bare !== regDir) candidates.push(path.join(regDir, 'data', 'hermes-home'))
  }
  for (const drive of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    candidates.push(`${drive}:\\Hermes Agent CN Desktop\\data\\hermes-home`)
  }
  candidates.push(path.join(os.homedir(), 'Hermes Agent CN Desktop', 'data', 'hermes-home'))
  return candidates.find((c) => exists(c)) ?? configured
}
