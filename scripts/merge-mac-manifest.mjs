/**
 * 合并多个单架构 `latest-mac.yml` 成一份双架构清单。
 *
 * ── 为什么需要它 ──
 *
 * 我们把 macOS 拆成两个 CI job(macos-14 出 arm64、macos-13 出 x64)。
 * 但 electron-builder **每个 job 都会产出一份叫 `latest-mac.yml` 的清单**,
 * 而一个 release 只能有一个同名文件 —— 后上传的会覆盖先上传的。
 *
 * 而 electron-updater 读的是**这一份**清单,然后从里面的 `files:` 列表按架构过滤
 * (`MacUpdater.filterFilesForArch`,即 node_modules/electron-updater/out/MacUpdater.js:30)。
 * 实测这个函数的行为:
 *
 *   清单只有 arm64 条目  → arm64 Mac 正常;Intel Mac 拿到空数组 → 抛
 *                          ERR_UPDATER_ZIP_FILE_NOT_FOUND
 *   清单只有 x64 条目    → Intel Mac 正常;**arm64 Mac 拿到的是 x64 包**
 *
 * 第二行是这个坑真正危险的地方:Apple Silicon 会**下载并安装 Intel 版**,
 * 而 sqlite-vec / onnxruntime / tokenizers 都是按架构编译的原生模块,
 * 换架构即损坏 —— 而且不报任何错,直到某个功能用到那个模块才崩。
 *
 * 拆两个 job 是为了绕开 Intel runner 排不到队,但代价是清单会互相覆盖。
 * 所以合并必须是一个**显式、可校验**的步骤,而不是"谁后传谁赢"。
 *
 * ── 用法 ──
 *
 *   node scripts/merge-mac-manifest.mjs out.yml arm64.yml x64.yml
 *
 * 合并完的清单两个架构都能解析到 zip,这一点由 assertBothArchesResolve()
 * 用 **electron-updater 自己的函数**验证 —— 不是我们复述一遍它的规则,
 * 所以将来升级 electron-updater 改了行为,这个脚本会跟着变。
 */
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require_ = createRequire(import.meta.url)

/**
 * 读 electron-builder 产出的清单。
 *
 * 刻意只认这一种结构:遇��别的形状就抛错,不猜、不静默丢字段。
 * 这份文件的用途是发版,猜错一个字段就是发出去一个坏更新。
 */
export function parseManifest(text, label = '<inline>') {
  const lines = text.split(/\r?\n/)
  const out = { version: null, files: [], path: null, sha512: null, releaseDate: null }
  let inFiles = false
  let cur = null

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (!line || line.trimStart().startsWith('#')) continue

    if (/^files:\s*$/.test(line)) {
      inFiles = true
      continue
    }
    if (inFiles && /^\S/.test(line)) {
      // files: 块结束,回到顶层
      inFiles = false
    }
    if (inFiles) {
      const m = line.match(/^\s*-\s*url:\s*(\S+)\s*$/)
      if (m) {
        cur = { url: m[1], sha512: null, size: null }
        out.files.push(cur)
        continue
      }
      const kv = line.match(/^\s+(sha512|size):\s*(\S+)\s*$/)
      if (kv) {
        if (!cur) throw new Error(`${label}: files 里有 ${kv[1]} 但前面没有 url`)
        cur[kv[1]] = kv[2]
        continue
      }
      if (!line.trim()) continue
      throw new Error(`${label}: files 里有无法解析的行 ${JSON.stringify(line)}`)
    }

    const kv = line.match(/^(version|path|sha512|releaseDate):\s*(.+?)\s*$/)
    if (kv) {
      out[kv[1]] = kv[2].replace(/^'|'$/g, '')
      continue
    }
    throw new Error(`${label}: 顶层无法解析的行 ${JSON.stringify(line)}`)
  }

  if (!out.version) throw new Error(`${label}: 缺少 version`)
  if (!out.path) throw new Error(`${label}: 缺少 path(updater 靠它决定装哪个包)`)
  if (!out.files.length) throw new Error(`${label}: files 为空`)
  for (const f of out.files) {
    if (!f.sha512) throw new Error(`${label}: ${f.url} 缺 sha512`)
    if (!f.size) throw new Error(`${label}: ${f.url} 缺 size`)
  }
  return out
}

/**
 * 合并多份清单。
 *
 * 版本不一致直接抛错 —— 两份清单描述的是两个不同的发布,
 * 混在一起会让某个架构拿到"另一个发布"的文件。
 */
