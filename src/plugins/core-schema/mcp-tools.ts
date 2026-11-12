import type Database from 'better-sqlite3'
import type { McpToolDef } from '../../main/core/plugin-host'
import type { SearchHit } from '../../shared/types'
import type { SearchService } from './search'
import type { MemoriesService } from './index'

const VALID_KINDS = new Set(['fact', 'preference', 'persona', 'decision'])
const SEARCH_KINDS = new Set(['session', 'message', 'memory'])

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

function fmtDate(ts: number | null | undefined): string {
  return ts ? new Date(ts * 1000).toLocaleDateString('zh-CN') : '未知日期'
}

function fmtTime(ts: number | null | undefined): string {
  return ts ? new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false }) : ''
}

/** `since` is expressed in days back from now — unambiguous for agents. */
function sinceCutoffSec(days: number): number {
  return Math.floor(Date.now() / 1000) - days * 86400
}

interface ProjectRow {
  id: number
  name: string
  path: string | null
  tech_stack: string | null
}
interface SessionRow {
  id: number
  title: string | null
  summary: string | null
  started_at: number | null
  last_message_at?: number | null
  agent_type?: string
  message_count?: number
}
interface MemoryRow {
  id: number
  kind: string
  content: string
  updated_at: number
  scope?: 'global' | 'project'
  projectId?: number | null
  locked?: number
  confidence?: number
  accessCount?: number
  lastAccessAt?: number | null
  agent_type?: string | null
}

/**
 * Agent-facing MCP tools (matrix v2). `memory_get_context` is the "connect
 * and continue" entry point; `memory_get_project_brief` is the handoff
 * companion; `memory_log_progress` closes the backflow loop with structured
 * end-of-work reports that land as candidate memories.
 */
