import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 用户应用数据目录。Windows 下是 %USERPROFILE%\AppData\Local|Roaming,
 * 其他平台按 XDG 约定。统一从这里取,避免各处直接读环境变量。
 */
export function userDataDir(kind: 'local' | 'roaming' = 'local'): string {
  const home = os.homedir()
  if (process.platform === 'win32') {
    return path.join(home, 'AppData', kind === 'local' ? 'Local' : 'Roaming')
  }
  return kind === 'local' ? path.join(home, '.local', 'share') : path.join(home, '.config')
}

/**
 * 路径边界校验。应用会读取不少"外部"目录(各 agent 的数据目录、用户登记的
 * 目录、命令行传入的路径),这些路径都可能被环境变量或参数影响。统一在这里
 * 做「解析 + 存在性 + 边界」三重校验,保证任何文件访问都不会越出预期根目录。
 */

/** 解析一个必须存在的目录,否则抛错 */
export function resolveDir(candidate: string, label = '目录'): string {
  const abs = path.resolve(candidate)
  let st: fs.Stats
  try {
    st = fs.statSync(abs)
  } catch {
    throw new Error(`${label}不存在: ${abs}`)
  }
  if (!st.isDirectory()) throw new Error(`${label}不是目录: ${abs}`)
  return abs
}

/**
 * 解析并校验一个目录;不存在或不是目录时返回 null——调用方按"该来源没有
 * 数据"处理(而不是抛错把整次扫描打断)。用于所有由环境变量/命令行
 * 传入的路径:先在这里收口,后续代码只使用校验后的绝对路径。
 */
export function safeDir(candidate: string): string | null {
  if (!candidate) return null
  const abs = path.resolve(candidate)
  try {
    return fs.statSync(abs).isDirectory() ? abs : null
  } catch {
    return null
  }
}

/** child 是否等于 root 或位于 root 之下 */
export function isWithin(root: string, child: string): boolean {
  const r = path.resolve(root)
  const c = path.resolve(child)
  return c === r || c.startsWith(r + path.sep)
}

/** 解析 child 并保证它不越出 root,否则抛错 */
export function withinRoot(root: string, child: string, label = '路径'): string {
  const abs = path.resolve(child)
  if (!isWithin(root, abs)) throw new Error(`${label}越界: ${abs}`)
  return abs
}

/**
 * 列出目录下的条目,只保留仍在 root 之内的条目(目录名来自 readdir,
 * 理论上不会是 "..",但符号链接与外部挂载点仍需防御)。
 */
export function listWithin(root: string, dir: string): fs.Dirent[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(path.resolve(dir), { withFileTypes: true })
  } catch {
    return []
  }
  return entries.filter((e) => isWithin(root, path.join(dir, e.name)))
}

/**
 * 递归遍历 root 之下的文件,由调用方决定文件名是否匹配。
 * 每一层都重新校验边界,任何越界路径直接跳过(不抛错,避免单个异常目录
 * 拖垮整次扫描)。
 */
export function walkWithin(root: string, dir: string, onFile: (file: string) => void): void {
  const absDir = path.resolve(dir)
  if (!isWithin(root, absDir)) return
  for (const e of listWithin(root, absDir)) {
    const full = path.join(absDir, e.name)
    if (!isWithin(root, full)) continue
    if (e.isDirectory()) walkWithin(root, full, onFile)
    else if (e.isFile()) onFile(full)
  }
}
