/**
 * project-digest 纯逻辑层 —— prompt 构建 / 容错解析 / 规则降级 / Markdown 渲染。
 * 不碰数据库与 Electron,单测全覆盖;index.ts 只做接线与 SQL。
 */

export interface DigestTodo {
  content: string
  status: 'open' | 'done'
}

export interface DigestCandidate {
  kind: string
  content: string
}

export interface DigestResult {
  summary: string
  todos: DigestTodo[]
  decisions: string[]
  candidates: DigestCandidate[]
}

/** 单轮总结最多覆盖的新会话数;首次/追赶会连续多轮直到清空(见 index.ts 的消化循环)。 */
export const DIGEST_MAX_SESSIONS_PER_RUN = 20
/** 单项目一次触发的最大消化轮数(20×10=200 会话;超出留到下次触发,防失控连环调用)。 */
export const DIGEST_MAX_ROUNDS_PER_TRIGGER = 10
/** prompt 软上限(字符):超限先丢最老会话的正文细节,仍超则截断。 */
export const DIGEST_SOFT_CHAR_CAP = 24_000

export const DIGEST_SYSTEM_PROMPT =
  '你是项目开发日志的滚动总结器。阅读一个项目的既有总结与新增开发会话,输出**更新版总结**,严格 JSON(不要 markdown 代码块,不要多余文字):\n' +
  '{"summary":"项目的完整交接总结(可以长,1500字以内):写给一个**对该项目一无所知、即将接手继续开发**的 agent,读这一段就能直接开工,不必翻任何历史会话。必须包含:\\n' +
  '1. 项目是什么:目标、给谁用、当前整体状态\\n' +
  '2. 技术要点:语言/框架/关键库、目录与模块划分、数据流向\\n' +
  '3. 已确认的关键决策与原因(避免重蹈覆辙的坑)\\n' +
  '4. 当前进行到哪:最近在做什么、改了哪些文件/模块、已知问题\\n' +
  '5. 环境与命令:怎么跑起来、怎么测试、需要注意的本机路径或凭据位置(只写位置,不写值)\\n' +
  '在上一版基础上滚动更新——过时的信息删掉,新信息并入对应小节,不要只追加一段流水账",\n' +
  '"todos":[{"content":"待办事项,写清做什么/怎么验收","status":"open或done"}],\n' +
  '"decisions":["本窗口确认的技术决策或事实,短句"],\n' +
  '"candidates":[{"kind":"fact或preference或decision","content":"值得长期记住的用户偏好/事实/决策,供用户确认后入记忆库"}]}\n' +
  'todos 是滚动清单:结转上一版仍要做的(标 open,可补充验收标准),已完成/已过时的标 done 或移除,可新增。'

export interface DigestSessionInput {
  id: number
  agentType: string
  title: string | null
  summary: string | null
  messageCount: number
  toolCallCount: number
  /** 秒;COALESCE(last_message_at, started_at) */
  ts: number
  firstUser: string | null
  lastAssistant: string | null
}

export interface PrevDigest {
  summary: string
  todos: DigestTodo[]
}

const clip = (s: string | null | undefined, n: number): string => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

const dateOf = (tsSec: number): string =>
  new Date(tsSec * 1000).toISOString().slice(0, 16).replace('T', ' ')

interface SessionMask {
  withLast: boolean
  withFirst: boolean
  withSummary: boolean
}

function renderSession(s: DigestSessionInput, m: SessionMask): string {
  const lines = [`### #${s.id} · ${s.agentType} · ${dateOf(s.ts)} · ${s.messageCount}msg/${s.toolCallCount}tool`]
  lines.push(`标题: ${clip(s.title, 80) || '(无标题)'}`)
  if (m.withSummary && s.summary) lines.push(`既有摘要: ${clip(s.summary, 400)}`)
  if (m.withFirst && s.firstUser) lines.push(`用户: ${clip(s.firstUser, 300)}`)
  if (m.withLast && s.lastAssistant) lines.push(`助手: ${clip(s.lastAssistant, 400)}`)
  return lines.join('\n')
}

