import fs from 'node:fs'
import path from 'node:path'

/**
 * fastembed 模型缓存的**坏包清理**与错误翻译。
 *
 * 2026-11-23 测试报告 P2-3:模型源
 * `https://storage.googleapis.com/qdrant-fastembed/fast-bge-small-zh-v1.5.tar.gz`
 * 返回 403 AccessDenied(399 字节 XML),fastembed 的下载实现不校验 HTTP 状态,
 * 把错误响应体直接写成 `.tar.gz` 缓存 → 解压必然 `TAR_BAD_ARCHIVE`,
 * 删掉重试又会再次毒化,**永不自愈**,用户只看得到一个看不懂的解压错误。
 *
 * 这里只做两件事(不改上游库):
 *   1. 启动/重试前把明显不是 gzip 的缓存文件删掉(下次会重新下载)
 *   2. 把解压类错误翻译成能采取行动的中文提示
 */

/** 合法 gzip 魔数;模型包 ~100MB,小于 1MB 的一律视为失败响应体 */
const MIN_VALID_BYTES = 1024 * 1024

export function sanitizeModelCache(cacheDir: string): string[] {
  const removed: string[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(cacheDir, { withFileTypes: true })
  } catch {
    return removed
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.tar.gz')) continue
    const full = path.join(cacheDir, entry.name)
    try {
      const size = fs.statSync(full).size
      let gzip = false
      if (size >= 2) {
        const fd = fs.openSync(full, 'r')
        try {
          const head = Buffer.alloc(2)
          fs.readSync(fd, head, 0, 2, 0)
          gzip = head[0] === 0x1f && head[1] === 0x8b
        } finally {
          fs.closeSync(fd)
        }
      }
      if (size < MIN_VALID_BYTES || !gzip) {
        fs.rmSync(full, { force: true })
        removed.push(entry.name)
      }
    } catch {
      /* 单个文件清理失败不影响启动 */
    }
  }
  return removed
}

const ARCHIVE_ERROR_RE =
  /TAR_BAD_ARCHIVE|Unrecognized archive format|incorrect header check|invalid (?:tar|gzip)|unexpected end of (?:file|input)/i

export function explainModelError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (ARCHIVE_ERROR_RE.test(msg)) {
    return (
      '模型下载失败:上游模型源返回的不是模型包(实测 storage.googleapis.com/qdrant-fastembed 返回 403 AccessDenied),' +
      '或下载中途断开;坏缓存已自动清理,可稍后重试。暂不打算用语义检索的话,可在 设置→智能引擎 关闭它 —— ' +
      '其余检索走 FTS,不受影响。'
    )
  }
  return msg
}
