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

/** 按会话分类的要点:每个覆盖的会话一条,便于 agent 按会话定位结论来源。 */
export interface DigestSessionNote {
  id: number
  title: string
  note: string
}

/**
 * 解析 perSession 里的会话 id。
 *
 * 提示词里会话渲染成 `### #42`,模型很自然会回 `"#42"`;直接 `Number("#42") || 0`
 * 会把它塌成 0,于是 UI/MCP/vault 全都显示 `#0`,「按会话定位」的意义就没了。
 * 这里逐字符扫出第一段连续数字(`#42` / `会话 42` / `42` 都能取到);取不到返回 0,
 * 由调用方按 note 兜底展示。
 */
function parseSessionId(raw: unknown): number {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 0
  if (typeof raw !== 'string') return 0
  let start = -1
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i)
    const isDigit = code >= 48 && code <= 57
    if (isDigit && start < 0) start = i
    else if (!isDigit && start >= 0) {
      const n = Number(raw.slice(start, i))
      return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
    }
  }
  if (start < 0) return 0
  const n = Number(raw.slice(start))
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
}

export interface DigestResult {
  summary: string
  perSession: DigestSessionNote[]
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

/**
 * 总结详略分档 —— 会话越多、上下文越长,总结越详细(用户 2026-10-26 要求)。
 * 用「会话数 + 上下文量」双因子,而不是只写死一个 1500 字:
 *   - brief:少量会话/小上下文,写精炼总纲
 *   - standard:中等量,展开各小节
 *   - detailed:会话多或上下文大,按会话分类 + 更长总纲
 */
export type DigestLevel = 'brief' | 'standard' | 'detailed'

export interface DigestLevelSpec {
  level: DigestLevel
  /** summary 目标字符数(写进提示词,给模型一个锚) */
  targetChars: number
  /** summary 解析截断上限 */
  capChars: number
  /** 本次 LLM 调用 maxTokens(要容得下 summary + perSession + todos/decisions) */
  maxTokens: number
}

export const DIGEST_LEVEL_SPECS: Record<DigestLevel, DigestLevelSpec> = {
  brief: { level: 'brief', targetChars: 800, capChars: 2000, maxTokens: 2400 },
  standard: { level: 'standard', targetChars: 2000, capChars: 4500, maxTokens: 4200 },
  detailed: { level: 'detailed', targetChars: 4000, capChars: 9000, maxTokens: 8000 }
}

/**
 * 每次输出里 perSession 最多几条。
 *
 * 这个上限是 **maxTokens 预算的一部分**:detailed 档 capChars 9000 字的 summary
 * 加上最多 20 条 perSession(每条 title 80 + note 400)再加 todos/decisions/
 * candidates 与 JSON 结构,很容易把 8000 token 吃穿;一旦被截断,JSON 解析失败,
 * 整份 LLM 答案会被丢弃并回落到规则总结 —— 恰好是最大的项目最受伤。
 * 限到 12 条(≈12×480 字符)后,最坏情况仍留在预算内。
 */
export const DIGEST_MAX_PER_SESSION = 12

/**
 * 按「累计规模 + 上下文量」选档。
 *
 * ⚠ `sessionCount` 必须传**累计**规模(已覆盖 + 本批),不是本批数量。传本批会把
 * 大项目在后续小批次里拉回 brief,把已经写长的总结截短 —— 实测 23 会话项目:
 * 第 1 轮 20 条 → detailed 存 4000 字,第 2 轮 3 条 → brief 截到 800 字(丢 3200),
 * 且截断结果作为 prev 回灌后永远回不去。
 */
export function digestLevel(sessionCount: number, contextChars: number): DigestLevelSpec {
  if (sessionCount >= 12 || contextChars >= 18_000) return DIGEST_LEVEL_SPECS.detailed
  if (sessionCount >= 5 || contextChars >= 9_000) return DIGEST_LEVEL_SPECS.standard
  return DIGEST_LEVEL_SPECS.brief
}

const LEVEL_ORDER: DigestLevel[] = ['brief', 'standard', 'detailed']

/**
 * 选档,并保证**不比上一份总结需要的档位低**(只升不降)。
 *
 * 上一份总结可能比当前算出的档位更长:升级前的旧数据上限是 6000 字,或上一轮
 * 已按更高档位写过。若本次按低档截断,等于把已积累的内容砍掉,所以取两者较高者。
 */
export function digestLevelFor(
  coveredTotal: number,
  contextChars: number,
  prevSummaryChars = 0
): DigestLevelSpec {
  const picked = digestLevel(coveredTotal, contextChars)
  const needed = LEVEL_ORDER.find((k) => DIGEST_LEVEL_SPECS[k].capChars >= prevSummaryChars)
  if (!needed) return DIGEST_LEVEL_SPECS.detailed
  return LEVEL_ORDER.indexOf(needed) > LEVEL_ORDER.indexOf(picked.level)
    ? DIGEST_LEVEL_SPECS[needed]
    : picked
}

/** 系统提示词按档位动态生成:目标字数/是否要求按会话分类都随档位走。 */
export function buildDigestSystemPrompt(spec: DigestLevelSpec): string {
  const perSessionReq =
    spec.level === 'detailed'
      ? '并额外输出 perSession 数组,按会话分类(每个覆盖的会话一条 {id,title,note}),note 用一两句说清"这个会话做了什么/结论是什么",便于按会话定位。'
      : 'perSession 数组也一并输出(每个覆盖的会话一条 {id,title,note},note 一句话)。'
  return (
    `你是项目开发日志的滚动总结器。阅读一个项目的既有总结与新增开发会话,输出**更新版总结**,严格 JSON(不要 markdown 代码块,不要多余文字):\n` +
    `{"summary":"项目的完整交接总结(目标 ${spec.targetChars} 字符左右):写给一个**对该项目一无所知、即将接手继续开发**的 agent,读这一段就能直接开工,不必翻任何历史会话。必须包含:\\n` +
    '1. 项目是什么:目标、给谁用、当前整体状态\\n' +
    '2. 技术要点:语言/框架/关键库、目录与模块划分、数据流向\\n' +
    '3. 已确认的关键决策与原因(避免重蹈覆辙的坑)\\n' +
    '4. 当前进行到哪:最近在做什么、改了哪些文件/模块、已知问题\\n' +
    '5. 环境与命令:怎么跑起来、怎么测试、需要注意的本机路径或凭据位置(只写位置,不写值)\\n' +
    '在上一版基础上滚动更新——过时的信息删掉,新信息并入对应小节,不要只追加一段流水账",\n' +
    `"perSession":[{"id":会话数字id,"title":"会话标题","note":"这一条会话做了什么/结论"}] — ${perSessionReq}\n` +
    '"todos":[{"content":"待办事项,写清做什么/怎么验收","status":"open或done"}],\n' +
    '"decisions":["本窗口确认的技术决策或事实,短句"],\n' +
    '"candidates":[{"kind":"fact或preference或decision","content":"值得长期记住的用户偏好/事实/决策,供用户确认后入记忆库"}]}\n' +
    'todos 是滚动清单:结转上一版仍要做的(标 open,可补充验收标准),已完成/已过时的标 done 或移除,可新增。'
  )
}

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

function tryParse(s: string, spec: DigestLevelSpec): DigestResult | null {
  let o: unknown
  try {
    o = JSON.parse(s)
  } catch {
    return null
  }
  if (typeof o !== 'object' || o === null) return null
  const r = o as Record<string, unknown>
  if (typeof r.summary !== 'string' || !r.summary.trim()) return null
  const perSession: DigestSessionNote[] = Array.isArray(r.perSession)
    ? r.perSession
        .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null && typeof (p as { note?: unknown }).note === 'string')
        .map((p) => ({
          id: parseSessionId((p as { id?: unknown }).id),
          title: clip(typeof (p as { title?: unknown }).title === 'string' ? String((p as { title?: unknown }).title) : '', 80) ?? '',
          note: clip(String(p.note), 400) ?? ''
        }))
        .filter((p) => p.note.length > 0)
        .slice(0, DIGEST_MAX_PER_SESSION)
    : []
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
  return {
    summary: r.summary.trim().slice(0, spec.capChars),
    perSession,
    todos,
    decisions,
    candidates
  }
}