function renderPrompt(
  projectName: string,
  sessions: DigestSessionInput[],
  prev: PrevDigest | null,
  m: SessionMask
): string {
  const parts: string[] = [`# 项目: ${projectName}(本次新增 ${sessions.length} 个会话)`]
  if (prev) {
    parts.push('\n## 上一版总结(在此基础上滚动续写,不是重写)')
    parts.push(prev.summary)
    if (prev.todos.length > 0) {
      parts.push('\n## 上一版待办(结转:仍要做的标 open,已完成标 done)')
      for (const t of prev.todos) {
        const mark = t.status === 'done' ? 'x' : ' '
        parts.push(`- [${mark}] ${t.content}`)
      }
    }
  } else {
    parts.push('\n(首次总结,没有上一版)')
  }
  parts.push('\n## 新会话(时间正序)')
  for (const s of sessions) parts.push(renderSession(s, m))
  parts.push(
    '\n## 任务\n按系统提示输出更新版总结 JSON。summary 写给"下一个接手的 agent"看:先读它就能干活,不必逐个翻会话。'
  )
  return parts.join('\n')
}

/**
 * 构建 digest prompt,超软上限时逐级丢弃最占体积的会话正文
 * (末条助手回复 → 首条用户消息 → 既有摘要),保底截断。
 */
export function buildDigestPrompt(
  projectName: string,
  sessions: DigestSessionInput[],
  prev: PrevDigest | null
): string {
  const masks: SessionMask[] = [
    { withLast: true, withFirst: true, withSummary: true },
    { withLast: false, withFirst: true, withSummary: true },
    { withLast: false, withFirst: false, withSummary: true },
    { withLast: false, withFirst: false, withSummary: false }
  ]
  for (const m of masks) {
    const p = renderPrompt(projectName, sessions, prev, m)
    if (p.length <= DIGEST_SOFT_CHAR_CAP) return p
  }
  return renderPrompt(projectName, sessions, prev, masks[masks.length - 1]).slice(0, DIGEST_SOFT_CHAR_CAP)
}

// ---------------------------------------------------------------------------
// 解析:严格 JSON 优先,失败则做「括号配平」抠取 —— LLM 前后带解释文字、
// 或一次输出两段 JSON 时,逐字符扫描(跳过字符串字面量)比正则可靠。
// 这套做法在 tools/upstream-watch 上踩过坑验证过,不要退回贪婪正则。
// ---------------------------------------------------------------------------

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

function tryParse(s: string): DigestResult | null {
  let o: unknown
  try {
    o = JSON.parse(s)
  } catch {
    return null
  }
  if (typeof o !== 'object' || o === null) return null
  const r = o as Record<string, unknown>
  if (typeof r.summary !== 'string' || !r.summary.trim()) return null
  const todos: DigestTodo[] = Array.isArray(r.todos)
    ? r.todos
        .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null && typeof (t as { content?: unknown }).content === 'string')
        .map((t) => ({
          content: clip(String(t.content), 300) ?? '',
          status: t.status === 'done' ? ('done' as const) : ('open' as const)
        }))
        .filter((t) => t.content.length > 0)
    : []
  const decisions: string[] = Array.isArray(r.decisions)
    ? r.decisions.filter((d): d is string => typeof d === 'string' && d.trim().length > 0).map((d) => clip(d, 300) ?? '')
    : []
  const candidates: DigestCandidate[] = Array.isArray(r.candidates)
    ? r.candidates
        .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null && typeof (c as { content?: unknown }).content === 'string')
        .map((c) => ({
          kind: ['fact', 'preference', 'decision'].includes(String(c.kind)) ? String(c.kind) : 'fact',
          content: clip(String(c.content), 500) ?? ''
        }))
        .filter((c) => c.content.length > 0)
    : []
  return { summary: r.summary.trim().slice(0, 6000), todos, decisions, candidates }
}

export function parseDigestResponse(text: string): DigestResult | null {
  const cleaned = text.replace(/```json|```/g, '').trim()
  const direct = tryParse(cleaned)
  if (direct) return direct
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] !== '{') continue
    const end = balancedEnd(cleaned, i)
    if (end < 0) break
    const parsed = tryParse(cleaned.slice(i, end + 1))
    if (parsed) return parsed
    i = end
  }
  return null
}

