import type Database from 'better-sqlite3'
import type { McpToolDef } from '../../main/core/plugin-host'
import type { SearchService } from './search'
import type { MemoriesService } from './index'

const VALID_KINDS = new Set(['fact', 'preference', 'persona', 'decision'])

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

function fmtDate(ts: number | null | undefined): string {
  return ts ? new Date(ts * 1000).toLocaleDateString('zh-CN') : '未知日期'
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
}
interface MemoryRow {
  kind: string
  content: string
  updated_at: number
}

/**
 * Agent-facing MCP tools. `memory_get_context` is the "connect and continue"
 * entry point: persona + long-term memory + project + recent sessions in one
 * call, so a fresh agent session is productive from turn one.
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

  const getFacts = (limit = 12): MemoryRow[] =>
    sqlite
      .prepare(
        `SELECT kind, content, updated_at FROM memories
         WHERE kind IN ('fact','preference','decision') AND status = 'active' AND deleted = 0
         ORDER BY updated_at DESC LIMIT ?`
      )
      .all(limit) as MemoryRow[]

  const findProject = (keyword?: string): ProjectRow | null => {
    if (keyword) {
      const row = sqlite
        .prepare(
          `SELECT id, name, path, tech_stack FROM projects
           WHERE deleted = 0 AND (name LIKE ? OR path LIKE ?)
           ORDER BY updated_at DESC LIMIT 1`
        )
        .get(`%${keyword}%`, `%${keyword}%`) as ProjectRow | undefined
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
          `SELECT id, title, summary, started_at FROM sessions
           WHERE deleted = 0 ORDER BY COALESCE(started_at, updated_at) DESC LIMIT ?`
        )
        .all(limit) as SessionRow[]
    }
    return sqlite
      .prepare(
        `SELECT id, title, summary, started_at FROM sessions
         WHERE deleted = 0 AND project_id = ?
         ORDER BY COALESCE(started_at, updated_at) DESC LIMIT ?`
      )
      .all(projectId, limit) as SessionRow[]
  }

  const buildContext = (args: Record<string, unknown>): string => {
    const keyword = typeof args.project === 'string' ? args.project : undefined
    const project = findProject(keyword)
    const persona = getPersona()
    const facts = getFacts()
    const sessions = recentSessions(project?.id ?? null)

    const parts: string[] = ['# MemorySQL 续接上下文\n']

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
      sessions.forEach((s, i) => {
        const firstLine = s.summary ? clip(s.summary.split('\n')[0] ?? '', 120) : ''
        parts.push(
          `  ${i + 1}. #${s.id} [${fmtDate(s.started_at)}] ${s.title ?? '(无标题)'}${firstLine ? ` — ${firstLine}` : ''}`
        )
      })
    } else {
      parts.push('- (该项目暂无会话记录)')
    }

    parts.push(
      '\n> 深读某条会话用 memory_get_session({id});需要更多历史用 memory_search({query});拿到新结论/偏好用 memory_write({kind, content}) 记录。'
    )
    return parts.join('\n')
  }

  return [
    {
      name: 'memory_get_session',
      description:
        '按会话 id 获取完整消息时间线(角色/内容/时间/工具名),用于 agent 回读历史上下文。会话列表与标题旁均展示 id。',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number', description: '会话数字 id' },
          tail: { type: 'number', description: '只取最后 N 条消息(省略则全量)' }
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
        const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…[截断]` : s)
        const when = (ts: number | null): string =>
          ts ? new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false }) : ''
        const body = messages
          .map((m) => {
            const label = m.role === 'tool' ? `TOOL(${m.tool_name ?? 'tool'})` : m.role.toUpperCase()
            return `**${label}** ${when(m.ts)}\n${clip(m.content, 2000)}`
          })
          .join('\n\n---\n\n')
        const head = `# ${session.title ?? `会话 #${id}`}\n- id: ${id}\n- agent: ${session.agent_type}\n- 开始: ${when(session.started_at)}\n- 消息数: ${messages.length}${omitted > 0 ? `(已省略前 ${omitted} 条,可用 tail=0 获取全量)` : ''}\n`
        return `${head}\n${session.summary ? `> 摘要: ${clip(session.summary, 200)}\n\n` : ''}${body}`
      }
    },
    {
      name: 'memory_get_context',
      description:
        '获取"续接包":开发者画像 + 长期记忆 + 项目状态 + 最近会话摘要。agent 新会话开始时调用一次即可恢复上下文。',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: '项目名或路径关键词,缺省取最近活跃项目' }
        }
      },
      handler: (args) => buildContext(args)
    },
    {
      name: 'memory_search',
      description: '全文检索全部会话、消息与记忆(trigram,支持中文)。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索词' },
          limit: { type: 'number', description: '返回条数,默认 20' }
        },
        required: ['query']
      },
      handler: (args) => {
        const q = String(args.query ?? '')
        const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100)
        const hits = search.searchAll(q, limit)
        if (hits.length === 0) return `未找到与"${q}"相关的记录。`
        return hits
          .map(
            (h, i) =>
              `${i + 1}. [${h.kind}/${h.agentType ?? '?'}] ${h.title ?? ''}\n   ${h.snippet.replace(/\n/g, ' ')}`
          )
          .join('\n')
      }
    },
    {
      name: 'memory_write',
      description:
        '向知识库写入一条长期记忆(用户偏好、事实、决策等),跨项目跨 agent 生效。',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['fact', 'preference', 'persona', 'decision'] },
          content: { type: 'string', description: '记忆内容(一句话到一小段)' }
        },
        required: ['kind', 'content']
      },
      handler: (args) => {
        const kind = String(args.kind ?? 'fact')
        const content = String(args.content ?? '').trim()
        if (!VALID_KINDS.has(kind)) return `写入失败:kind 必须是 fact/preference/persona/decision`
        if (!content) return '写入失败:content 不能为空'
        const res = memories.addMemory({ kind, content, source: 'agent:mcp' })
        return `已写入记忆 #${res.id} (kind=${kind})`
      }
    }
  ]
}
