export interface DevlogSession {
  id: number
  agent_type: string
  title: string | null
  summary: string | null
  started_at: number | null
  message_count: number
}

export interface DevlogMemory {
  kind: string
  content: string
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

function firstLine(text: string | null): string {
  return (text ?? '').split('\n').find((l) => l.trim().length > 0)?.trim() ?? ''
}

function fmtDay(tsSec: number | null): string {
  if (!tsSec) return '未知日期'
  const d = new Date(tsSec * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function fmtShort(tsSec: number | null): string {
  if (!tsSec) return '?'
  const d = new Date(tsSec * 1000)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

/**
 * Rule-based project devlog, assembled from captured sessions and knowledge-
 * base memories (iron rule 3: local rules first, LLM refinement comes later).
 * The file is fully regenerated on each run — the marker comment warns about
 * that, and hand-written notes belong in separate files.
 */
export function buildDevlogMd(input: {
  project: { name: string; path: string | null; tech_stack: string | null }
  sessions: DevlogSession[]
  activeMemories: DevlogMemory[]
  pendingProgress: DevlogMemory[]
  generatedAt: Date
}): string {
  const { project, sessions, activeMemories, pendingProgress, generatedAt } = input
  const parts: string[] = [
    '<!-- memorysql:auto-devlog v1 — 由 MemorySQL 自动生成,每次重新生成会整文件覆盖;手写内容请另建文件 -->',
    `# ${project.name} 开发日志`,
    '',
    `> 生成于 ${generatedAt.toLocaleString('zh-CN', { hour12: false })} · 依据 ${sessions.length} 个会话与知识库记忆自动汇编`,
    ''
  ]

  parts.push('## 概览', '')
  const byAgent = new Map<string, number>()
  for (const s of sessions) byAgent.set(s.agent_type, (byAgent.get(s.agent_type) ?? 0) + 1)
  const agentCounts = [...byAgent.entries()].map(([a, n]) => `${a} ${n}`).join(' · ')
  parts.push(`- 会话: ${sessions.length} 个${agentCounts ? `(${agentCounts})` : ''}`)
  if (sessions.length > 0) {
    const times = sessions.map((s) => s.started_at).filter((t): t is number => typeof t === 'number')
    if (times.length > 0) {
      parts.push(`- 时间跨度: ${fmtShort(Math.min(...times))} ~ ${fmtShort(Math.max(...times))}`)
    }
  }
  if (project.tech_stack) parts.push(`- 技术栈: ${project.tech_stack}`)
  if (project.path) parts.push(`- 路径: ${project.path}`)
  parts.push('')

  parts.push('## 时间线', '')
  if (sessions.length > 0) {
    const sorted = [...sessions].sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0))
    const byDay = new Map<string, DevlogSession[]>()
    for (const s of sorted) {
      const day = fmtDay(s.started_at)
      const bucket = byDay.get(day)
      if (bucket) bucket.push(s)
      else byDay.set(day, [s])
    }
    for (const [day, list] of byDay) {
      parts.push(`### ${day}`, '')
      // within a day the log reads chronologically: morning -> evening
      for (const s of [...list].reverse()) {
        const line = firstLine(s.summary)
        parts.push(
          `- [#${s.id} ${s.agent_type}] ${s.title ?? '(无标题)'}${line ? ` — ${clip(line, 120)}` : ''} (${s.message_count} 条消息)`
        )
      }
      parts.push('')
    }
  } else {
    parts.push('(暂无会话记录)', '')
  }

  parts.push('## 决策与结论(活跃记忆)', '')
  if (activeMemories.length > 0) {
    for (const m of activeMemories) parts.push(`- [${m.kind}] ${clip(m.content, 200)}`)
  } else {
    parts.push('(暂无)')
  }
  parts.push('')

  parts.push('## 未竟与待办(待确认进度)', '')
  if (pendingProgress.length > 0) {
    for (const m of pendingProgress) parts.push(`- ${clip(m.content, 200)}`)
  } else {
    parts.push('(暂无 — agent 收工时用 memory_log_progress 汇报,确认后出现在这里)')
  }
  parts.push('')

  return parts.join('\n')
}
