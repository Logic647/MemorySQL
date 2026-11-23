/**
 * 项目关键词解析 —— MCP 工具(memory_get_context / brief / digest / list_sessions /
 * search / write / log_progress)共用同一套口径。
 *
 * 背景(2026-11-23 真机会话 #574):过去是 `name LIKE '%关键词%'` 全命中就合并,
 * 于是 `new-chat` 把 6 月的 `new-chat-7` 也并了进来 —— agent 看到的"项目记忆"
 * 其实是另一个项目的,直接在回答里写出了「结构性发现:两个同名项目被合并」。
 *
 * 现在的三级口径:
 *   1. **项目名精确相等**(忽略大小写)→ 全部合并。换机/换盘后同名项目是
 *      同一项目多份登记(F:\桌面\MemorySQL 与 H:\桌面\MemorySQL),应当合并。
 *   2. **路径段精确相等**(用户贴路径或目录名)→ 合并(通常只有一个)。
 *   3. **子串兜底** → 只取最近活跃的**一个**,其余作为候选列给 agent。
 *      子串天然会误伤(new-chat 命中 new-chat-7),宁可少并也不要把无关项目
 *      的记忆混进回答。
 *
 * 命中方式不是"精确单个"时,输出里必须自报家门(describeProjectMatch),
 * 让 agent 知道该怎么消歧,而不是默默给出可能串了项目的结论。
 */

export interface ProjectCandidate {
  id: number
  name: string | null
  path: string | null
  /** 最近活跃时间(ms),用于候选排序;缺省按 0 处理 */
  activity?: number
}

export type ProjectMatchTier = 'exact' | 'path' | 'substring'

export interface ProjectMatch {
  tier: ProjectMatchTier
  /** 参与合并的项目(精确/路径命中可能多个;子串命中只有一个) */
  rows: ProjectCandidate[]
  /** 子串兜底时未被纳入的候选(仅供提示 agent 消歧) */
  others: ProjectCandidate[]
}

const norm = (s: string): string => s.trim().toLowerCase()

const pathSegments = (p: string): string[] => p.split(/[\\/]+/).filter(Boolean)

export function matchProjects(rows: ProjectCandidate[], keywordRaw: string): ProjectMatch | null {
  const keyword = norm(keywordRaw ?? '')
  if (!keyword) return null
  const byActivity = [...rows].sort((a, b) => (b.activity ?? 0) - (a.activity ?? 0))

  // 1. 项目名精确相等(跨机/跨盘的多份登记应当合并)
  const exact = byActivity.filter((r) => norm(r.name ?? '') === keyword)
  if (exact.length > 0) return { tier: 'exact', rows: exact, others: [] }

  // 2. 路径段精确相等(用户直接给了路径或目录名)
  const byPath = byActivity.filter(
    (r) => r.path != null && pathSegments(r.path).some((s) => norm(s) === keyword)
  )
  if (byPath.length > 0) return { tier: 'path', rows: byPath, others: [] }

  // 3. 子串兜底:只取最近活跃的一个,其余列为候选
  const fuzzy = byActivity.filter(
    (r) =>
      (r.name ?? '').toLowerCase().includes(keyword) ||
      (r.path ?? '').toLowerCase().includes(keyword)
  )
  if (fuzzy.length === 0) return null
  return { tier: 'substring', rows: [fuzzy[0]], others: fuzzy.slice(1) }
}

const label = (p: ProjectCandidate): string =>
  `#${p.id} ${p.name ?? '(未命名)'}${p.path ? `(${p.path})` : ''}`

/**
 * 输出给 agent 的「项目解析」说明。精确单命中返回 null(不需要解释);
 * 其余情况必须写明:合并了谁、为什么、还能怎么指定 —— 这是 agent 纠偏的唯一线索。
 */
export function describeProjectMatch(match: ProjectMatch, keyword: string): string | null {
  if (match.tier === 'exact') {
    if (match.rows.length <= 1) return null
    return `> 项目解析:「${keyword}」按**项目名精确匹配**到 ${match.rows.length} 个同名项目(换机/换盘的多份登记),已合并:${match.rows
      .map(label)
      .join('、')}`
  }
  if (match.tier === 'path') {
    return `> 项目解析:「${keyword}」按**路径目录名**匹配:${match.rows.map(label).join('、')}`
  }
  const head = `> 项目解析:「${keyword}」没有同名项目,按**子串**取最近活跃的 ${label(match.rows[0])}`
  if (match.others.length === 0) return head
  return (
    `${head};另有 ${match.others.length} 个候选**未纳入**:${match.others
      .slice(0, 5)
      .map(label)
      .join('、')}(要指定请传完整项目名或路径)`
  )
}
