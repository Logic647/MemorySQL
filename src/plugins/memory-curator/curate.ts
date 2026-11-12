import type Database from 'better-sqlite3'

export type CuratorKind = 'persona' | 'preference' | 'fact' | 'decision'

export const CURATOR_KINDS: ReadonlySet<string> = new Set(['persona', 'preference', 'fact', 'decision'])

export interface CuratorMemoryRow {
  id: number
  kind: string
  content: string
  locked: number
  confidence: number
  updated_at: number
  access_count: number
  last_access_at: number | null
}

export interface CuratorOp {
  op: 'add' | 'update' | 'retire'
  id?: number
  kind?: CuratorKind
  content?: string
  confidence?: number
  reason?: string
}

export interface DigestInput {
  id: number
  summary: string
  recent: string
  todos: Array<{ content: string; status?: string }>
  decisions: string[]
  createdAt: number
}

export interface ProjectInput {
  id: number
  name: string
  path?: string | null
  techStack?: string | null
}

export interface ApplyResult {
  added: number
  updated: number
  retired: number
  skipped: number
}

const clip = (s: string, n: number): string => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/** 简化版 TMT 热度:e^(-0.5×天数) × (1+ln(1+访问数)) × 置信度。只用于排序/淘汰。 */
export function heatScore(
  row: { access_count?: number; last_access_at?: number | null; updated_at: number; confidence?: number },
  now = Date.now()
): number {
  const last = row.last_access_at ?? row.updated_at
  const days = Math.max(0, (now - last) / 86_400_000)
  const confidence = typeof row.confidence === 'number' && row.confidence > 0 ? row.confidence : 1
  return Math.exp(-0.5 * days) * (1 + Math.log1p(Math.max(0, row.access_count ?? 0))) * confidence
}

const PROJECT_SYSTEM = `你是项目记忆整理器。根据项目总结与已有记忆,输出需要新增/更新/停用的**项目记忆**,严格 JSON(不要 markdown 代码块,不要多余文字):
{"project":[{"op":"add","kind":"persona|preference|fact|decision","content":"一条只写一件事的短句(≤200 字)","confidence":0.8},
           {"op":"update","id":已有记忆数字id,"kind":"…","content":"修正后的短句","confidence":0.9},
           {"op":"retire","id":已有记忆数字id,"reason":"为什么过时/被取代"}]}
规则:
- 只写项目总结/最近进展能直接支持的事实,不要推测;临时进度、一次性操作、流水账不要写成记忆。
- 先复用已有 id:已有记忆只需补充/修正时用 update;被新决策取代/矛盾时用 retire;只有全新信息才 add。
- 已有记忆 locked=true 的条目是用户手写的,**不要输出 update 或 retire**。
- 一条记忆只写一个结论;不要写密钥/令牌/密码的值(只写位置)。
- 最多 add 8 条;没有需要变更的就输出 {"project":[]}。
- 全局记忆不要在这里输出(由单独的全局整理负责)。`

const GLOBAL_SYSTEM = `你是全局记忆整理器。跨多个项目,提炼可长期复用的**全局记忆**(开发者画像/偏好/事实/决策),严格 JSON:
{"global":[{"op":"add","kind":"persona|preference|fact|decision","content":"≤200 字","confidence":0.8},
            {"op":"update","id":已有全局记忆id,"kind":"…","content":"…","confidence":0.9},
            {"op":"retire","id":已有全局记忆id,"reason":"…"}]}
规则:
- 只提炼**跨项目稳定**的结论:用户角色/技术偏好/工作方式/反复出现的约束;项目专属细节不要提升为全局。
- 先复用已有全局 id;用户手写(locked=true)的条目不要 update/retire。
- 最多 add 4 条;没有变更就输出 {"global":[]}。
- 不要写密钥/令牌/密码的值。`

function renderMemories(rows: CuratorMemoryRow[]): string {
  return JSON.stringify(
    rows.slice(0, 120).map((r) => ({
      id: r.id,
      kind: r.kind,
      content: clip(r.content, 300),
      locked: r.locked === 1
    }))
  )
}

function renderDigest(d: DigestInput): string {
  const todos = d.todos
    .filter((t) => t && t.status !== 'done')
    .slice(0, 20)
    .map((t) => `- ${clip(t.content, 200)}`)
  return [
    `# 最新总结 #${d.id}`,
    '## 项目总览',
    clip(d.summary, 3000) || '(空)',
    '## 最近进展',
    clip(d.recent, 4000) || '(空)',
    ...(todos.length > 0 ? ['## 未完成待办', ...todos] : []),
    ...(d.decisions.length > 0
      ? ['## 本窗口决策', ...d.decisions.slice(0, 20).map((x) => `- ${clip(x, 200)}`)]
      : [])
  ].join('\n')
}