export function mergeManifests(manifests) {
  if (manifests.length < 2) return manifests[0]
  const versions = new Set(manifests.map((m) => m.version))
  if (versions.size > 1) {
    throw new Error(
      `清单版本不一致: ${manifests.map((m) => `${m._label}=${m.version}`).join(', ')} —— ` +
        '这是两个不同的发布,不能合并'
    )
  }

  // files 按 url 去重。同名只应出现一次(两个 job 各自产出一份,内容本就不同文件)。
  const byUrl = new Map()
  for (const m of manifests) for (const f of m.files) byUrl.set(f.url, f)
  const files = [...byUrl.values()].sort((a, b) => a.url.localeCompare(b.url))

  // path/sha512 指向 updater 在「无法按架构判断」时用的那个包。
  // 取 arm64 优先(Apple Silicon 是主要受众),没有就退到第一份。
  const owner = manifests.find((m) => m.path.includes('arm64')) ?? manifests[0]
  const dates = manifests.map((m) => m.releaseDate).filter(Boolean).sort()
  return {
    version: owner.version,
    files,
    path: owner.path,
    sha512: owner.sha512,
    releaseDate: dates[dates.length - 1] ?? owner.releaseDate
  }
}

export function formatManifest(m) {
  const L = [`version: ${m.version}`, 'files:']
  for (const f of m.files) L.push(`  - url: ${f.url}`, `    sha512: ${f.sha512}`, `    size: ${f.size}`)
  L.push(`path: ${m.path}`, `sha512: ${m.sha512}`)
  if (m.releaseDate) L.push(`releaseDate: '${m.releaseDate}'`)
  return L.join('\n') + '\n'
}

/**
 * 用 electron-updater 自己的函数验证两个架构都能解析到 zip。
 *
 * 这一步是这个脚本存在的理由:合并如果只做"拼 files 数组",
 * 拼错了也只有等到用户点更新时才炸。所以合并完立刻按真实规则验一遍。
 */
export function assertBothArchesResolve(merged) {
  const M = require_('electron-updater/out/MacUpdater.js')
  const filter = (M.MacUpdater ?? M.default ?? M).filterFilesForArch
  if (typeof filter !== 'function') {
    throw new Error('取不到 electron-updater 的 filterFilesForArch,无法校验;拒绝输出未经验证的清单')
  }
  const asFiles = merged.files.map((f) => ({
    url: { pathname: '/d/' + f.url },
    info: { url: f.url }
  }))
  const pick = (isArm) => {
    const kept = filter(asFiles, isArm)
    return kept.find((f) => f.info.url.endsWith('.zip'))?.info.url ?? null
  }
  const arm = pick(true)
  const x64 = pick(false)
  if (!arm || !x64) {
    throw new Error(
      `合并后的清单有架构取不到 zip:arm64=${arm ?? '无'} x64=${x64 ?? '无'} —— ` +
        '这种情况发布出去,有人的「检查更新」会直接报错'
    )
  }
  if (arm === x64) {
    throw new Error(`arm64 与 x64 解析到了同一个包(${arm}) —— 合并没起作用`)
  }
  return { arm, x64 }
}

// ── CLI ────────────────────────────────────────────────────────────
// 标准判定:只在被直接执行时跑,被测试 import 时不跑
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [out, ...inputs] = process.argv.slice(2)
  if (!out || inputs.length < 2) {
    console.error('用法: node scripts/merge-mac-manifest.mjs <输出.yml> <arm64.yml> <x64.yml> [...]')
    process.exit(2)
  }
  const manifests = inputs.map((p) => {
    const m = parseManifest(fs.readFileSync(p, 'utf8'), p)
    m._label = p
    return m
  })
  const merged = mergeManifests(manifests)
  const { arm, x64 } = assertBothArchesResolve(merged)
  fs.writeFileSync(out, formatManifest(merged), 'utf8')

  console.log(`已合并 ${inputs.length} 份清单(均为 v${merged.version}):`)
  for (const f of merged.files) console.log(`  ${f.url}  ${(Number(f.size) / 1048576).toFixed(1)} MB`)
  console.log(`\n按 electron-updater 的实际规则校验:`)
  console.log(`  Apple Silicon  → ${arm}`)
  console.log(`  Intel          → ${x64}`)
  console.log(`\n写入 ${out}`)
}