export function createMcpTools(deps: {
  sqlite: Database.Database
  search: SearchService
  memories: MemoriesService
  services: { use<T = unknown>(name: string): T }
}): McpToolDef[] {
  const { sqlite, search, memories, services } = deps

  const KIND_ORDER = ['persona', 'preference', 'fact', 'decision'] as const
  const KIND_LABEL: Record<string, string> = {
    persona: '画像',
    preference: '偏好',
    fact: '事实',
    decision: '决策'
  }
  const KIND_QUOTA: Record<string, number> = { persona: 6, preference: 8, fact: 10, decision: 8 }

  const heatOf = (row: MemoryRow, now: number): number => {
    const last = row.lastAccessAt ?? row.updated_at
    const days = Math.max(0, (now - last) / 86_400_000)
    const confidence = typeof row.confidence === 'number' && row.confidence > 0 ? row.confidence : 1
    return Math.exp(-0.5 * days) * (1 + Math.log1p(Math.max(0, row.accessCount ?? 0))) * confidence
  }

  /** 读某一层(global/project)的活跃记忆;agent 过滤保留全局 NULL 行。 */
  const loadMemories = (
    scope: 'global' | 'project',
    projectIds: number[] | null,
    agent?: string
  ): MemoryRow[] => {
    const where = ['deleted = 0', `status = 'active'`, 'scope = ?']
    const params: unknown[] = [scope]
    if (scope === 'project') {
      const ids = projectIds ?? []
      if (ids.length === 0) return []
      where.push(`project_id IN (${ids.map(() => '?').join(',')})`)
      params.push(...ids)
    }
    if (agent) {
      // persona 是用户画像,不随 agent 过滤丢失;其余记忆保留全局 NULL + 当前 agent
      where.push("(kind = 'persona' OR agent_type IS NULL OR agent_type = ?)")
      params.push(agent)
    }
    return sqlite
      .prepare(
        `SELECT id, kind, content, scope, project_id AS projectId, locked, confidence,
                updated_at, access_count AS accessCount, last_access_at AS lastAccessAt,
                agent_type
           FROM memories
          WHERE ${where.join(' AND ')}
          ORDER BY kind, updated_at DESC
          LIMIT 240`
      )
      .all(...params) as MemoryRow[]
  }

  /** 把记忆按 kind 分组、按「锁定 > 热度 > 最近」排序,再按配额/字符预算裁剪。 */
  const renderMemoryBlock = (
    heading: string,
    rows: MemoryRow[],
    budget: number
  ): { text: string; ids: number[] } => {
    const now = Date.now()
    const byKind = new Map<string, MemoryRow[]>()
    for (const row of rows) {
      const list = byKind.get(row.kind) ?? []
      list.push(row)
      byKind.set(row.kind, list)
    }
    const lines: string[] = [`\n${heading}`]
    const ids: number[] = []
    const seen = new Set<string>()
    let used = 0
    outer: for (const kind of KIND_ORDER) {
      const list = (byKind.get(kind) ?? [])
        .filter((r) => {
          const key = `${r.kind}|${r.content}`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
        .sort((a, b) => {
          if ((a.locked ?? 0) !== (b.locked ?? 0)) return (b.locked ?? 0) - (a.locked ?? 0)
          const heat = heatOf(b, now) - heatOf(a, now)
          return heat !== 0 ? heat : b.updated_at - a.updated_at
        })
        .slice(0, KIND_QUOTA[kind] ?? 8)
      if (list.length === 0) continue
      lines.push(`### ${KIND_LABEL[kind] ?? kind}`)
      for (const row of list) {
        const line = `- ${clip(row.content, 220)}`
        if (used + line.length > budget) break outer
        lines.push(line)
        used += line.length
        ids.push(row.id)
      }
    }
    if (ids.length === 0) {
      lines.push('(暂无 — 可调用 memory_write 写入)')
    }
    return { text: lines.join('\n'), ids }
  }

  /** 注入即使用:累加访问次数/最近访问时间,作为下次排序与淘汰的热度依据。 */
  const touchMemories = (ids: number[]): void => {
    if (ids.length === 0) return
    const unique = [...new Set(ids)]
    try {
      sqlite
        .prepare(
          `UPDATE memories
              SET access_count = access_count + 1, last_access_at = ?
            WHERE id IN (${unique.map(() => '?').join(',')}) AND deleted = 0`
        )
        .run(Date.now(), ...unique)
    } catch {
      /* 热度是排序增强,写失败不能影响上下文返回 */
    }
  }

  const findProjectByKeyword = (keyword: string): ProjectRow | null =>
    (
      sqlite
        .prepare(
          `SELECT id, name, path, tech_stack FROM projects
           WHERE deleted = 0 AND (name LIKE ? OR path LIKE ?)
           ORDER BY updated_at DESC LIMIT 1`
        )
        .get(`%${keyword}%`, `%${keyword}%`) as ProjectRow | undefined
    ) ?? null

  /**
   * 关键词命中的**全部**项目(按最近活跃排序)。
   *
   * 真实数据里同名项目很常见:换机后路径变了(F:\桌面\MemorySQL 与
   * H:\桌面\MemorySQL)、同盘的斜杠/反斜杠两种写法、甚至 src 子目录被
   * 当成独立项目 —— 本机「MemorySQL」一个词就命中 5 个 id。只取 LIMIT 1
   * 会让 memory_list_sessions 静默丢掉绝大部分会话(实测只回 1 条,
   * 而项目实际有 20+ 条),用户以为数据没了。
   *
   * ⚠ 合并的判据是**项目名**,不是路径子串:
   *   - 名字匹配(name LIKE)优先,命中即用这批
   *   - 名字没命中才退回路径匹配(允许用「数据库课程设计」这类路径片段找项目)
   * 只用 `name OR path LIKE` 会把**同目录下的无关项目**全并进来:实测关键词
   * 「桌面」命中 24 个项目(它们只是都放在 H:\桌面\ 下),于是标题写着 A、
   * 总结正文却是 B 的结论。路径只在名字没命中时作兜底,且此时通常只命中一个。
   */
  const findProjectsByKeyword = (keyword: string): ProjectRow[] => {
    const like = `%${keyword}%`
    const byName = sqlite
      .prepare(
        `SELECT id, name, path, tech_stack FROM projects
         WHERE deleted = 0 AND name LIKE ?
         ORDER BY updated_at DESC`
      )
      .all(like) as ProjectRow[]
    if (byName.length > 0) return byName
    return sqlite
      .prepare(
        `SELECT id, name, path, tech_stack FROM projects
         WHERE deleted = 0 AND path LIKE ?
         ORDER BY updated_at DESC`
      )
      .all(like) as ProjectRow[]
  }

  const findProject = (keyword?: string): ProjectRow | null => {
    if (keyword) {
      const row = findProjectByKeyword(keyword)
      if (row) return row
    }
    return (
      (sqlite
        .prepare(
          `SELECT p.id, p.name, p.path, p.tech_stack FROM projects p
           JOIN sessions s ON s.project_id = p.id
           WHERE p.deleted = 0
           GROUP BY p.id ORDER BY MAX(COALESCE(s.last_message_at, s.started_at, s.updated_at)) DESC LIMIT 1`
        )
        .get() as ProjectRow | undefined) ?? null
    )
  }

  /**
   * 最近会话,支持**多个** project id(同名项目合并后一起取)。
   *
   * 之前 buildContext 里标题按单个 project 取、摘要按合并集合取,同一个返回里
   * 出现两个口径 —— 实测 memory_get_context({project:'桌面'}) 的标题是
   * 「嵌入式-智能飞镖感应设备-省赛」,紧跟着的总结正文却是「冰冰快答小助手」。
   */
  const recentSessionsOf = (projectIds: number[] | null, limit = 5): SessionRow[] => {
    // most recently *conversing* first — a session that started long ago but
    // talked yesterday belongs above one that started and finished this morning.
    // 子代理会话排除在外:它们说得再多也不是「用户做过什么」。
    const order = 'COALESCE(last_message_at, started_at, updated_at) DESC'
    if (projectIds === null) {
      return sqlite
        .prepare(
          `SELECT id, title, summary, started_at, last_message_at, agent_type FROM sessions
           WHERE deleted = 0 AND is_subagent = 0 ORDER BY ${order} LIMIT ?`
        )
        .all(limit) as SessionRow[]
    }
    if (projectIds.length === 0) return []
    return sqlite
      .prepare(
        `SELECT id, title, summary, started_at, last_message_at, agent_type FROM sessions
         WHERE deleted = 0 AND is_subagent = 0
           AND project_id IN (${projectIds.map(() => '?').join(',')})
         ORDER BY ${order} LIMIT ?`
      )
      .all(...projectIds, limit) as SessionRow[]
  }

  /** tail of one session, newest last — the "what the previous agent did" block */
  const renderTail = (sessionId: number, maxMessages = 6, clipLen = 500): string => {
    const rows = (
      sqlite
        .prepare(
          `SELECT role, content, ts, tool_name FROM session_messages
           WHERE session_id = ? ORDER BY seq DESC LIMIT ?`
        )
        .all(sessionId, maxMessages) as Array<{ role: string; content: string; ts: number | null; tool_name: string | null }>
    ).reverse()
    return rows
      .map((m) => {
        const label = m.role === 'tool' ? `TOOL(${m.tool_name ?? 'tool'})` : m.role.toUpperCase()
        const when = fmtTime(m.ts)
        return `- ${label}${when ? ` ${when}` : ''}: ${clip(m.content, clipLen)}`
      })
      .join('\n')
  }

  const sessionLine = (s: SessionRow): string => {
    const firstLine = s.summary ? clip(s.summary.split('\n')[0] ?? '', 120) : ''
    // the last conversation time tells the agent whether this session is
    // still "hot" — a session started last week but finished today is not
    // the same thing as one that has been quiet for a month
    const last =
      typeof s.last_message_at === 'number' && s.last_message_at !== s.started_at
        ? ` [最后 ${fmtDate(s.last_message_at)}]`
        : ''
    return `#${s.id} [${s.agent_type ?? '?'}] [${fmtDate(s.started_at)}]${last} ${s.title ?? '(无标题)'}${
      typeof s.message_count === 'number' ? ` (${s.message_count} 条消息)` : ''
    }${firstLine ? ` — ${firstLine}` : ''}`
  }

  /**
   * 项目滚动总结(project-digest 插件的表;跨插件直读,带存在性守卫 ——
   * 插件停用/表未建时静默跳过,退回纯规则汇编)。
   * 有总结时它是简报/续接包的第一公民:agent 先读这段,不必逐个翻会话。
   */
  const latestProjectDigest = (
    projectIds: number | number[] | null
  ): {
    summary: string
    recent: string
    perSession: Array<{ id: number; title: string; note: string }>
    todos: Array<{ content: string; status?: string }>
    model: string
    covered: number
    createdAt: number | null
  } | null => {
    const ids = projectIds == null ? [] : Array.isArray(projectIds) ? projectIds : [projectIds]
    if (ids.length === 0) return null
    try {
      // 同名项目可能有多份总结 —— 取整体最新的一份(与"最近一次总结"语义一致)
      // per_session 是 v2 迁移加的列;recent 是 v3 加的列:老库缺列时逐级退。
      let row:
        | {
            summary: string
            recent: string
            per_session: string
            todos: string
            model: string
            sessions_covered: number
            created_at: number
          }
        | undefined
      try {
        row = sqlite
          .prepare(
            `SELECT summary, recent, per_session, todos, model, sessions_covered, created_at FROM project_digests
             WHERE project_id IN (${ids.map(() => '?').join(',')}) AND deleted = 0
             ORDER BY created_at DESC LIMIT 1`
          )
          .get(...ids) as typeof row
      } catch {
        // 老 schema(无 recent/per_session 列):退到只读 summary/todos
        const legacy = sqlite
          .prepare(
            `SELECT summary, todos, model, sessions_covered, created_at FROM project_digests
             WHERE project_id IN (${ids.map(() => '?').join(',')}) AND deleted = 0
             ORDER BY created_at DESC LIMIT 1`
          )
          .get(...ids) as
          | { summary: string; todos: string; model: string; sessions_covered: number; created_at: number }
          | undefined
        row = legacy ? { ...legacy, recent: '', per_session: '[]' } : undefined
      }
      if (!row) return null
      return {
        summary: row.summary,
        recent: row.recent ?? '',
        perSession: JSON.parse(row.per_session || '[]') as Array<{ id: number; title: string; note: string }>,
        todos: JSON.parse(row.todos || '[]') as Array<{ content: string; status?: string }>,
        model: row.model,
        covered: row.sessions_covered,
        createdAt: row.created_at ?? null
      }
    } catch {
      return null
    }
  }

  const renderDigestBlock = (
    d: NonNullable<ReturnType<typeof latestProjectDigest>>,
    heading: string
  ): string => {
    // 脏行防护:todos/perSession 来自库里的 JSON,可能是手工编辑/异版本写坏的
    // 形状(实测 todos='{}' → TypeError 直接让 memory_get_context 变成 Tool error)。
    // 这里是 agent 第一个调用的工具,必须降级而不是抛错。
    const todos = Array.isArray(d.todos) ? d.todos : []
    const open = todos.filter((t) => t && t.status !== 'done')
    const lines = [`\n${heading}`, d.summary]
    const staleDays =
      typeof d.createdAt === 'number' && d.createdAt > 0
        ? Math.floor((Date.now() - d.createdAt) / 86_400_000)
        : 0
    if (staleDays > 14) {
      lines.push(`(总结最后更新于 ${staleDays} 天前,最近进展可能已过时)`)
    }
    const recent = typeof d.recent === 'string' ? d.recent.trim() : ''
    if (recent) {
      lines.push('\n最近进展:', recent)
    } else {
      // 老 digest 没有 recent 列:用 perSession 的短注兜底,升级后不会突然丢信息
      const perSession = Array.isArray(d.perSession) ? d.perSession : []
      const fallback = perSession.slice(0, 8).filter((p) => p && p.note)
      if (fallback.length > 0) {
        lines.push('\n按会话:')
        for (const p of fallback) {
          lines.push(`  - #${p.id ?? 0} ${p.title || '(无标题)'} — ${clip(String(p.note), 120)}`)
        }
      }
    }
    if (open.length > 0) {
      const items = open.map((t) => (typeof t?.content === 'string' ? t.content : '')).filter(Boolean)
      if (items.length > 0) lines.push(`待办: ${items.join(' / ')}`)
    }
    return lines.join('\n')
  }

  const buildContext = (args: Record<string, unknown>): string => {
    const keyword = typeof args.project === 'string' ? args.project : undefined
    const agent = typeof args.agent === 'string' && args.agent.trim() ? args.agent.trim() : undefined
    const includeLast = args.include_last_session === true
    // 同名项目(换机/斜杠写法/src 子目录)合并成一个集合,标题、总结、会话列表
    // **必须用同一份集合**,否则同一段返回里会出现三个不同口径的项目
    // (实测:标题是「嵌入式…省赛」,总结正文却是「冰冰快答小助手」)。
    const matched = keyword ? findProjectsByKeyword(keyword) : []
    const active = findProject(undefined)
    const project = matched[0] ?? active
    // 即使调用方没传 project,也落到最近活跃项目:这样「全局 + 项目记忆 + 总结」
    // 每次都有;过去 projectIds=null 会既不带项目记忆也不带 digest。
    const projectIds = matched.length > 0 ? matched.map((p) => p.id) : active ? [active.id] : null
    const globalRows = loadMemories('global', null, agent)
    const projectRows = projectIds ? loadMemories('project', projectIds, agent) : []
    const globalBlock = renderMemoryBlock('## 全局记忆', globalRows, 2200)
    const projectBlock = projectIds
      ? renderMemoryBlock(`## 项目记忆: ${project?.name ?? '(未指定)'}`, projectRows, 2600)
      : null
    touchMemories([...globalBlock.ids, ...(projectBlock?.ids ?? [])])
    const sessions = recentSessionsOf(projectIds, 5)

    const parts: string[] = ['# MemorySQL 续接上下文\n']
    if (agent) parts.push(`> 记忆按 agent 过滤: ${agent}(含全局记忆)\n`)

    parts.push(globalBlock.text)
    if (project) {
      parts.push(`\n## 项目: ${project.name}`)
      if (project.path) parts.push(`- 路径: ${project.path}`)
      if (project.tech_stack) parts.push(`- 技术栈: ${project.tech_stack}`)
    }
    if (projectBlock) parts.push(projectBlock.text)

    // 滚动总结放在会话列表之前:agent 读这一段就能接手,不必再逐个翻会话
    const digest = latestProjectDigest(projectIds)
    if (digest) {
      parts.push(
        renderDigestBlock(
          digest,
          `## 项目总结(${digest.model} · 覆盖 ${digest.covered} 个会话 · 定期生成)`
        )
      )
    }
    if (sessions.length > 0) {
      parts.push('- 最近会话:')
      for (const s of sessions) parts.push(`  - ${sessionLine(s)}`)
    } else {
      parts.push('- (该项目暂无会话记录)')
    }

    if (includeLast && sessions.length > 0) {
      parts.push(`\n## 上一棒交接摘要(最近会话 #${sessions[0].id} tail)`)
      parts.push(renderTail(sessions[0].id))
    }

    parts.push(
      '\n> 深读某条会话用 memory_get_session({id});需要更多历史用 memory_list_sessions 或 memory_search({query});拿到新结论/偏好用 memory_write({kind, content, project?}) 记录;收工时用 memory_log_progress 汇报进度。'
    )
    return parts.join('\n')
  }

  const buildBrief = (args: Record<string, unknown>): string => {
    const keyword = typeof args.project === 'string' ? args.project : undefined
    const agent = typeof args.agent === 'string' && args.agent.trim() ? args.agent.trim() : undefined
    const project = findProject(keyword)
    // 与 buildContext 同口径:同名项目合并成一份集合,标题/总结/会话列表共用它
    const matched = keyword ? findProjectsByKeyword(keyword) : []
    const projectIds = matched.length > 0 ? matched.map((p) => p.id) : project ? [project.id] : null
    const sessions = recentSessionsOf(projectIds, 8)

    const parts: string[] = [
      `# 项目交接简报: ${project?.name ?? '(未指定项目)'}`,
      ''
    ]
    if (project?.path) parts.push(`- 路径: ${project.path}`)
    if (project?.tech_stack) parts.push(`- 技术栈: ${project.tech_stack}`)
    if (agent) parts.push(`- 面向 agent: ${agent}(记忆含全局)`)

    const globalRows = loadMemories('global', null, agent)
    const projectRows = projectIds ? loadMemories('project', projectIds, agent) : []
    const globalBlock = renderMemoryBlock('## 全局记忆', globalRows, 2200)
    const projectBlock = projectIds
      ? renderMemoryBlock(`## 项目记忆: ${project?.name ?? '(未指定)'}`, projectRows, 2600)
      : null
    touchMemories([...globalBlock.ids, ...(projectBlock?.ids ?? [])])
    parts.push(globalBlock.text)
    if (projectBlock) parts.push(projectBlock.text)

    const digest = latestProjectDigest(projectIds)
    if (digest) parts.push(renderDigestBlock(digest, '## 项目总结(定期生成 —— 先读这段,不必逐个翻会话)'))

    parts.push('\n## 最近会话(接棒上下文)')
    if (sessions.length > 0) {
      for (const s of sessions) parts.push(`- ${sessionLine(s)}`)
    } else {
      parts.push('(该项目暂无会话记录)')
    }

    if (sessions.length > 0) {
      parts.push(`\n## 上一棒进行到哪(最近会话 #${sessions[0].id} tail)`)
      parts.push(renderTail(sessions[0].id))
    }

    const progressWhere = [
      `status = 'candidate'`,
      `deleted = 0`,
      `source LIKE 'agent:mcp:log_progress%'`,
      ...(agent ? ['(agent_type IS NULL OR agent_type = ?)'] : []),
      // 只看本项目已关联的汇报;未匹配项目(scope=global)的不属于任何项目简报,
      // 否则 A 项目的简报会带出 B 项目/无主项目的进度
      ...(projectIds && projectIds.length > 0
        ? [`project_id IN (${projectIds.map(() => '?').join(',')})`]
        : ['1=0'])
    ]
    const progressParams: unknown[] = []
    if (agent) progressParams.push(agent)
    if (projectIds && projectIds.length > 0) progressParams.push(...projectIds)
    const progress = sqlite
      .prepare(
        `SELECT id, content FROM memories WHERE ${progressWhere.join(' AND ')} ORDER BY updated_at DESC LIMIT 5`
      )
      .all(...progressParams) as Array<{ id: number; content: string }>
    parts.push('\n## 待确认进度(收工汇报候选)')
    if (progress.length > 0) {
      for (const p of progress) parts.push(`- #${p.id} ${clip(p.content, 200)}`)
    } else {
      parts.push('(暂无 — agent 收工时用 memory_log_progress 汇报)')
    }

    parts.push(
      '\n> 本简报由本地规则从会话与记忆汇编。深读历史: memory_get_session({id});收工汇报: memory_log_progress({project, done, next?, issues?})。'
    )
    return parts.join('\n')
  }

  return [
    {
      name: 'memory_get_context',
      description:
        '【何时调用】开始一个任务、进入不熟悉的项目、或用户说"续接/接着上次/继续做"时,先调一次(每个会话最多一次)。\n' +
        '返回"续接包":全局记忆(画像/偏好/事实/决策)+ 项目记忆 + 项目总结(总览 + 最近进展)+ 最近会话(带 id,可直接深读),可选按 agent 过滤记忆、内联上一棒交接摘要。',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: '项目名或路径关键词,缺省取最近活跃项目' },
          agent: { type: 'string', description: '按 agent 过滤长期记忆(全局记忆始终包含),如 codex / hermes' },
          include_last_session: {
            type: 'boolean',
            description: 'true 时内联最近一次会话的 tail,作为"上一棒交接摘要"'
          }
        }
      },
      handler: (args) => buildContext(args)
    },
    {
      name: 'memory_get_project_brief',
      description:
        '【何时调用】要接手别人做了一半的项目、或用户问"这个项目进展到哪了"时用;比逐个翻会话便宜得多。\n' +
        '返回项目交接简报:全局记忆 + 项目记忆 + 项目总结(总览/最近进展/待办)+ 最近会话 + 上一棒 tail + 待确认进度,从知识库自动汇编。',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: '项目名或路径关键词,缺省取最近活跃项目' },
          agent: { type: 'string', description: '按 agent 过滤记忆(全局记忆始终包含)' }
        }
      },
      handler: (args) => buildBrief(args)
    },
    {
      name: 'memory_list_sessions',
      description:
        '【何时调用】需要按项目/agent/时间**列清单**时(例如"这个项目都有哪些会话""上周跑过什么"),或要拿会话 id 去 memory_get_session 深读时。按内容找东西用 memory_search。',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: '项目名或路径关键词(精确匹配项目,不回退最近活跃)' },
          agent: { type: 'string', description: '按 agent 过滤,如 codex / hermes / zcode' },
          since: { type: 'number', description: '只看最近 N 天,如 7' },
          limit: { type: 'number', description: '返回条数,默认 20,上限 100' },
          offset: { type: 'number', description: '分页偏移,默认 0' },
          includeSubagents: {
            type: 'boolean',
            description: '是否包含子代理/子任务会话(默认 false —— 它们由父会话派生,会把列表挤满)'
          }
        }
      },
      handler: (args) => {
        const keyword = typeof args.project === 'string' ? args.project : undefined
        const agent = typeof args.agent === 'string' && args.agent.trim() ? args.agent.trim() : undefined
        const sinceDays = Number(args.since)
        const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100)
        const offset = Math.max(Number(args.offset) || 0, 0)
        const includeSubagents = args.includeSubagents === true

        // 同名项目全部纳入(换机/斜杠写法/src 子目录都会产生同名的独立项目);
        // 只取第一个会静默丢会话,见 findProjectsByKeyword 的注释
        const matched = keyword ? findProjectsByKeyword(keyword) : []
        if (keyword && matched.length === 0) {
          return `未找到与"${keyword}"匹配的项目。可用 memory_search 按内容找会话。`
        }
        const where = ['deleted = 0']
        const params: unknown[] = []
        // 子代理会话默认不进列表:它们是父会话派生的内部过程,数量和长度都
        // 会压过真正的项目会话(真机 100 条 zcode 里 37 条是子代理)
        if (!includeSubagents) where.push('is_subagent = 0')
        if (matched.length > 0) {
          where.push(`project_id IN (${matched.map(() => '?').join(',')})`)
          params.push(...matched.map((p) => p.id))
        }
        if (agent) {
          where.push('agent_type = ?')
          params.push(agent)
        }
        if (sinceDays > 0) {
          // "last N days" means last *conversation*, not last start: a session
          // opened three weeks ago but still talking yesterday is recent
          where.push('COALESCE(last_message_at, started_at, updated_at) >= ?')
          params.push(sinceCutoffSec(sinceDays))
        }
        const rows = sqlite
          .prepare(
            `SELECT id, title, summary, started_at, last_message_at, agent_type, message_count FROM sessions
             WHERE ${where.join(' AND ')}
             ORDER BY COALESCE(last_message_at, started_at, updated_at) DESC LIMIT ? OFFSET ?`
          )
          .all(...params, limit, offset) as SessionRow[]
        if (rows.length === 0) return '没有符合条件的会话。'
        const body = rows.map((s, i) => `${i + 1}. ${sessionLine(s)}`).join('\n')
        // 命中多个同名项目时明说一句,否则 agent 会以为"就这些"
        if (matched.length > 1) {
          const names = matched.map((p) => `#${p.id} ${p.path ?? p.name}`).join('、')
          return `${body}\n\n> 关键词「${keyword}」命中 ${matched.length} 个同名/同路径项目,已合并结果:${names}`
        }
        return body
      }
    },
    {
      name: 'memory_get_session',
      description:
        '【何时调用】已有会话 id、需要逐条看原始对话时(排查"当时到底怎么说的"、复核某个决定)。只要结论不要细节时,优先 memory_get_project_digest。\n' +
        '返回消息时间线(角色/内容/时间/工具名);默认取最后若干条并按 4 万字符预算截断,要更早内容用 tail,单条长消息用 full=true。',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number', description: '会话数字 id' },
          tail: { type: 'number', description: '只取最后 N 条消息(省略则全量)' },
          full: { type: 'boolean', description: 'true 时单条消息最多 20000 字符(默认 2000)' }
        },
        required: ['id']
      },
      handler: (args) => {
        const id = Number(args.id)
        if (!id || Number.isNaN(id)) return '参数错误:需要数字 id'
        const session = sqlite
          .prepare(
            'SELECT title, agent_type, started_at, last_message_at, summary FROM sessions WHERE id = ? AND deleted = 0'
          )
          .get(id) as
          | {
              title: string | null
              agent_type: string
              started_at: number | null
              last_message_at: number | null
              summary: string | null
            }
          | undefined
        if (!session) return `未找到会话 #${id}`
        const tail = Number(args.tail)
        const totalMsgs = (
          sqlite.prepare('SELECT count(*) AS n FROM session_messages WHERE session_id = ?').get(id) as {
            n: number
          }
        ).n
        // tail is pushed into SQL: a 7.3k-message session used to be read in full
        // (3.6 MB) and then sliced — 10.99 ms vs 0.19 ms with LIMIT.
        let messages = (
          tail > 0
            ? sqlite
                .prepare(
                  'SELECT role, content, ts, tool_name FROM session_messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?'
                )
                .all(id, tail)
                .reverse()
            : sqlite
                .prepare(
                  'SELECT role, content, ts, tool_name FROM session_messages WHERE session_id = ? ORDER BY seq'
                )
                .all(id)
        ) as Array<{ role: string; content: string; ts: number | null; tool_name: string | null }>
        const omitted = tail > 0 && totalMsgs > messages.length ? totalMsgs - messages.length : 0
        const perMessage = args.full === true ? 20000 : 2000
        /**
         * 总输出预算。过去是 120_000 —— 实测一次 memory_get_session 真能吐
         * 出 12 万字符(≈3-4 万 token),agent 一个"回读历史"就把自己的上下文
         * 撑爆,而这正是本项目要解决的问题。默认收到 40_000 字符(约 1 万
         * token):足够看清一次会话的骨架,再深读靠 tail 收窄或多次分页。
         * full=true 时放宽到 80_000(用户明确要求单条长消息时不至于只剩头)。
         */
        const TOTAL_CAP = args.full === true ? 80_000 : 40_000
        let capped = false
        const clipMsg = (s: string, n: number): string =>
          s.length > n ? `${s.slice(0, n)}…[截断]` : s
        const when = (ts: number | null): string => (ts ? fmtTime(ts) : '')
        // budget check stays O(n): track running length instead of re-joining
        // every message on every iteration
        const SEP = '\n\n---\n\n'
        /**
         * 从**最新**往回填预算,再翻转回时间顺序。
         *
         * 之前是正向遍历 + 超预算 break,保留的是最旧的 N 条 —— 而这里的存在意义
         * 正是「一次会话太长,看最近的」。实测真实会话 #260(7303 条)默认输出
         * 39,203 字符里含 seq 0…120、**不含最新一条**,与「最后若干条」的文案
         * 完全相反,还把 agent 指向一个不生效的 tail 补救。
         */
        let budget = TOTAL_CAP
        const kept: string[] = []
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          const m = messages[i]
          const label = m.role === 'tool' ? `TOOL(${m.tool_name ?? 'tool'})` : m.role.toUpperCase()
          const line = `**${label}** ${when(m.ts)}\n${clipMsg(m.content, perMessage)}`
          const extra = line.length + (kept.length > 0 ? SEP.length : 0)
          if (extra > budget) {
            capped = true
            break
          }
          kept.push(line)
          budget -= extra
        }
        kept.reverse()
        const lines = kept
        const droppedByCap = messages.length - kept.length
        const body = lines.join(SEP)
        const head = `# ${session.title ?? `会话 #${id}`}\n- id: ${id}\n- agent: ${session.agent_type}\n- 开始: ${when(session.started_at)}\n- 最后: ${when(session.last_message_at)}\n- 消息数: ${totalMsgs}${omitted > 0 ? `(本次取最后 ${messages.length} 条,已省略前 ${omitted} 条 — 用 tail 调整)` : ''}\n`
        const capNote = capped
          ? `\n\n> [输出已达 ${TOTAL_CAP} 字符上限,保留了**最近** ${lines.length}/${messages.length} 条(最早 ${droppedByCap} 条未显示)。要看更早的内容:tail=N 取最近 N 条,或先读本会话的 summary/项目总结再决定是否深读]`
          : ''
        return `${head}\n${session.summary ? `> 摘要: ${clip(session.summary, 200)}\n\n` : ''}${body}${capNote}`
      }
    },
    {
      name: 'memory_search',
      description:
        '【何时调用】用户问"上次怎么做的""为什么这样定""之前踩过什么坑",或你需要引用历史决策/偏好时 —— **先搜再答,不要凭印象**。\n' +
        '全文检索会话/消息/记忆(trigram,支持中文),可按 kind/agent/项目/时间收窄;语义检索启用时,字面未命中的概念查询会以「·语义」补足召回。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索词' },
          limit: { type: 'number', description: '返回条数,默认 20,上限 100' },
          kind: { type: 'string', enum: ['session', 'message', 'memory'], description: '只搜某类资产' },
          agent: { type: 'string', description: '按 agent 过滤(记忆含全局)' },
          project: { type: 'string', description: '项目名或路径关键词(会话/消息/项目记忆;全局记忆始终保留)' },
          since: { type: 'number', description: '只看最近 N 天,如 7' }
        },
        required: ['query']
      },
      handler: async (args) => {
        const q = String(args.query ?? '')
        const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100)
        const kind = typeof args.kind === 'string' ? args.kind : undefined
        if (kind && !SEARCH_KINDS.has(kind)) {
          return `参数错误:kind 必须是 session/message/memory`
        }
        const agent = typeof args.agent === 'string' && args.agent.trim() ? args.agent.trim() : undefined
        const keyword = typeof args.project === 'string' && args.project.trim() ? args.project.trim() : undefined
        let projectId: number | undefined
        let projectIds: number[] | undefined
        if (keyword) {
          // 与 memory_list_sessions / memory_get_context 同一合并口径:
          // 只取第一个会让同名项目(换机/斜杠/src 子目录)下的会话搜不到
          const matched = findProjectsByKeyword(keyword)
          if (matched.length === 0) {
            return `未找到与"${keyword}"匹配的项目 — 项目过滤后无结果。可去掉 project 参数全库搜索。`
          }
          projectIds = matched.map((p) => p.id)
          if (matched.length === 1) projectId = matched[0].id
        }
        const sinceDays = Number(args.since)
        const sinceSec = sinceDays > 0 ? sinceCutoffSec(sinceDays) : undefined
        const hits = search.searchAll(q, limit, {
          kinds: kind ? [kind as SearchHit['kind']] : undefined,
          agent,
          projectId,
          projectIds,
          sinceSec
        })
        const memoryHitIds = hits.filter((h) => h.kind === 'memory').map((h) => h.id)
        const lines = hits.map((h, i) => {
          const tag =
            h.kind === 'memory' ? `${h.kind}·${h.scope === 'project' ? '项目' : '全局'}` : h.kind
          return `${i + 1}. [${tag}${h.sessionId != null ? ` 会话#${h.sessionId}` : ''}/${h.agentType ?? '?'}] ${h.title ?? ''}\n   ${h.snippet.replace(/\n/g, ' ')}`
        })
        // semantic backfill (semantic-search plugin; silently absent when disabled)
        if (q.trim() && (!kind || kind === 'memory' || kind === 'session')) {
          try {
            const sem = services.use<{
              search(query: string, limit?: number): Promise<Array<{ kind: 'memory' | 'session'; refId: number; score: number }>>
            }>('semantic-search')
            const semHits = await sem.search(q, limit)
            const seen = new Set(hits.map((h) => `${h.kind}:${h.id}`))
            const extra: string[] = []
            for (const s of semHits) {
              if (kind && s.kind !== kind) continue
              const key = `${s.kind}:${s.refId}`
              if (seen.has(key)) continue
              seen.add(key)
              if (s.kind === 'memory') {
                const row = sqlite
                  .prepare(
                    `SELECT id, kind, content, agent_type, updated_at, scope, project_id
                       FROM memories WHERE id = ? AND deleted = 0 AND status != 'retired'`
                  )
                  .get(s.refId) as
                  | {
                      id: number
                      kind: string
                      content: string
                      agent_type: string | null
                      updated_at: number
                      scope: string
                      project_id: number | null
                    }
                  | undefined
                if (!row) continue
                if (agent && !(row.agent_type == null || row.agent_type === agent)) continue
                if (sinceSec != null && row.updated_at < sinceSec * 1000) continue
                if (row.scope === 'project') {
                  const ids = projectIds ?? (projectId != null ? [projectId] : null)
                  if (ids != null && !ids.includes(row.project_id ?? -1)) continue
                }
                if (!memoryHitIds.includes(row.id)) memoryHitIds.push(row.id)
                extra.push(
                  `[memory·语义/${row.scope === 'project' ? '项目' : '全局'}/${row.agent_type ?? '全局'}] [${row.kind}]\n   ${clip(row.content, 160)}`
                )
              } else {
                const row = sqlite
                  .prepare(
                    `SELECT agent_type, title, summary, started_at, last_message_at, project_id
                     FROM sessions WHERE id = ? AND deleted = 0`
                  )
                  .get(s.refId) as
                  | {
                      agent_type: string
                      title: string | null
                      summary: string | null
                      started_at: number | null
                      last_message_at: number | null
                      project_id: number | null
                    }
                  | undefined
                if (!row) continue
                if (agent && row.agent_type !== agent) continue
                if (projectId != null && row.project_id !== projectId) continue
                if (sinceSec != null && (row.last_message_at ?? row.started_at ?? 0) < sinceSec) continue
                const first = row.summary ? clip(row.summary.split('\n')[0] ?? '', 120) : ''
                extra.push(
                  `[session·语义/会话#${s.refId}/${row.agent_type}] ${row.title ?? '(无标题)'}${first ? ` — ${first}` : ''}`
                )
              }
            }
            if (extra.length > 0) {
              if (lines.length === 0) lines.push(`(字面未命中,语义检索召回 ${extra.length} 条)`)
              for (const l of extra) lines.push(`${lines.length + 1}. ${l}`)
            }
          } catch {
            /* semantic search not available — pure FTS result stands */
          }
        }
        touchMemories(memoryHitIds)
        if (lines.length === 0) return `未找到与"${q}"相关的记录。`
        return lines.join('\n')
      }
    },
    {
      name: 'memory_write',
      description:
        '【何时调用】用户表达了偏好/习惯、你们拍板了架构决策、或确认了一个以后还会用到的事实 —— **当场记一条**,不必等用户要求。\n' +
        '写入长期记忆:默认全局;带 project 时写成该项目记忆;也可显式 scope=global/project。一条只写一件事,内容完全相同时拒绝重复写入。',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['fact', 'preference', 'persona', 'decision'] },
          content: { type: 'string', description: '记忆内容(一句话到一小段)' },
          agent: { type: 'string', description: '写入方 agent 归因,如 codex / hermes;全局记忆省略' },
          project: { type: 'string', description: '关联项目名或路径关键词(需已登记);带此参数默认写项目记忆' },
          scope: { type: 'string', enum: ['global', 'project'], description: '记忆作用域;缺省按 project 参数推断' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签,最多 10 个' }
        },
        required: ['kind', 'content']
      },
      handler: (args) => {
        const kind = String(args.kind ?? 'fact')
        const content = String(args.content ?? '').trim()
        if (!VALID_KINDS.has(kind)) return `写入失败:kind 必须是 fact/preference/persona/decision`
        if (!content) return '写入失败:content 不能为空'
        const dup = sqlite
          .prepare('SELECT id FROM memories WHERE content = ? AND deleted = 0 LIMIT 1')
          .get(content) as { id: number } | undefined
        if (dup) {
          return `已存在相同内容的记忆 #${dup.id},未重复写入。如需补充请合并进那条记忆。`
        }
        const agent = typeof args.agent === 'string' && args.agent.trim() ? args.agent.trim() : undefined
        const keyword = typeof args.project === 'string' && args.project.trim() ? args.project.trim() : undefined
        const project = keyword ? findProjectByKeyword(keyword) : null
        const scopeArg = args.scope === 'project' || args.scope === 'global' ? args.scope : undefined
        const scope = scopeArg ?? (project ? 'project' : 'global')
        if (scope === 'project' && !project) {
          return `写入失败:未找到项目「${keyword ?? ''}」,无法写入项目记忆(可先不带 project 写成全局记忆)`
        }
        const rawTags = Array.isArray(args.tags) ? args.tags : []
        const tags = rawTags
          .map((t) => String(t).trim())
          .filter((t) => t.length > 0)
          .slice(0, 10)
        const res = memories.addMemory({
          kind,
          content,
          source: 'agent:mcp',
          agentType: agent,
          projectId: scope === 'project' ? (project?.id ?? null) : null,
          scope,
          tags
        })
        const bits = [`kind=${kind}`, `scope=${scope}`]
        if (agent) bits.push(`agent=${agent}`)
        if (project) bits.push(`project=${project.name}`)
        if (tags.length > 0) bits.push(`tags=${tags.join(',')}`)
        return `已写入记忆 #${res.id} (${bits.join(', ')})`
      }
    },
    {
      name: 'memory_log_progress',
      description:
        '【何时调用】本轮活儿告一段落、用户说"先这样/明天继续"、或要把任务交给下一个 agent 之前 —— 不用等用户提醒。\n' +
        '收工汇报:结构化记录做了什么/下一步/卡在哪,生成一条待确认的进度记忆(候选),任何 agent 拉交接简报时都能看到。',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: '项目名或路径关键词(需已登记;未匹配则不关联项目)' },
          done: { type: 'string', description: '本轮完成的事' },
          next: { type: 'string', description: '下一步计划(可选)' },
          issues: { type: 'string', description: '遇到的问题/风险(可选)' },
          agent: { type: 'string', description: '汇报方 agent 归因(可选)' }
        },
        required: ['project', 'done']
      },
      handler: (args) => {
        const project = String(args.project ?? '').trim()
        const done = String(args.done ?? '').trim()
        if (!project) return '写入失败:project 不能为空'
        if (!done) return '写入失败:done 不能为空'
        const next = String(args.next ?? '').trim()
        const issues = String(args.issues ?? '').trim()
        const agent = typeof args.agent === 'string' && args.agent.trim() ? args.agent.trim() : undefined
        const matched = findProjectByKeyword(project)

        const lines = [`[进度] 项目「${project}」`, `- 完成: ${done}`]
        if (next) lines.push(`- 下一步: ${next}`)
        if (issues) lines.push(`- 问题: ${issues}`)
        const res = memories.addMemory({
          kind: 'fact',
          content: lines.join('\n'),
          source: 'agent:mcp:log_progress',
          agentType: agent,
          status: 'candidate',
          projectId: matched?.id ?? null
        })
        const bits = [`#${res.id}`]
        if (matched) bits.push(`关联项目 ${matched.name}`)
        else bits.push('项目未匹配,未关联')
        return `已记录收工进度(${bits.join(', ')})。该条为候选记忆:会出现在交接简报的「待确认进度」并作为项目总结素材;用户可在记忆页将其「启用」转正,或由自动整理吸收。`
      }
    }
  ]
}