export function parseDigestResponse(text: string, spec: DigestLevelSpec): DigestResult | null {
  const cleaned = text.replace(/```json|```/g, '').trim()
  const direct = tryParse(cleaned, spec)
  if (direct) return direct
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] !== '{') continue
    const end = balancedEnd(cleaned, i)
    if (end < 0) break
    const parsed = tryParse(cleaned.slice(i, end + 1), spec)
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
  const perSession: DigestSessionNote[] = []
  if (sessions.length > 0) {
    lines.push(`本窗口 ${sessions.length} 个会话(${dateOf(sessions[0].ts)} ~ ${dateOf(sessions[sessions.length - 1].ts)}):`)
    for (const s of sessions) {
      const oneLine = s.summary ? ` — ${clip(s.summary.split('\n')[0], 160)}` : ''
      lines.push(`- #${s.id} ${clip(s.title, 80) || '(无标题)'}${oneLine}`)
      // 规则模式的 summary 已经逐条列了会话,perSession 再抄一遍会让 MCP 文本、
      // vault markdown、UI 卡片里每行出现两次。这里只补 summary 里没有的正文提炼
      // (会话摘要首行之外的内容);没有可提炼的正文就留空条目,不重复标题行。
      const extra = s.summary ? clip(s.summary.split('\n').slice(1).join(' ').trim(), 300) : ''
      if (extra) {
        perSession.push({ id: s.id, title: clip(s.title, 80) ?? '', note: extra })
      }
    }
  }
  if (prev) lines.push(`\n上一版总结(结转):\n${prev.summary}`)
  else lines.push(`\n(「${projectName}」首次总结;LLM 引擎未配置,当前为规则模式:仅会话清单,不含正文提炼)`)
  const todos: DigestTodo[] = [
    ...(prev?.todos.filter((t) => t.status === 'open') ?? []),
    ...pendingProgress.map((c) => ({ content: clip(c, 200) ?? '', status: 'open' as const }))
  ].filter((t) => t.content.length > 0)
  return { summary: lines.join('\n').slice(0, 6000), perSession, todos, decisions: [], candidates: [] }
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
  if (result.perSession.length > 0) {
    parts.push('## 按会话', '')
    for (const p of result.perSession) {
      parts.push(`- #${p.id} ${p.title || '(无标题)'} — ${p.note}`)
    }
    parts.push('')
  }
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
