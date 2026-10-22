import crypto from 'node:crypto'

/**
 * Hermes stores long-term memories in MEMORY.md / USER.md as multiple entries
 * separated by a `§` marker at line start. Importing the whole file as one
 * memory blends unrelated facts (network notes + project progress + gotchas)
 * into a single blob — split them so each segment becomes its own memory.
 */
export function splitHermesMemoryFile(content: string): string[] {
  const segments: string[] = []
  let current: string[] = []
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*§/.test(line)) {
      if (current.some((l) => l.trim())) segments.push(current.join('\n'))
      // text after the marker (e.g. "§ 标题") starts the new segment
      const rest = line.replace(/^\s*§\s*/, '')
      current = rest.trim() ? [rest] : []
    } else {
      current.push(line)
    }
  }
  if (current.some((l) => l.trim())) segments.push(current.join('\n'))
  return segments.map((s) => s.trim()).filter((s) => s.length > 0)
}

/**
 * Content-addressed source key for one segment. Editing a memory in Hermes
 * yields a new key (fresh row), reordering keeps keys stable (no churn), and
 * identical segments dedupe naturally. The importer tombstones keys that no
 * longer appear in the file, including the legacy whole-file row.
 */
export function segmentSource(rel: string, content: string): string {
  // 内容寻址用 sha256(不用 md5/sha1 —— 弱哈希可被构造碰撞,会让两段不同内容
  // 共用同一个 source key,记忆去重就会误判)
  const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 10)
  return `hermes:${rel}#${hash}`
}
