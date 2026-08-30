/**
 * Obsidian-compatible markdown note parsing: [[wikilinks]], inline #tags,
 * and a minimal frontmatter `tags:` line. Pure functions — unit-tested.
 */

const WIKILINK_RE = /\[\[([^\]#|]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g
const INLINE_TAG_RE = /(^|[\s(（【,，、])#([\w\u4e00-\u9fff][\w\u4e00-\u9fff/-]*)/g

export interface NoteMeta {
  title: string
  links: string[]
  tags: string[]
}

/** [[Link#anchor|alias]] → "Link" (trimmed, deduped, case preserved). */
export function extractLinks(content: string): string[] {
  const seen = new Set<string>()
  for (const match of content.matchAll(WIKILINK_RE)) {
    const target = match[1].trim()
    if (target) seen.add(target)
  }
  return [...seen]
}

/** Inline #tags and frontmatter `tags:` line, lowercased + deduped.
 * Tags must contain at least one letter/CJK char — filters out hex colors
 * and bare numbers (#336699, #42). */
export function extractTags(content: string): string[] {
  const seen = new Set<string>()
  const hasLetter = (t: string): boolean => /[a-z\u4e00-\u9fff]/i.test(t)
  const body = stripFrontmatter(content)
  for (const match of body.matchAll(INLINE_TAG_RE)) {
    const tag = match[2].toLowerCase()
    if (hasLetter(tag)) seen.add(tag)
  }
  const fm = readFrontmatter(content)
  const fmTags = fm.get('tags')
  if (fmTags) {
    // supports "tags: a, b" and "tags: [a, b]"
    for (const t of fmTags.replace(/[[\]]/g, '').split(/[,\s]+/)) {
      const clean = t.trim().toLowerCase()
      if (clean && hasLetter(clean)) seen.add(clean)
    }
  }
  return [...seen]
}

/** Minimal frontmatter reader: first `---` block, `key: value` lines. */
export function readFrontmatter(content: string): Map<string, string> {
  const map = new Map<string, string>()
  if (!content.startsWith('---')) return map
  const end = content.indexOf('\n---', 3)
  if (end < 0) return map
  for (const line of content.slice(4, end).split('\n')) {
    const idx = line.indexOf(':')
    if (idx > 0) map.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim())
  }
  return map
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith('---')) return content
  const end = content.indexOf('\n---', 3)
  return end < 0 ? content : content.slice(content.indexOf('\n', end + 1) + 1)
}

/** First `# heading` or first non-empty line, else fallback. */
export function noteTitle(content: string, fileStem: string): string {
  const body = stripFrontmatter(content)
  for (const line of body.split('\n')) {
    const t = line.trim()
    if (t.startsWith('# ') && t.length > 2) return t.slice(2).trim().slice(0, 80)
    if (t) return t.slice(0, 80)
  }
  return fileStem
}

export function parseNote(content: string, fileStem: string): NoteMeta {
  return {
    title: noteTitle(content, fileStem),
    links: extractLinks(content),
    tags: extractTags(content)
  }
}
