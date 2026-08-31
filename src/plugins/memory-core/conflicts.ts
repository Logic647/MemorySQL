export interface ConflictItem {
  id: number
  kind: string
  content: string
}

export interface ConflictPair {
  aId: number
  bId: number
  reason: string
}

const clip = (t: string, max: number): string => {
  const s = t.replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/**
 * LLM-based memory conflict detection (the last M6 governance item). The LLM
 * only *reports* suspicious pairs — nothing is auto-retired; the user decides
 * in the UI. Falls back gracefully when no LLM is configured (caller checks).
 */
export function buildConflictPrompt(items: ConflictItem[]): string {
  const list = items
    .map((i) => JSON.stringify({ id: i.id, kind: i.kind, content: clip(i.content, 160) }))
    .join('\n')
  return [
    '下面是知识库中的若干条记忆(JSON)。请找出**互相矛盾**的记录对:',
    '同一事实/状态的新旧两个版本(如"服务器用 SSH 推送" vs "服务器改用 HTTPS 推送")、互斥的结论、冲突的偏好。',
    '单纯的补充、细化、不同主题或不同项目之间的差异**不算**矛盾。',
    '只输出 JSON 数组,格式 [{"a":id,"b":id,"reason":"矛盾原因"}],按严重程度排序;没有矛盾输出 []。不要输出其它文字。',
    '',
    list
  ].join('\n')
}

export function parseConflictResponse(text: string, validIds: Set<number>): ConflictPair[] {
  const cleaned = text.replace(/```json|```/g, '').trim()
  const start = cleaned.indexOf('[')
  const end = cleaned.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  let items: Array<{ a?: unknown; b?: unknown; reason?: unknown }>
  try {
    items = JSON.parse(cleaned.slice(start, end + 1)) as typeof items
  } catch {
    return []
  }
  const seen = new Set<string>()
  const out: ConflictPair[] = []
  for (const it of items) {
    const a = Number(it.a)
    const b = Number(it.b)
    const reason = typeof it.reason === 'string' ? it.reason.trim() : ''
    if (!Number.isInteger(a) || !Number.isInteger(b) || a === b) continue
    if (!validIds.has(a) || !validIds.has(b)) continue
    if (!reason) continue
    const key = a < b ? `${a}|${b}` : `${b}|${a}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ aId: a, bId: b, reason })
  }
  return out
}