export function buildProjectCurationPrompt(input: {
  project: ProjectInput
  digest: DigestInput
  projectMemories: CuratorMemoryRow[]
  globalMemories: CuratorMemoryRow[]
}): string {
  return [
    `# 项目: ${input.project.name}`,
    input.project.path ? `路径: ${input.project.path}` : '',
    input.project.techStack ? `技术栈: ${clip(input.project.techStack, 500)}` : '',
    '',
    renderDigest(input.digest),
    '',
    '## 已有项目记忆(可 update/retire;locked=true 不可动)',
    renderMemories(input.projectMemories),
    '',
    '## 已有全局记忆(仅供避免重复,不要输出全局变更)',
    renderMemories(input.globalMemories),
    '',
    '## 任务',
    '输出 {"project":[...]}。只保留对「接手这个项目」有长期价值的内容。'
  ]
    .filter((x) => x !== '')
    .join('\n')
}

export function buildGlobalCurationPrompt(input: {
  projectMemories: Array<CuratorMemoryRow & { projectName?: string }>
  globalMemories: CuratorMemoryRow[]
}): string {
  return [
    '## 各项目的活跃记忆(用于提炼跨项目共性)',
    JSON.stringify(
      input.projectMemories.slice(0, 80).map((r) => ({
        project: r.projectName ?? '',
        kind: r.kind,
        content: clip(r.content, 200)
      }))
    ),
    '',
    '## 已有全局记忆(可 update/retire;locked=true 不可动)',
    renderMemories(input.globalMemories),
    '',
    '## 任务',
    '输出 {"global":[...]}。只写跨项目稳定、长期有效的结论;宁缺毋滥。'
  ].join('\n')
}

export function projectSystemPrompt(): string {
  return PROJECT_SYSTEM
}

export function globalSystemPrompt(): string {
  return GLOBAL_SYSTEM
}

function balancedEnd(s: string, start: number): number {
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (esc) {
      esc = false
      continue
    }
    if (c === '\\') {
      esc = true
      continue
    }
    if (c === '"') {
      inStr = !inStr
      continue
    }
    if (inStr) continue
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function findArray(text: string, key: 'project' | 'global'): unknown[] | null {
  const cleaned = text.replace(/```json|```/g, '').trim()
  const candidates: string[] = [cleaned]
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] !== '{') continue
    const end = balancedEnd(cleaned, i)
    if (end < 0) break
    candidates.push(cleaned.slice(i, end + 1))
    i = end
  }
  for (const c of candidates) {
    try {
      const o = JSON.parse(c) as Record<string, unknown>
      const arr = o[key]
      if (Array.isArray(arr)) return arr
    } catch {
      /* try next */
    }
  }
  return null
}

function normalizeOps(
  text: string,
  key: 'project' | 'global',
  allowedIds: ReadonlySet<number>,
  maxAdds: number
): CuratorOp[] {
  const arr = findArray(text, key)
  if (!arr) return []
  const out: CuratorOp[] = []
  let adds = 0
  for (const raw of arr) {
    if (typeof raw !== 'object' || raw === null) continue
    const r = raw as Record<string, unknown>
    const op = r.op
    if (op !== 'add' && op !== 'update' && op !== 'retire') continue
    if (op === 'add') {
      if (adds >= maxAdds) continue
      if (typeof r.content !== 'string' || !r.content.trim()) continue
      if (typeof r.kind !== 'string' || !CURATOR_KINDS.has(r.kind)) continue
      adds++
      out.push({
        op,
        kind: r.kind as CuratorKind,
        content: clip(r.content, 300),
        confidence: typeof r.confidence === 'number' ? Math.min(1, Math.max(0, r.confidence)) : 0.8
      })
      continue
    }
    const id = Number(r.id)
    if (!Number.isInteger(id) || id <= 0 || !allowedIds.has(id)) continue
    if (op === 'retire') {
      out.push({ op, id, reason: typeof r.reason === 'string' ? clip(r.reason, 200) : undefined })
      continue
    }
    if (typeof r.content !== 'string' || !r.content.trim()) continue
    if (typeof r.kind !== 'string' || !CURATOR_KINDS.has(r.kind)) continue
    out.push({
      op,
      id,
      kind: r.kind as CuratorKind,
      content: clip(r.content, 300),
      confidence: typeof r.confidence === 'number' ? Math.min(1, Math.max(0, r.confidence)) : 0.9
    })
  }
  return out
}

export function parseProjectOps(text: string, allowedIds: ReadonlySet<number>): CuratorOp[] {
  return normalizeOps(text, 'project', allowedIds, 8)
}

export function parseGlobalOps(text: string, allowedIds: ReadonlySet<number>): CuratorOp[] {
  return normalizeOps(text, 'global', allowedIds, 4)
}

