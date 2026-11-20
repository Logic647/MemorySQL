// 内置知识库后端：不依赖 MemorySQL 桌面应用，插件自己用 SQLite 存
// 记忆/会话/项目，并提供与 MemorySQL MCP 同名同形状的 10 个工具。
//
// 设计取舍：
// - 只覆盖「续接」需要的那部分：记忆、会话档案、项目、FTS 检索；
//   不做 LLM 滚动总结/curator（那是 MemorySQL 应用的能力，接 app 后端时才有）。
// - 时间口径跟 MemorySQL 一致：sessions 秒，memories/projects.updated_at 毫秒。
// - 所有查询同步执行；写操作走事务，消息级 diff 只重写变化的尾部。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase } from './sqlite.mjs'
import { migrate } from './schema.mjs'

const KIND_ORDER = ['persona', 'preference', 'fact', 'decision']
const KIND_LABEL = { persona: '画像', preference: '偏好', fact: '事实', decision: '决策' }
const KIND_QUOTA = { persona: 6, preference: 8, fact: 10, decision: 8 }
const VALID_KINDS = new Set(['fact', 'preference', 'persona', 'decision'])
const MAX_CAPTURE_MESSAGES = 5000

function clip(text, max) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

function fmtDate(seconds) {
  return seconds ? new Date(seconds * 1000).toLocaleDateString('zh-CN') : '未知日期'
}

function fmtTime(seconds) {
  return seconds ? new Date(seconds * 1000).toLocaleString('zh-CN', { hour12: false }) : ''
}

function sinceCutoffSec(days) {
  return Math.floor(Date.now() / 1000) - days * 86400
}

function normPath(value) {
  if (!value) return ''
  let s = String(value).trim().replace(/\\/g, '/').replace(/\/+$/, '')
  if (process.platform === 'win32') s = s.toLowerCase()
  return s
}

function firstLine(text) {
  const line = String(text ?? '')
    .split('\n')
    .find((l) => l.trim().length > 0)
  return (line ?? '').trim()
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (c) => `\\${c}`)
}

function resolveDataDir(options) {
  const raw = typeof options.dataDir === 'string' ? options.dataDir.trim() : ''
  if (raw) return raw
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(base, 'magpie', 'memorysql')
}

function sessionLine(row) {
  const summary = row.summary ? clip(String(row.summary).split('\n')[0] ?? '', 120) : ''
  const started = row.started_at ?? row.last_message_at ?? null
  const last =
    typeof row.last_message_at === 'number' && row.last_message_at !== started
      ? ` [最后 ${fmtDate(row.last_message_at)}]`
      : ''
  return `#${row.id} [${row.agent_type ?? '?'}] [${fmtDate(started)}]${last} ${
    row.title ?? '(无标题)'
  }${typeof row.message_count === 'number' ? ` (${row.message_count} 条消息)` : ''}${
    summary ? ` — ${summary}` : ''
  }`
}