// ---------------------------------------------------------------------------
// 规则式降级:零外发,给隐私敏感/无 LLM 用户一条纯本地路线
// ---------------------------------------------------------------------------

export function buildRulesDigest(
  projectName: string,
  sessions: DigestSessionInput[],
  prev: PrevDigest | null,
  pendingProgress: string[]
): DigestResult {
  const lines: string[] = []
  if (sessions.length > 0) {
    lines.push(`本窗口 ${sessions.length} 个会话(${dateOf(sessions[0].ts)} ~ ${dateOf(sessions[sessions.length - 1].ts)}):`)
    for (const s of sessions) {
      const oneLine = s.summary ? ` — ${clip(s.summary.split('\n')[0], 160)}` : ''
      lines.push(`- #${s.id} ${clip(s.title, 80) || '(无标题)'}${oneLine}`)
    }
  }
  if (prev) lines.push(`\n上一版总结(结转):\n${prev.summary}`)
  else lines.push(`\n(「${projectName}」首次总结;LLM 引擎未配置,当前为规则模式:仅会话清单,不含正文提炼)`)
  const todos: DigestTodo[] = [
    ...(prev?.todos.filter((t) => t.status === 'open') ?? []),
    ...pendingProgress.map((c) => ({ content: clip(c, 200) ?? '', status: 'open' as const }))
  ].filter((t) => t.content.length > 0)
  return { summary: lines.join('\n').slice(0, 6000), todos, decisions: [], candidates: [] }
}

// ---------------------------------------------------------------------------
// 渲染:vault markdown(人读)与 MCP 文本(agent 读)共用
// ---------------------------------------------------------------------------

export interface DigestMeta {
  projectName: string
  periodStart: number | null
  periodEnd: number | null
  model: string
  sessionsCovered: number
  generatedAt: Date
}

function renderBody(result: DigestResult): string {
  const parts = ['## 摘要', '', result.summary, '']
  if (result.todos.length > 0) {
    parts.push('## 待办', '')
    for (const t of result.todos) {
      const mark = t.status === 'done' ? 'x' : ' '
      parts.push(`- [${mark}] ${t.content}`)
    }
    parts.push('')
  }
  if (result.decisions.length > 0) {
    parts.push('## 决策', '')
    for (const d of result.decisions) parts.push(`- ${d}`)
    parts.push('')
  }
  return parts.join('\n')
}

export function buildDigestMd(result: DigestResult, meta: DigestMeta): string {
  const range =
    meta.periodStart != null && meta.periodEnd != null
      ? `${dateOf(meta.periodStart)} ~ ${dateOf(meta.periodEnd)}`
      : '(未知范围)'
  const head = [
    `# 项目总结: ${meta.projectName}`,
    '',
    `> 生成: ${meta.generatedAt.toISOString().slice(0, 16).replace('T', ' ')} · 模型: ${meta.model} · 覆盖: ${range}(${meta.sessionsCovered} 个会话)`,
    ''
  ]
  return head.join('\n') + renderBody(result) + '\n---\n\n*(MemorySQL project-digest 自动生成,幂等覆盖;数据以库内 project_digests 表为准)*\n'
}

export function buildDigestMcpText(result: DigestResult, meta: DigestMeta): string {
  const range =
    meta.periodStart != null && meta.periodEnd != null
      ? `${dateOf(meta.periodStart)} ~ ${dateOf(meta.periodEnd)}`
      : '(未知范围)'
  return [
    `# 项目滚动总结: ${meta.projectName}`,
    `- 覆盖: ${range}(${meta.sessionsCovered} 个会话) · 模型: ${meta.model}`,
    '',
    renderBody(result)
  ].join('\n')
}

/** 启动补跑判定:有未覆盖会话,且(从未总结过 或 距上次总结超过 24h)。 */
export function shouldRunCatchup(
  state: { last_digest_at: number | null } | undefined,
  uncovered: number,
  now: number
): boolean {
  if (uncovered <= 0) return false
  if (!state || state.last_digest_at == null) return true
  return now - state.last_digest_at > 24 * 3600 * 1000
}
