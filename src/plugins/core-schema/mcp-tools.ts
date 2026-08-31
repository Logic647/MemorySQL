import type Database from 'better-sqlite3'
import type { McpToolDef } from '../../main/core/plugin-host'
import type { SearchHit } from '../../shared/types'
import type { SearchService } from './search'
import type { MemoriesService } from './index'

const VALID_KINDS = new Set(['fact', 'preference', 'persona', 'decision'])
const SEARCH_KINDS = new Set(['session', 'message', 'memory', 'note'])

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
  agent_type?: string
  message_count?: number
}
interface MemoryRow {
  kind: string
  content: string
  updated_at: number
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
}): McpToolDef[] {
  const { sqlite, search, memories } = deps

  const getPersona = (): string[] =>
    (
      sqlite
        .prepare(
          `SELECT content FROM memories
           WHERE kind = 'persona' AND status = 'active' AND deleted = 0
           ORDER BY updated_at DESC`
        )
        .all() as Array<{ content: string }>
    ).map((r) => r.content)

  // agent filter keeps global (NULL) memories and rows tagged for that agent
  const getFacts = (limit = 12, agent?: string): MemoryRow[] => {
    const where = [
      `kind IN ('fact','preference','decision')`,
      `status = 'active'`,
      `deleted = 0`,
      ...(agent ? ['(agent_type IS NULL OR agent_type = ?)'] : [])
    ]
    return sqlite
      .prepare(
        `SELECT kind, content, updated_at FROM memories
         WHERE ${where.join(' AND ')}
         ORDER BY updated_at DESC LIMIT ?`
      )
      .all(...(agent ? [agent] : []), limit) as MemoryRow[]
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
           GROUP BY p.id ORDER BY MAX(COALESCE(s.started_at, s.updated_at)) DESC LIMIT 1`
        )
        .get() as ProjectRow | undefined) ?? null
    )
  }

  const recentSessions = (projectId: number | null, limit = 5): SessionRow[] => {
    if (projectId === null) {
      return sqlite
        .prepare(
          `SELECT id, title, summary, started_at, agent_type FROM sessions
           WHERE deleted = 0 ORDER BY COALESCE(started_at, updated_at) DESC LIMIT ?`
        )
        .all(limit) as SessionRow[]
    }
    return sqlite
      .prepare(
        `SELECT id, title, summary, started_at, agent_type FROM sessions
         WHERE deleted = 0 AND project_id = ?
         ORDER BY COALESCE(started_at, updated_at) DESC LIMIT ?`
      )
      .all(projectId, limit) as SessionRow[]
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
    return `#${s.id} [${s.agent_type ?? '?'}] [${fmtDate(s.started_at)}] ${s.title ?? '(无标题)'}${
      typeof s.message_count === 'number' ? ` (${s.message_count} 条消息)` : ''
    }${firstLine ? ` — ${firstLine}` : ''}`
  }

  const buildContext = (args: Record<string, unknown>): string => {
    const keyword = typeof args.project === 'string' ? args.project : undefined
    const agent = typeof args.agent === 'string' && args.agent.trim() ? args.agent.trim() : undefined
    const includeLast = args.include_last_session === true
    const project = findProject(keyword)
    const persona = getPersona()
    const facts = getFacts(12, agent)
    const sessions = recentSessions(project?.id ?? null)

    const parts: string[] = ['# MemorySQL 续接上下文\n']
    if (agent) parts.push(`> 记忆按 agent 过滤: ${agent}(含全局记忆)\n`)

    parts.push('## 开发者画像')
    if (persona.length > 0) {
      for (const p of persona) parts.push(p.split('\n').map((l) => `- ${l}`).join('\n'))
    } else {
      parts.push('(暂无画像 — 可调用 memory_write 写入 kind=persona)')
    }

    parts.push('\n## 长期记忆(最近 12 条)')
    if (facts.length > 0) {
      for (const f of facts) parts.push(`- [${f.kind}] ${clip(f.content, 160)}`)
    } else {
      parts.push('(暂无)')
    }

    parts.push(`\n## 项目: ${project?.name ?? '(未指定)'}`)
    if (project?.path) parts.push(`- 路径: ${project.path}`)
    if (project?.tech_stack) parts.push(`- 技术栈: ${project.tech_stack}`)
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
      '\n> 深读某条会话用 memory_get_session({id});需要更多历史用 memory_list_sessions 或 memory_search({query});拿到新结论/偏好用 memory_write({kind, content}) 记录;收工时用 memory_log_progress 汇报进度。'
    )
    return parts.join('\n')
  }

  const buildBrief = (args: Record<string, unknown>): string => {
    const keyword = typeof args.project === 'string' ? args.project : undefined
    const agent = typeof args.agent === 'string' && args.agent.trim() ? args.agent.trim() : undefined
    const project = findProject(keyword)
    const projectId = project?.id ?? null
    const sessions = recentSessions(projectId, 8)

    const parts: string[] = [
      `# 项目交接简报: ${project?.name ?? '(未指定项目)'}`,
      ''
    ]
    if (project?.path) parts.push(`- 路径: ${project.path}`)
    if (project?.tech_stack) parts.push(`- 技术栈: ${project.tech_stack}`)
    if (agent) parts.push(`- 面向 agent: ${agent}(记忆含全局)`)

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

    const memWhere = [
      `kind IN ('fact','preference','decision')`,
      `status = 'active'`,
      `deleted = 0`,
      ...(agent ? ['(agent_type IS NULL OR agent_type = ?)'] : [])
    ]
    const activeMems = sqlite
      .prepare(
        `SELECT kind, content FROM memories WHERE ${memWhere.join(' AND ')} ORDER BY updated_at DESC LIMIT 10`
      )
      .all(...(agent ? [agent] : [])) as Array<{ kind: string; content: string }>
    parts.push('\n## 相关活跃记忆')
    if (activeMems.length > 0) {
      for (const m of activeMems) parts.push(`- [${m.kind}] ${clip(m.content, 200)}`)
    } else {
      parts.push('(暂无)')
    }

    const progressWhere = [
      `status = 'candidate'`,
      `deleted = 0`,
      `source LIKE 'agent:mcp:log_progress%'`,
      ...(agent ? ['(agent_type IS NULL OR agent_type = ?)'] : [])
    ]
    const progress = sqlite
      .prepare(
        `SELECT id, content FROM memories WHERE ${progressWhere.join(' AND ')} ORDER BY updated_at DESC LIMIT 5`
      )
      .all(...(agent ? [agent] : [])) as Array<{ id: number; content: string }>
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
        '获取"续接包":开发者画像 + 长期记忆 + 项目状态 + 最近会话(带 id,可直接深读)。agent 新会话开始时调用一次即可恢复上下文。可选按 agent 过滤记忆、内联最近会话 tail 作为上一棒交接摘要。',
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
        '获取项目交接简报:最近会话、上一棒 tail、相关活跃记忆、待确认进度,从知识库自动汇编,用于换 agent 接手或回滚上下文。',
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
        '枚举会话列表(带 id):按项目、agent、时间范围过滤,返回 id/标题/agent/开始时间/消息数。找"某项目最近做过什么"用这个;关键词内容检索用 memory_search。',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: '项目名或路径关键词(精确匹配项目,不回退最近活跃)' },
          agent: { type: 'string', description: '按 agent 过滤,如 codex / hermes / zcode' },
          since: { type: 'number', description: '只看最近 N 天,如 7' },
          limit: { type: 'number', description: '返回条数,默认 20,上限 100' },
          offset: { type: 'number', description: '分页偏移,默认 0' }
        }
      },
      handler: (args) => {
        const keyword = typeof args.project === 'string' ? args.project : undefined
        const agent = typeof args.agent === 'string' && args.agent.trim() ? args.agent.trim() : undefined
        const sinceDays = Number(args.since)
        const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100)
        const offset = Math.max(Number(args.offset) || 0, 0)

        if (keyword && !findProjectByKeyword(keyword)) {
          return `未找到与"${keyword}"匹配的项目。可用 memory_search 按内容找会话。`
        }
        const projectId = keyword ? findProjectByKeyword(keyword)!.id : null
        const where = ['deleted = 0']
        const params: unknown[] = []
        if (projectId !== null) {
          where.push('project_id = ?')
          params.push(projectId)
        }
        if (agent) {
          where.push('agent_type = ?')
          params.push(agent)
        }
        if (sinceDays > 0) {
          where.push('COALESCE(started_at, updated_at) >= ?')
          params.push(sinceCutoffSec(sinceDays))
        }
        const rows = sqlite
          .prepare(
            `SELECT id, title, summary, started_at, agent_type, message_count FROM sessions
             WHERE ${where.join(' AND ')}
             ORDER BY COALESCE(started_at, updated_at) DESC LIMIT ? OFFSET ?`
          )
          .all(...params, limit, offset) as SessionRow[]
        if (rows.length === 0) return '没有符合条件的会话。'
        return rows.map((s, i) => `${i + 1}. ${sessionLine(s)}`).join('\n')
      }
    },
    {
      name: 'memory_get_session',
      description:
        '按会话 id 获取完整消息时间线(角色/内容/时间/工具名),用于 agent 回读历史上下文。full=true 去掉单条 2000 字符截断(总输出仍有限);列表见 memory_list_sessions。',
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
          .prepare('SELECT title, agent_type, started_at, summary FROM sessions WHERE id = ? AND deleted = 0')
          .get(id) as { title: string | null; agent_type: string; started_at: number | null; summary: string | null } | undefined
        if (!session) return `未找到会话 #${id}`
        let messages = sqlite
          .prepare('SELECT role, content, ts, tool_name FROM session_messages WHERE session_id = ? ORDER BY seq')
          .all(id) as Array<{ role: string; content: string; ts: number | null; tool_name: string | null }>
        const tail = Number(args.tail)
        const omitted = tail > 0 && messages.length > tail ? messages.length - tail : 0
        if (omitted > 0) messages = messages.slice(-tail)
        const perMessage = args.full === true ? 20000 : 2000
        const TOTAL_CAP = 120_000
        let capped = false
        const clipMsg = (s: string, n: number): string =>
          s.length > n ? `${s.slice(0, n)}…[截断]` : s
        const when = (ts: number | null): string => (ts ? fmtTime(ts) : '')
        const lines: string[] = []
        for (const m of messages) {
          const label = m.role === 'tool' ? `TOOL(${m.tool_name ?? 'tool'})` : m.role.toUpperCase()
          lines.push(`**${label}** ${when(m.ts)}\n${clipMsg(m.content, perMessage)}`)
          if (lines.join('\n\n---\n\n').length > TOTAL_CAP) {
            lines.pop()
            capped = true
            break
          }
        }
        const body = lines.join('\n\n---\n\n')
        const head = `# ${session.title ?? `会话 #${id}`}\n- id: ${id}\n- agent: ${session.agent_type}\n- 开始: ${when(session.started_at)}\n- 消息数: ${messages.length}${omitted > 0 ? `(已省略前 ${omitted} 条,可用 tail=0 获取全量)` : ''}\n`
        const capNote = capped ? '\n\n> [已达输出上限,后面内容被省略 — 用 tail 参数收窄范围]' : ''
        return `${head}\n${session.summary ? `> 摘要: ${clip(session.summary, 200)}\n\n` : ''}${body}${capNote}`
      }
    },
    {
      name: 'memory_search',
      description:
        '全文检索会话/消息/记忆/笔记(trigram,支持中文),可按 kind、agent、项目、时间范围收窄。列举会话(不按内容)用 memory_list_sessions。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索词' },
          limit: { type: 'number', description: '返回条数,默认 20,上限 100' },
          kind: { type: 'string', enum: ['session', 'message', 'memory', 'note'], description: '只搜某类资产' },
          agent: { type: 'string', description: '按 agent 过滤(记忆含全局)' },
          project: { type: 'string', description: '项目名或路径关键词(作用于会话/消息)' },
          since: { type: 'number', description: '只看最近 N 天,如 7' }
        },
        required: ['query']
      },
      handler: (args) => {
        const q = String(args.query ?? '')
        const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100)
        const kind = typeof args.kind === 'string' ? args.kind : undefined
        if (kind && !SEARCH_KINDS.has(kind)) {
          return `参数错误:kind 必须是 session/message/memory/note`
        }
        const agent = typeof args.agent === 'string' && args.agent.trim() ? args.agent.trim() : undefined
        const keyword = typeof args.project === 'string' && args.project.trim() ? args.project.trim() : undefined
        let projectId: number | undefined
        if (keyword) {
          const p = findProjectByKeyword(keyword)
          if (!p) return `未找到与"${keyword}"匹配的项目 — 项目过滤后无结果。可去掉 project 参数全库搜索。`
          projectId = p.id
        }
        const sinceDays = Number(args.since)
        const hits = search.searchAll(q, limit, {
          kinds: kind ? [kind as SearchHit['kind']] : undefined,
          agent,
          projectId,
          sinceSec: sinceDays > 0 ? sinceCutoffSec(sinceDays) : undefined
        })
        if (hits.length === 0) return `未找到与"${q}"相关的记录。`
        return hits
          .map(
            (h, i) =>
              `${i + 1}. [${h.kind}${h.sessionId != null ? ` 会话#${h.sessionId}` : ''}/${h.agentType ?? '?'}] ${h.title ?? ''}\n   ${h.snippet.replace(/\n/g, ' ')}`
          )
          .join('\n')
      }
    },
    {
      name: 'memory_write',
      description:
        '向知识库写入一条长期记忆(用户偏好、事实、决策等),跨项目跨 agent 生效。可附 agent 归因、项目关联与标签;内容与现有记忆完全相同时拒绝重复写入。',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['fact', 'preference', 'persona', 'decision'] },
          content: { type: 'string', description: '记忆内容(一句话到一小段)' },
          agent: { type: 'string', description: '写入方 agent 归因,如 codex / hermes;全局记忆省略' },
          project: { type: 'string', description: '关联项目名或路径关键词(需已登记,未匹配则不关联)' },
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
          projectId: project?.id ?? null,
          tags
        })
        const bits = [`kind=${kind}`]
        if (agent) bits.push(`agent=${agent}`)
        if (project) bits.push(`project=${project.name}`)
        if (tags.length > 0) bits.push(`tags=${tags.join(',')}`)
        return `已写入记忆 #${res.id} (${bits.join(', ')})`
      }
    },
    {
      name: 'memory_log_progress',
      description:
        '收工汇报:结构化记录本轮做了什么/下一步/卡在哪,生成一条待确认的进度记忆(候选),下次任何 agent 拉取交接简报时可见。建议每次收工或换 agent 前调用。',
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
        return `已记录收工进度(${bits.join(', ')})。该条为候选记忆,用户在 UI 确认后进入活跃记忆;其余 agent 可在 memory_get_project_brief 的"待确认进度"中看到。`
      }
    }
  ]
}