/**
 * 应用整理结果。调用方负责在事务里执行(或由本函数自己开事务)。
 * 用户锁定的行只读:update/retire 都跳过,新增同内容的条目也跳过。
 */
export function applyCuration(
  sqlite: Database.Database,
  args: {
    scope: 'project' | 'global'
    projectId: number | null
    ops: CuratorOp[]
    cap: number
    now?: number
  }
): ApplyResult {
  const now = args.now ?? Date.now()
  const source = args.scope === 'global' ? 'llm-curator:global' : `llm-curator:project:${args.projectId}`
  const owned = sqlite
    .prepare(
      `SELECT id, locked, kind, content, confidence, updated_at
         FROM memories
        WHERE deleted = 0 AND scope = ? AND (project_id IS ?)`
    )
    .all(args.scope, args.scope === 'global' ? null : args.projectId) as Array<{
    id: number
    locked: number
    kind: string
    content: string
    confidence: number
    updated_at: number
  }>
  const byId = new Map(owned.map((r) => [r.id, r]))
  const stmtUpdate = sqlite.prepare(
    `UPDATE memories
        SET kind = ?, content = ?, confidence = ?, status = 'active', locked = 0, source = ?, updated_at = ?
      WHERE id = ? AND deleted = 0`
  )
  const stmtRetire = sqlite.prepare(
    `UPDATE memories SET status = 'retired', updated_at = ? WHERE id = ? AND deleted = 0`
  )
  const stmtFindContent = sqlite.prepare(
    `SELECT id, locked FROM memories
      WHERE deleted = 0 AND status != 'retired' AND scope = ? AND (project_id IS ?) AND content = ? LIMIT 1`
  )
  const stmtDeletedContent = sqlite.prepare(
    `SELECT 1 FROM memories
      WHERE deleted = 1 AND scope = ? AND (project_id IS ?) AND content = ? LIMIT 1`
  )
  const stmtInsert = sqlite.prepare(
    `INSERT INTO memories
       (kind, content, source, confidence, status, updated_at, device_id, project_id, scope, locked, access_count)
     VALUES (?, ?, ?, ?, 'active', ?, 'local', ?, ?, 0, 0)`
  )

  let added = 0
  let updated = 0
  let retired = 0
  let skipped = 0
  const projectId = args.scope === 'global' ? null : args.projectId
  const tx = sqlite.transaction(() => {
    for (const op of args.ops) {
      if (op.op === 'retire') {
        const row = op.id != null ? byId.get(op.id) : undefined
        if (!row || row.locked) {
          skipped++
          continue
        }
        stmtRetire.run(now, row.id)
        retired++
        continue
      }
      if (op.op === 'update') {
        const row = op.id != null ? byId.get(op.id) : undefined
        if (!row || row.locked || !op.kind || !op.content) {
          skipped++
          continue
        }
        stmtUpdate.run(op.kind, op.content, op.confidence ?? 0.9, source, now, row.id)
        updated++
        continue
      }
      // add
      if (!op.kind || !op.content) {
        skipped++
        continue
      }
      // 用户删除过的内容不再由 LLM 复活(墓碑优先)
      if (stmtDeletedContent.get(args.scope, projectId, op.content)) {
        skipped++
        continue
      }
      const dup = stmtFindContent.get(args.scope, projectId, op.content) as
        | { id: number; locked: number }
        | undefined
      if (dup) {
        if (!dup.locked) {
          stmtUpdate.run(op.kind, op.content, op.confidence ?? 0.8, source, now, dup.id)
          updated++
        } else {
          skipped++
        }
        continue
      }
      stmtInsert.run(op.kind, op.content, source, op.confidence ?? 0.8, now, projectId, args.scope)
      added++
    }

    // 条数上限:锁定/画像优先保留,其余按热度从低到高淘汰
    if (args.cap > 0) {
      const rows = sqlite
        .prepare(
          `SELECT id, kind, locked, confidence, updated_at, access_count, last_access_at
             FROM memories
            WHERE deleted = 0 AND status = 'active' AND scope = ? AND (project_id IS ?)`
        )
        .all(args.scope, projectId) as Array<{
        id: number
        kind: string
        locked: number
        confidence: number
        updated_at: number
        access_count: number
        last_access_at: number | null
      }>
      if (rows.length > args.cap) {
        rows.sort((a, b) => {
          if (a.locked !== b.locked) return b.locked - a.locked
          if (a.kind === 'persona' && b.kind !== 'persona') return -1
          if (b.kind === 'persona' && a.kind !== 'persona') return 1
          return heatScore(b, now) - heatScore(a, now)
        })
        for (const row of rows.slice(args.cap)) {
          if (row.locked) break
          stmtRetire.run(now, row.id)
          retired++
        }
      }
    }
  })
  tx()
  return { added, updated, retired, skipped }
}