export async function createEmbeddedBackend(options = {}) {
  const dataDir = resolveDataDir(options)
  const inMemory = dataDir === ':memory:' || options.memory === true
  if (!inMemory) fs.mkdirSync(dataDir, { recursive: true })
  const file = inMemory ? ':memory:' : path.join(dataDir, 'memory.db')
  const db = await openDatabase(file)
  migrate(db)

  const all = (sql, ...params) => db.prepare(sql).all(...params)
  const get = (sql, ...params) => db.prepare(sql).get(...params)
  const run = (sql, ...params) => db.prepare(sql).run(...params)

  // ----- 项目 -------------------------------------------------------------
  function projectsByCwd(cwd) {
    const target = normPath(cwd)
    if (!target) return []
    const rows = all('SELECT id, name, path FROM projects WHERE deleted = 0 AND path IS NOT NULL')
    let best = null
    let bestLen = -1
    for (const row of rows) {
      const p = normPath(row.path)
      if (!p) continue
      if (target === p || target.startsWith(`${p}/`)) {
        if (p.length > bestLen) {
          best = row
          bestLen = p.length
        }
      }
    }
    return best ? [best] : []
  }

  function projectsByKeyword(keyword) {
    const like = `%${keyword}%`
    const byName = all(
      'SELECT id, name, path FROM projects WHERE deleted = 0 AND name LIKE ? ORDER BY updated_at DESC',
      like
    )
    if (byName.length > 0) return byName
    return all(
      'SELECT id, name, path FROM projects WHERE deleted = 0 AND path LIKE ? ORDER BY updated_at DESC',
      like
    )
  }

  function resolveProjects({ project, cwd } = {}) {
    if (cwd && cwd.trim()) {
      const byCwd = projectsByCwd(cwd)
      if (byCwd.length > 0) return byCwd
    }
    return project && project.trim() ? projectsByKeyword(project.trim()) : []
  }

  function activeProject() {
    return get(
      `SELECT p.id, p.name, p.path, MAX(COALESCE(s.last_message_at, s.started_at, s.ended_at)) AS lastActive
         FROM projects p JOIN sessions s ON s.project_id = p.id AND s.deleted = 0
        WHERE p.deleted = 0
        GROUP BY p.id
        ORDER BY lastActive DESC LIMIT 1`
    )
  }

  function findProject({ project, cwd } = {}) {
    if (cwd && cwd.trim()) {
      const byCwd = projectsByCwd(cwd)
      if (byCwd[0]) return byCwd[0]
    }
    if (project && project.trim()) {
      const byName = projectsByKeyword(project.trim())
      if (byName[0]) return byName[0]
    }
    return activeProject()
  }

  /** 写记忆/收工汇报用：给了 project/cwd 就必须命中，不能落到最近活跃项目。 */
  function findProjectStrict({ project, cwd } = {}) {
    if (cwd && cwd.trim()) {
      const byCwd = projectsByCwd(cwd)
      if (byCwd[0]) return byCwd[0]
    }
    if (project && project.trim()) {
      const byName = projectsByKeyword(project.trim())
      if (byName[0]) return byName[0]
    }
    return null
  }

  function ensureProject(cwd) {
    if (!cwd) return null
    const existing = get('SELECT id FROM projects WHERE path = ?', cwd)
    if (existing) return existing.id
    const name = path.basename(cwd) || cwd
    return Number(run('INSERT INTO projects (path, name, updated_at) VALUES (?, ?, ?)', cwd, name, Date.now()).lastInsertRowid)
  }

  // ----- 记忆 -------------------------------------------------------------
  function loadMemories(scope, projectIds, agent) {
    const where = ['deleted = 0', `status = 'active'`, 'scope = ?']
    const params = [scope]
    if (scope === 'project') {
      if (!projectIds || projectIds.length === 0) return []
      where.push(`project_id IN (${projectIds.map(() => '?').join(',')})`)
      params.push(...projectIds)
    }
    if (agent) {
      where.push("(kind = 'persona' OR agent_type IS NULL OR agent_type = ?)")
      params.push(agent)
    }
    return all(
      `SELECT id, kind, content, scope, project_id AS projectId, locked, confidence,
              updated_at, access_count AS accessCount, last_access_at AS lastAccessAt, agent_type
         FROM memories WHERE ${where.join(' AND ')}
        ORDER BY locked DESC, updated_at DESC LIMIT 240`,
      ...params
    )
  }

  function renderMemoryBlock(heading, rows, budget) {
    const byKind = new Map()
    for (const row of rows) {
      const list = byKind.get(row.kind) ?? []
      list.push(row)
      byKind.set(row.kind, list)
    }
    const lines = [`\n${heading}`]
    const ids = []
    const seen = new Set()
    let used = 0
    outer: for (const kind of KIND_ORDER) {
      const list = (byKind.get(kind) ?? [])
        .filter((r) => {
          const key = `${r.kind}|${r.content}`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
        .sort((a, b) => (b.locked ?? 0) - (a.locked ?? 0) || b.updated_at - a.updated_at)
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
    if (ids.length === 0) lines.push('(暂无 — 可调用 memory_write 写入)')
    return { text: lines.join('\n'), ids }
  }

  function touchMemories(ids) {
    if (!ids || ids.length === 0) return
    const unique = [...new Set(ids)]
    try {
      run(
        `UPDATE memories SET access_count = access_count + 1, last_access_at = ?
          WHERE id IN (${unique.map(() => '?').join(',')}) AND deleted = 0`,
        Date.now(),
        ...unique
      )
    } catch {
      /* 热度只是排序增强 */
    }
  }

  // ----- 会话 -------------------------------------------------------------
  function recentSessions(projectIds, limit = 5) {
    const order = 'COALESCE(s.last_message_at, s.started_at, s.updated_at) DESC'
    if (projectIds && projectIds.length > 0) {
      return all(
        `SELECT s.id, s.title, s.summary, s.started_at, s.last_message_at, s.agent_type, s.message_count
           FROM sessions s
          WHERE s.deleted = 0 AND s.project_id IN (${projectIds.map(() => '?').join(',')})
          ORDER BY ${order} LIMIT ?`,
        ...projectIds,
        limit
      )
    }
    return all(
      `SELECT s.id, s.title, s.summary, s.started_at, s.last_message_at, s.agent_type, s.message_count
         FROM sessions s WHERE s.deleted = 0 ORDER BY ${order} LIMIT ?`,
      limit
    )
  }

  function renderTail(sessionId, maxMessages = 6, clipLen = 500) {
    const rows = all(
      `SELECT role, content, ts, tool_name FROM session_messages
        WHERE session_id = ? ORDER BY seq DESC LIMIT ?`,
      sessionId,
      maxMessages
    ).reverse()
    return rows
      .map((m) => {
        const label = m.role === 'tool' ? `TOOL(${m.tool_name ?? 'tool'})` : String(m.role).toUpperCase()
        const when = fmtTime(m.ts)
        return `- ${label}${when ? ` ${when}` : ''}: ${clip(m.content, clipLen)}`
      })
      .join('\n')
  }

  // ----- 工具 -------------------------------------------------------------
  function context(args = {}) {
    const keyword = typeof args.project === 'string' ? args.project : undefined
    const cwd = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : undefined
    const agent = typeof args.agent === 'string' && args.agent.trim() ? args.agent.trim() : undefined
    const matched = resolveProjects({ project: keyword, cwd })
    const active = activeProject()
    const project = matched[0] ?? active
    const projectIds = matched.length > 0 ? matched.map((p) => p.id) : active ? [active.id] : null
    const globalRows = loadMemories('global', null, agent)
    const projectRows = projectIds ? loadMemories('project', projectIds, agent) : []
    const sessions = recentSessions(projectIds, 5)
    // 全新库：没有项目/记忆/会话时返回空，网关钩子据此跳过注入
    if (!project && globalRows.length === 0 && sessions.length === 0) return ''
    const globalBlock = renderMemoryBlock('## 全局记忆', globalRows, 2200)
    const projectBlock = projectIds
      ? renderMemoryBlock(`## 项目记忆: ${project?.name ?? '(未指定)'}`, projectRows, 2600)
      : null
    touchMemories([...globalBlock.ids, ...(projectBlock?.ids ?? [])])

    const parts = ['# MemorySQL 续接上下文\n']
    if (agent) parts.push(`> 记忆按 agent 过滤: ${agent}(含全局记忆)\n`)
    parts.push(globalBlock.text)
    if (project) {
      parts.push(`\n## 项目: ${project.name}`)
      if (project.path) parts.push(`- 路径: ${project.path}`)
    }
    if (projectBlock) parts.push(projectBlock.text)
    if (sessions.length > 0) {
      parts.push('- 最近会话:')
      for (const s of sessions) parts.push(`  - ${sessionLine(s)}`)
    } else {
      parts.push('- (该项目暂无会话记录)')
    }
    if (args.include_last_session === true && sessions.length > 0) {
      parts.push(`\n## 上一棒交接摘要(最近会话 #${sessions[0].id} tail)`)
      parts.push(renderTail(sessions[0].id))
    }
    parts.push(
      '\n> 深读某条会话用 memory_get_session({id});需要更多历史用 memory_list_sessions 或 memory_search({query});拿到新结论/偏好用 memory_write({kind, content, project?}) 记录;收工时用 memory_log_progress 汇报进度。'
    )
    return parts.join('\n')
  }

  function projectProgress(projectIds, agent, limit = 5) {
    const where = ["status = 'candidate'", 'deleted = 0', "source LIKE 'agent:mcp:log_progress%'"]
    const params = []
    if (agent) {
      where.push('(agent_type IS NULL OR agent_type = ?)')
      params.push(agent)
    }
    if (projectIds && projectIds.length > 0) {
      where.push(`project_id IN (${projectIds.map(() => '?').join(',')})`)
      params.push(...projectIds)
    } else {
      where.push('1 = 0')
    }
    return all(
      `SELECT id, content FROM memories WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`,
      ...params,
      limit
    )
  }

  function brief(args = {}) {
    const keyword = typeof args.project === 'string' ? args.project : undefined
    const cwd = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : undefined
    const agent = typeof args.agent === 'string' && args.agent.trim() ? args.agent.trim() : undefined
    const project = findProject({ project: keyword, cwd })
    const matched = resolveProjects({ project: keyword, cwd })
    const projectIds = matched.length > 0 ? matched.map((p) => p.id) : project ? [project.id] : null
    const sessions = recentSessions(projectIds, 8)
    const globalRows = loadMemories('global', null, agent)
    const projectRows = projectIds ? loadMemories('project', projectIds, agent) : []
    const globalBlock = renderMemoryBlock('## 全局记忆', globalRows, 2200)
    const projectBlock = projectIds
      ? renderMemoryBlock(`## 项目记忆: ${project?.name ?? '(未指定)'}`, projectRows, 2600)
      : null
    touchMemories([...globalBlock.ids, ...(projectBlock?.ids ?? [])])

    const parts = [`# 项目交接简报: ${project?.name ?? '(未指定项目)'}`, '']
    if (project?.path) parts.push(`- 路径: ${project.path}`)
    if (agent) parts.push(`- 面向 agent: ${agent}(记忆含全局)`)
    parts.push(globalBlock.text)
    if (projectBlock) parts.push(projectBlock.text)

    parts.push('\n## 最近会话(接棒上下文)')
    if (sessions.length > 0) for (const s of sessions) parts.push(`- ${sessionLine(s)}`)
    else parts.push('(该项目暂无会话记录)')
    if (sessions.length > 0) {
      parts.push(`\n## 上一棒进行到哪(最近会话 #${sessions[0].id} tail)`)
      parts.push(renderTail(sessions[0].id))
    }
    const progress = projectProgress(projectIds, agent)
    parts.push('\n## 待确认进度(收工汇报候选)')
    if (progress.length > 0) for (const p of progress) parts.push(`- #${p.id} ${clip(p.content, 200)}`)
    else parts.push('(暂无 — agent 收工时用 memory_log_progress 汇报)')
    parts.push(
      '\n> 本简报由内置存储从会话与记忆汇编。深读历史: memory_get_session({id});收工汇报: memory_log_progress({project, done, next?, issues?})。'
    )
    return parts.join('\n')
  }

  function digest(args = {}) {
    const project = findProject({ project: args.project, cwd: args.cwd })
    if (!project) return '(库中还没有项目)'
    const sessions = recentSessions([project.id], 8)
    const total = (
      get('SELECT count(*) AS n FROM sessions WHERE project_id = ? AND deleted = 0', project.id) ?? { n: 0 }
    ).n
    const memories = loadMemories('project', [project.id])
    const progress = projectProgress([project.id], undefined)
    const todos = []
    for (const p of progress) {
      for (const line of String(p.content).split('\n')) {
        if (/^-\s*(下一步|问题)\s*[:：]/.test(line.trim())) todos.push(line.replace(/^\s*-\s*/, '').trim())
      }
    }
    const last = sessions[0]?.last_message_at ?? sessions[0]?.started_at ?? null
    const parts = [
      `# 项目总结: ${project.name}(内置存储 · 规则汇编)`,
      project.path ? `- 路径: ${project.path}` : '',
      `- 会话: ${total} · 最近活跃: ${fmtDate(last)} · 项目记忆: ${memories.length}`,
      '\n## 最近会话'
    ].filter(Boolean)
    if (sessions.length === 0) parts.push('(暂无会话)')
    else for (const s of sessions) parts.push(`- ${sessionLine(s)}`)
    parts.push('\n## 待办(来自收工汇报)')
    if (todos.length === 0) parts.push('(暂无)')
    else for (const t of todos.slice(0, 12)) parts.push(`- ${t}`)
    parts.push('\n> 内置存储不调用 LLM,这里是规则汇编;接入 MemorySQL 应用(app 后端)后是滚动总结。')
    return parts.join('\n')
  }

  function listProjects(args = {}) {
    const limit = Math.min(Math.max(Number(args.limit) || 30, 1), 100)
    const includeEmpty = args.includeEmpty === true
    const rows = all(
      `SELECT p.id, p.name, p.path, p.updated_at AS updatedAt,
              COUNT(s.id) AS sessions,
              MAX(COALESCE(s.last_message_at, s.started_at, s.ended_at)) AS lastActive
         FROM projects p
         LEFT JOIN sessions s ON s.project_id = p.id AND s.deleted = 0
        WHERE p.deleted = 0
        GROUP BY p.id
        ${includeEmpty ? '' : 'HAVING sessions > 0'}
        ORDER BY COALESCE(lastActive, p.updated_at / 1000) DESC
        LIMIT ?`,
      limit
    )
    if (rows.length === 0) return '知识库里还没有项目。'
    if (args.format === 'json') {
      return JSON.stringify(rows.map((r) => ({ ...r, digest: null })), null, 2)
    }
    const lines = rows.map((r, i) => {
      const bits = [`${r.sessions} 个会话`]
      if (r.lastActive) bits.push(`最后活跃 ${fmtDate(r.lastActive)}`)
      return `${i + 1}. #${r.id} ${r.name}${r.path ? ` — ${r.path}` : ''}\n   ${bits.join(' · ')}`
    })
    return `# 项目列表(共 ${rows.length} 个)\n${lines.join('\n')}\n\n> 看某个项目: memory_get_project_brief({project}) 或 memory_get_context({project})。`
  }

  function listSessions(args = {}) {
    const keyword = typeof args.project === 'string' ? args.project : undefined
    const cwd = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : undefined
    const agent = typeof args.agent === 'string' && args.agent.trim() ? args.agent.trim() : undefined
    const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100)
    const offset = Math.max(Number(args.offset) || 0, 0)
    const since = Number(args.since)
    const matched = resolveProjects({ project: keyword, cwd })
    if ((keyword || cwd) && matched.length === 0) return `未找到与"${keyword ?? cwd}"匹配的项目。`
    const where = ['s.deleted = 0']
    const params = []
    if (matched.length > 0) {
      where.push(`s.project_id IN (${matched.map(() => '?').join(',')})`)
      params.push(...matched.map((p) => p.id))
    }
    if (agent) {
      where.push('s.agent_type = ?')
      params.push(agent)
    }
    if (since > 0) {
      where.push('COALESCE(s.last_message_at, s.started_at, s.updated_at) >= ?')
      params.push(sinceCutoffSec(since))
    }
    const rows = all(
      `SELECT s.id, s.title, s.summary, s.started_at, s.last_message_at, s.agent_type, s.message_count,
              p.name AS project
         FROM sessions s LEFT JOIN projects p ON p.id = s.project_id
        WHERE ${where.join(' AND ')}
        ORDER BY COALESCE(s.last_message_at, s.started_at, s.updated_at) DESC
        LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset
    )
    if (rows.length === 0) return '没有符合条件的会话。'
    if (args.format === 'json') {
      return JSON.stringify(
        rows.map((s) => ({
          id: s.id,
          title: s.title,
          summary: s.summary,
          agent: s.agent_type ?? null,
          project: s.project ?? null,
          startedAt: s.started_at ?? null,
          lastMessageAt: s.last_message_at ?? null,
          messageCount: s.message_count ?? null
        })),
        null,
        2
      )
    }
    return rows.map((s, i) => `${i + 1}. ${sessionLine(s)}`).join('\n')
  }

  function getSession(args = {}) {
    const id = Number(args.id)
    if (!id || Number.isNaN(id)) return '参数错误:需要数字 id'
    const session = get(
      'SELECT title, agent_type, started_at, last_message_at, summary FROM sessions WHERE id = ? AND deleted = 0',
      id
    )
    if (!session) return `未找到会话 #${id}`
    const total = (
      get('SELECT count(*) AS n FROM session_messages WHERE session_id = ?', id) ?? { n: 0 }
    ).n
    const tail = Number(args.tail)
    const messages = (
      tail > 0
        ? all(
            'SELECT role, content, ts, tool_name FROM session_messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?',
            id,
            tail
          ).reverse()
        : all(
            'SELECT role, content, ts, tool_name FROM session_messages WHERE session_id = ? ORDER BY seq',
            id
          )
    )
    const omitted = tail > 0 && total > messages.length ? total - messages.length : 0
    const perMessage = args.full === true ? 20000 : 2000
    const totalCap = args.full === true ? 80000 : 40000
    const sep = '\n\n---\n\n'
    let budget = totalCap
    const kept = []
    let capped = false
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i]
      const label = m.role === 'tool' ? `TOOL(${m.tool_name ?? 'tool'})` : String(m.role).toUpperCase()
      const line = `**${label}** ${fmtTime(m.ts)}\n${
        m.content.length > perMessage ? `${m.content.slice(0, perMessage)}…[截断]` : m.content
      }`
      const extra = line.length + (kept.length > 0 ? sep.length : 0)
      if (extra > budget) {
        capped = true
        break
      }
      kept.push(line)
      budget -= extra
    }
    kept.reverse()
    const head = `# ${session.title ?? `会话 #${id}`}\n- id: ${id}\n- agent: ${session.agent_type}\n- 开始: ${fmtTime(
      session.started_at
    )}\n- 最后: ${fmtTime(session.last_message_at)}\n- 消息数: ${total}${
      omitted > 0 ? `(本次取最后 ${messages.length} 条,已省略前 ${omitted} 条 — 用 tail 调整)` : ''
    }\n`
    const capNote = capped
      ? `\n\n> [输出已达 ${totalCap} 字符上限,保留了最近 ${kept.length}/${messages.length} 条(最早 ${
          messages.length - kept.length
        } 条未显示)。要看更早内容:tail=N 取最近 N 条]`
      : ''
    return `${head}\n${
      session.summary ? `> 摘要: ${clip(session.summary, 200)}\n\n` : ''
    }${kept.join(sep)}${capNote}`
  }

  function ftsExpr(query) {
    const tokens = query.split(/\s+/).filter((t) => t.length >= 3)
    if (tokens.length > 1) return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND ')
    return `"${query.replace(/"/g, '""')}"`
  }

  function search(args = {}) {
    const query = String(args.query ?? '').trim()
    if (!query) return '参数错误:query 不能为空'
    const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100)
    const kind = typeof args.kind === 'string' ? args.kind : undefined
    if (kind && !['session', 'message', 'memory'].includes(kind)) {
      return '参数错误:kind 必须是 session/message/memory'
    }
    const agent = typeof args.agent === 'string' && args.agent.trim() ? args.agent.trim() : undefined
    const keyword = typeof args.project === 'string' && args.project.trim() ? args.project.trim() : undefined
    const cwd = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : undefined
    let projectIds
    if (keyword || cwd) {
      const matched = resolveProjects({ project: keyword, cwd })
      if (matched.length === 0) return `未找到与"${keyword ?? cwd}"匹配的项目 — 项目过滤后无结果。可去掉 project 参数全库搜索。`
      projectIds = matched.map((p) => p.id)
    }
    const since = Number(args.since) > 0 ? sinceCutoffSec(Number(args.since)) : undefined
    const expr = ftsExpr(query)
    const hits = []

    const memoryWhere = ['m.deleted = 0', "m.status IN ('active','candidate')"]
    const memoryParams = []
    if (agent) {
      memoryWhere.push("(m.kind = 'persona' OR m.agent_type IS NULL OR m.agent_type = ?)")
      memoryParams.push(agent)
    }
    if (projectIds) {
      memoryWhere.push(`(m.scope = 'global' OR m.project_id IN (${projectIds.map(() => '?').join(',')}))`)
      memoryParams.push(...projectIds)
    }
    if (since) {
      memoryWhere.push('m.updated_at >= ?')
      memoryParams.push(since * 1000)
    }

    const sessionWhere = ['s.deleted = 0']
    const sessionParams = []
    if (agent) {
      sessionWhere.push('s.agent_type = ?')
      sessionParams.push(agent)
    }
    if (projectIds) {
      sessionWhere.push(`s.project_id IN (${projectIds.map(() => '?').join(',')})`)
      sessionParams.push(...projectIds)
    }
    if (since) {
      sessionWhere.push('COALESCE(s.last_message_at, s.started_at, s.updated_at) >= ?')
      sessionParams.push(since)
    }

    const messageWhere = ['s.deleted = 0']
    const messageParams = []
    if (agent) {
      messageWhere.push('s.agent_type = ?')
      messageParams.push(agent)
    }
    if (projectIds) {
      messageWhere.push(`s.project_id IN (${projectIds.map(() => '?').join(',')})`)
      messageParams.push(...projectIds)
    }
    if (since) {
      messageWhere.push('COALESCE(s.last_message_at, s.started_at, s.updated_at) >= ?')
      messageParams.push(since)
    }

    const searchFts = (sql, params) => {
      try {
        return all(sql, ...params)
      } catch {
        return []
      }
    }

    if (!kind || kind === 'memory') {
      const rows = searchFts(
        `SELECT m.id, m.content, m.kind, m.scope, m.agent_type, bm25(memories_fts) AS score
           FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
          WHERE memories_fts MATCH ? AND ${memoryWhere.join(' AND ')}
          ORDER BY score LIMIT ?`,
        [expr, ...memoryParams, limit]
      )
      for (const row of rows) {
        hits.push({
          kind: 'memory',
          score: row.score ?? 0,
          memoryId: row.id,
          line: `[memory·${row.scope === 'project' ? '项目' : '全局'}/${row.agent_type ?? '全局'}] [${row.kind}]\n   ${clip(
            row.content,
            160
          )}`
        })
      }
    }
    if (!kind || kind === 'session') {
      const rows = searchFts(
        `SELECT s.id, s.title, s.summary, s.agent_type, bm25(sessions_fts) AS score
           FROM sessions_fts JOIN sessions s ON s.id = sessions_fts.rowid
          WHERE sessions_fts MATCH ? AND ${sessionWhere.join(' AND ')}
          ORDER BY score LIMIT ?`,
        [expr, ...sessionParams, limit]
      )
      for (const row of rows) {
        const first = row.summary ? clip(String(row.summary).split('\n')[0] ?? '', 120) : ''
        hits.push({
          kind: 'session',
          score: row.score ?? 0,
          line: `[session 会话#${row.id}/${row.agent_type}] ${row.title ?? '(无标题)'}${
            first ? ` — ${first}` : ''
          }`
        })
      }
    }
    if (!kind || kind === 'message') {
      const rows = searchFts(
        `SELECT m.id, m.session_id, m.content, s.title, s.agent_type, bm25(messages_fts) AS score
           FROM messages_fts JOIN session_messages m ON m.id = messages_fts.rowid
           JOIN sessions s ON s.id = m.session_id
          WHERE messages_fts MATCH ? AND ${messageWhere.join(' AND ')}
          ORDER BY score LIMIT ?`,
        [expr, ...messageParams, limit]
      )
      for (const row of rows) {
        hits.push({
          kind: 'message',
          score: row.score ?? 0,
          line: `[message 会话#${row.session_id}/${row.agent_type}] ${row.title ?? '(无标题)'}\n   ${clip(
            row.content,
            200
          )}`
        })
      }
    }

    // trigram 对 <3 字符查询没有命中（中文两字词很常见）→ LIKE 兜底
    if (hits.length === 0) {
      const like = `%${escapeLike(query)}%`
      if (!kind || kind === 'memory') {
        const rows = all(
          `SELECT id, content, kind, scope, agent_type FROM memories
            WHERE deleted = 0 AND status IN ('active','candidate') AND content LIKE ? ESCAPE '\\'
              ${agent ? "AND (kind = 'persona' OR agent_type IS NULL OR agent_type = ?)" : ''}
              ${projectIds ? `AND (scope = 'global' OR project_id IN (${projectIds.map(() => '?').join(',')}))` : ''}
              ${since ? 'AND updated_at >= ?' : ''}
            ORDER BY updated_at DESC LIMIT ?`,
          like,
          ...(agent ? [agent] : []),
          ...(projectIds ?? []),
          ...(since ? [since * 1000] : []),
          limit
        )
        for (const row of rows) {
          hits.push({
            kind: 'memory',
            score: 0,
            memoryId: row.id,
            line: `[memory·${row.scope === 'project' ? '项目' : '全局'}/${row.agent_type ?? '全局'}] [${
              row.kind
            }]\n   ${clip(row.content, 160)}`
          })
        }
      }
      if (!kind || kind === 'session') {
        const rows = all(
          `SELECT s.id, s.title, s.summary, s.agent_type FROM sessions s
            WHERE s.deleted = 0 AND (s.title LIKE ? ESCAPE '\\' OR s.summary LIKE ? ESCAPE '\\')
              ${agent ? 'AND s.agent_type = ?' : ''}
              ${projectIds ? `AND s.project_id IN (${projectIds.map(() => '?').join(',')})` : ''}
              ${since ? 'AND COALESCE(s.last_message_at, s.started_at, s.updated_at) >= ?' : ''}
            ORDER BY COALESCE(s.last_message_at, s.started_at, s.updated_at) DESC LIMIT ?`,
          like,
          like,
          ...(agent ? [agent] : []),
          ...(projectIds ?? []),
          ...(since ? [since] : []),
          limit
        )
        for (const row of rows) {
          const first = row.summary ? clip(String(row.summary).split('\n')[0] ?? '', 120) : ''
          hits.push({
            kind: 'session',
            score: 0,
            line: `[session 会话#${row.id}/${row.agent_type}] ${row.title ?? '(无标题)'}${
              first ? ` — ${first}` : ''
            }`
          })
        }
      }
      if (!kind || kind === 'message') {
        const rows = all(
          `SELECT m.session_id, m.content, s.title, s.agent_type FROM session_messages m
             JOIN sessions s ON s.id = m.session_id
            WHERE s.deleted = 0 AND m.content LIKE ? ESCAPE '\\'
              ${agent ? 'AND s.agent_type = ?' : ''}
              ${projectIds ? `AND s.project_id IN (${projectIds.map(() => '?').join(',')})` : ''}
              ${since ? 'AND COALESCE(s.last_message_at, s.started_at, s.updated_at) >= ?' : ''}
            ORDER BY m.id DESC LIMIT ?`,
          like,
          ...(agent ? [agent] : []),
          ...(projectIds ?? []),
          ...(since ? [since] : []),
          limit
        )
        for (const row of rows) {
          hits.push({
            kind: 'message',
            score: 0,
            line: `[message 会话#${row.session_id}/${row.agent_type}] ${row.title ?? '(无标题)'}\n   ${clip(
              row.content,
              200
            )}`
          })
        }
      }
    }

    if (hits.length === 0) return `未找到与"${query}"相关的记录。`
    hits.sort((a, b) => a.score - b.score)
    const top = hits.slice(0, limit)
    touchMemories(top.filter((h) => h.memoryId).map((h) => h.memoryId))
    return top.map((h, i) => `${i + 1}. ${h.line}`).join('\n')
  }

  function write(args = {}) {
    const kind = String(args.kind ?? 'fact')
    const content = String(args.content ?? '').trim()
    if (!VALID_KINDS.has(kind)) return '写入失败:kind 必须是 fact/preference/persona/decision'
    if (!content) return '写入失败:content 不能为空'
    const dup = get('SELECT id FROM memories WHERE content = ? AND deleted = 0 LIMIT 1', content)
    if (dup) return `已存在相同内容的记忆 #${dup.id},未重复写入。如需补充请合并进那条记忆。`
    const agent = typeof args.agent === 'string' && args.agent.trim() ? args.agent.trim() : undefined
    const hasProjectArg = Boolean(args.project || args.cwd)
    const project = hasProjectArg ? findProjectStrict({ project: args.project, cwd: args.cwd }) : null
    const scopeArg = args.scope === 'project' || args.scope === 'global' ? args.scope : undefined
    const scope = scopeArg ?? (project ? 'project' : 'global')
    if (scope === 'project' && !project) {
      return `写入失败:未找到项目「${args.project ?? args.cwd ?? ''}」,无法写入项目记忆(可先不带 project 写成全局记忆)`
    }
    const tags = (Array.isArray(args.tags) ? args.tags : [])
      .map((t) => String(t).trim())
      .filter(Boolean)
      .slice(0, 10)
    const now = Date.now()
    const id = Number(
      run(
        `INSERT INTO memories (kind, content, source, agent_type, status, scope, project_id, tags,
                               locked, created_at, updated_at, deleted)
         VALUES (?, ?, 'agent:mcp', ?, 'active', ?, ?, ?, 0, ?, ?, 0)`,
        kind,
        content,
        agent ?? null,
        scope,
        scope === 'project' ? project?.id ?? null : null,
        tags.length ? JSON.stringify(tags) : null,
        now,
        now
      ).lastInsertRowid
    )
    const bits = [`kind=${kind}`, `scope=${scope}`]
    if (agent) bits.push(`agent=${agent}`)
    if (project) bits.push(`project=${project.name}`)
    if (tags.length) bits.push(`tags=${tags.join(',')}`)
    return `已写入记忆 #${id} (${bits.join(', ')})`
  }

  function logProgress(args = {}) {
    const projectName = String(args.project ?? '').trim()
    const done = String(args.done ?? '').trim()
    if (!projectName) return '写入失败:project 不能为空'
    if (!done) return '写入失败:done 不能为空'
    const next = String(args.next ?? '').trim()
    const issues = String(args.issues ?? '').trim()
    const agent = typeof args.agent === 'string' && args.agent.trim() ? args.agent.trim() : undefined
    const matched = findProjectStrict({ project: projectName, cwd: args.cwd })
    const lines = [`[进度] 项目「${projectName}」`, `- 完成: ${done}`]
    if (next) lines.push(`- 下一步: ${next}`)
    if (issues) lines.push(`- 问题: ${issues}`)
    const now = Date.now()
    const id = Number(
      run(
        `INSERT INTO memories (kind, content, source, agent_type, status, scope, project_id,
                               locked, created_at, updated_at, deleted)
         VALUES ('fact', ?, 'agent:mcp:log_progress', ?, 'candidate', ?, ?, 0, ?, ?, 0)`,
        lines.join('\n'),
        agent ?? null,
        matched ? 'project' : 'global',
        matched?.id ?? null,
        now,
        now
      ).lastInsertRowid
    )
    const bits = [`#${id}`]
    if (matched) bits.push(`关联项目 ${matched.name}`)
    else bits.push('项目未匹配,未关联')
    return `已记录收工进度(${bits.join(', ')})。该条为候选记忆:会出现在交接简报的「待确认进度」并作为项目总结素材。`
  }

  function stats() {
    const count = (sql) => Number(get(sql)?.n ?? 0)
    let dbBytes = null
    if (!inMemory) {
      try {
        dbBytes = fs.statSync(file).size
      } catch {
        /* not written yet */
      }
    }
    return JSON.stringify(
      {
        sessions: count('SELECT count(*) AS n FROM sessions WHERE deleted = 0'),
        subagentSessions: 0,
        messages: count('SELECT count(*) AS n FROM session_messages'),
        projects: count('SELECT count(*) AS n FROM projects WHERE deleted = 0'),
        memories: count('SELECT count(*) AS n FROM memories WHERE deleted = 0'),
        activeMemories: count("SELECT count(*) AS n FROM memories WHERE deleted = 0 AND status = 'active'"),
        lastSessionAt:
          get(
            'SELECT MAX(COALESCE(last_message_at, started_at, ended_at)) AS ts FROM sessions WHERE deleted = 0'
          )?.ts ?? null,
        dbBytes
      },
      null,
      2
    )
  }

  function sameMessage(stored, incoming) {
    return (
      stored.role === incoming.role &&
      stored.content === incoming.content &&
      (stored.ts ?? null) === (incoming.ts ?? null) &&
      (stored.tool_name ?? null) === (incoming.toolName ?? null)
    )
  }

  function syncMessages(sessionId, messages) {
    const stored = all(
      'SELECT id, role, content, ts, tool_name FROM session_messages WHERE session_id = ? ORDER BY seq',
      sessionId
    )
    let keep = 0
    while (keep < stored.length && keep < messages.length && sameMessage(stored[keep], messages[keep])) {
      keep += 1
    }
    if (keep === stored.length && keep === messages.length) return
    if (keep < stored.length) {
      run('DELETE FROM session_messages WHERE session_id = ? AND seq >= ?', sessionId, keep)
    }
    for (let seq = keep; seq < messages.length; seq += 1) {
      const m = messages[seq]
      run(
        'INSERT INTO session_messages (session_id, seq, role, content, ts, tool_name) VALUES (?, ?, ?, ?, ?, ?)',
        sessionId,
        seq,
        m.role,
        m.content,
        m.ts ?? null,
        m.toolName ?? null
      )
    }
  }

  function importSession(args = {}) {
    const agent = String(args.agent ?? '').trim()
    const externalId = String(args.externalId ?? '').trim()
    if (!agent) return '导入失败:agent 不能为空'
    if (!externalId) return '导入失败:externalId 不能为空'
    const incoming = Array.isArray(args.messages) ? args.messages : []
    if (incoming.length === 0) return '导入失败:messages 不能为空'
    if (incoming.length > MAX_CAPTURE_MESSAGES) {
      return `导入失败:单次最多 ${MAX_CAPTURE_MESSAGES} 条消息(请分页/只传尾部)`
    }
    const roles = new Set(['user', 'assistant', 'tool', 'system'])
    const messages = []
    for (let i = 0; i < incoming.length; i += 1) {
      const m = incoming[i] && typeof incoming[i] === 'object' ? incoming[i] : {}
      const role = String(m.role ?? '')
      const content = typeof m.content === 'string' ? m.content : ''
      if (!roles.has(role)) return `导入失败:messages[${i}].role 必须是 user/assistant/tool/system`
      if (!content) continue
      const msg = { role, content }
      const ts = Number(m.ts)
      if (Number.isFinite(ts) && ts > 0) msg.ts = Math.floor(ts)
      if (typeof m.toolName === 'string' && m.toolName) msg.toolName = m.toolName
      messages.push(msg)
    }
    if (messages.length === 0) return '导入失败:没有有效消息'

    const existing = get(
      'SELECT id, message_count, raw_path, cwd, project_id FROM sessions WHERE agent_type = ? AND external_id = ?',
      agent,
      externalId
    )
    if (existing && existing.message_count > messages.length) {
      const gatewayOwned = String(existing.raw_path ?? '').startsWith('magpie-gateway:')
      if (!gatewayOwned) {
        return `已存在更完整的会话 #${existing.id}(${existing.message_count} 条,来自源文件),跳过网关回写。`
      }
      if (args.replace !== true) {
        return `跳过:本次 ${messages.length} 条,少于已存的 ${existing.message_count} 条(网关回写默认不截短历史;确需替换传 replace=true)。`
      }
    }

    const titleArg = typeof args.title === 'string' ? args.title.trim() : ''
    const firstUser = messages.find((m) => m.role === 'user')?.content ?? ''
    const title = titleArg || firstLine(firstUser) || externalId
    const startedAt = Number(args.startedAt)
    const endedAt = Number(args.endedAt)
    const cwdArg = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : undefined
    const matchedCwd = cwdArg ? projectsByCwd(cwdArg) : []
    const cwd = matchedCwd[0]?.path ?? cwdArg
    const projectId = ensureProject(cwd)
    let lastMessageAt = null
    for (const m of messages) {
      if (m.ts && (lastMessageAt == null || m.ts > lastMessageAt)) lastMessageAt = m.ts
    }
    if (lastMessageAt == null && Number.isFinite(endedAt) && endedAt > 0) lastMessageAt = Math.floor(endedAt)
    const toolCalls = messages.filter((m) => m.role === 'tool').length
    const now = Date.now()
    const rawPath = `magpie-gateway:${agent}`

    const outcome = db.tx(() => {
      let sessionId
      if (existing) {
        sessionId = existing.id
        run(
          `UPDATE sessions SET project_id = COALESCE(?, project_id), cwd = COALESCE(?, cwd),
             started_at = COALESCE(?, started_at), ended_at = COALESCE(?, ended_at),
             last_message_at = COALESCE(?, last_message_at), title = ?, raw_path = ?,
             message_count = ?, tool_call_count = ?, updated_at = ?, deleted = 0
           WHERE id = ?`,
          projectId,
          cwd ?? null,
          Number.isFinite(startedAt) && startedAt > 0 ? Math.floor(startedAt) : null,
          Number.isFinite(endedAt) && endedAt > 0 ? Math.floor(endedAt) : null,
          lastMessageAt,
          title,
          rawPath,
          messages.length,
          toolCalls,
          now,
          sessionId
        )
        syncMessages(sessionId, messages)
        return 'updated'
      }
      sessionId = Number(
        run(
          `INSERT INTO sessions (agent_type, external_id, project_id, cwd, started_at, ended_at,
             last_message_at, title, summary, raw_path, message_count, tool_call_count, updated_at, deleted)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, 0)`,
          agent,
          externalId,
          projectId,
          cwd ?? null,
          Number.isFinite(startedAt) && startedAt > 0 ? Math.floor(startedAt) : null,
          Number.isFinite(endedAt) && endedAt > 0 ? Math.floor(endedAt) : null,
          lastMessageAt,
          title,
          rawPath,
          messages.length,
          toolCalls,
          now
        ).lastInsertRowid
      )
      for (let seq = 0; seq < messages.length; seq += 1) {
        const m = messages[seq]
        run(
          'INSERT INTO session_messages (session_id, seq, role, content, ts, tool_name) VALUES (?, ?, ?, ?, ?, ?)',
          sessionId,
          seq,
          m.role,
          m.content,
          m.ts ?? null,
          m.toolName ?? null
        )
      }
      return 'imported'
    })
    const row = get('SELECT id FROM sessions WHERE agent_type = ? AND external_id = ?', agent, externalId)
    return JSON.stringify({ id: row?.id ?? null, outcome, messages: messages.length })
  }

  const handlers = {
    memory_get_context: context,
    memory_get_project_brief: brief,
    memory_get_project_digest: digest,
    memory_list_projects: listProjects,
    memory_list_sessions: listSessions,
    memory_get_session: getSession,
    memory_search: search,
    memory_write: write,
    memory_log_progress: logProgress,
    memory_stats: stats,
    memory_import_session: importSession
  }

  return {
    kind: 'embedded',
    dataDir,
    file,
    async call(name, args = {}) {
      const handler = handlers[name]
      if (!handler) throw new Error(`内置存储不支持工具 ${name}`)
      return handler(args)
    },
    async status() {
      let statsValue = null
      try {
        statsValue = JSON.parse(stats())
      } catch {
        /* ignore */
      }
      return {
        ok: true,
        backend: 'embedded',
        version: '0.2.0',
        port: null,
        tools: Object.keys(handlers).length,
        stats: statsValue
      }
    },
    close() {
      db.close()
    }
  }
}
