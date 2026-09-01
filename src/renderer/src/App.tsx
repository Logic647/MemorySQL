import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Brain, Diamond, FileText, Settings2, Share2, History } from 'lucide-react'
import type { AgentType, SearchHit, SessionSummaryRow } from '../../shared/types'
import { api, type Overview, type SessionDetail } from './api'
import MemoriesView from './MemoriesView'
import SettingsView from './SettingsView'
import NotesView from './NotesView'
import GraphView from './GraphView'

const AGENTS = ['all', 'codex', 'zcode', 'hermes'] as const
type AgentFilter = (typeof AGENTS)[number]
type View = 'sessions' | 'memories' | 'notes' | 'graph' | 'settings'
const VIEW_LABEL: Record<View, string> = {
  sessions: '会话',
  memories: '记忆',
  notes: '笔记',
  graph: '图谱',
  settings: '设置'
}

const VIEW_ICON: Record<View, typeof History> = {
  sessions: History,
  memories: Brain,
  notes: FileText,
  graph: Share2,
  settings: Settings2
}
const CAPTURE_PLUGINS: Array<{ id: string; label: string }> = [
  { id: 'capture-codex', label: 'Codex' },
  { id: 'capture-zcode', label: 'ZCode' },
  { id: 'capture-hermes', label: 'Hermes' }
]

function fmtTime(ts: number | null | undefined): string {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false })
}

function AgentBadge({ type }: { type: string }) {
  return <span className={`badge badge-${type}`}>{type}</span>
}

export default function App() {
  const [filter, setFilter] = useState<AgentFilter>('all')
  const [sessions, setSessions] = useState<SessionSummaryRow[]>([])
  const [selected, setSelected] = useState<SessionDetail | null>(null)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [overview, setOverview] = useState<Overview | null>(null)
  const [statuses, setStatuses] = useState<Record<string, string>>({})
  const [scanning, setScanning] = useState(false)
  const [devlogBusy, setDevlogBusy] = useState(false)
  const [devlogNote, setDevlogNote] = useState<string | null>(null)
  const [mcp, setMcp] = useState<{ port: number; running: boolean; toolCount: number } | null>(null)
  const [kbMsg, setKbMsg] = useState('')
  const [view, setView] = useState<View>('sessions')
  const [showArchived, setShowArchived] = useState(false)
  const [rename, setRename] = useState<{ id: number; value: string } | null>(null)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())

  const refresh = useCallback(async () => {
    setSessions(await api.listSessions(filter, { archived: showArchived }))
    setOverview(await api.overview())
  }, [filter, showArchived])

  useEffect(() => {
    void refresh()
    CAPTURE_PLUGINS.forEach(async ({ id }) => {
      try {
        const s = await api.captureStatus(id)
        const detail = s.lastError
          ? `错误: ${s.lastError}`
          : s.lastScanAt
            ? `${s.sessionsImported} 新导入 / ${s.sessionsFound} 扫描`
            : '本次运行未扫描(数据已在库)'
        setStatuses((prev) => ({ ...prev, [id]: detail }))
      } catch {
        setStatuses((prev) => ({ ...prev, [id]: '不可用' }))
      }
    })
    return api.onSessionsChanged(() => void refresh())
  }, [refresh])

  useEffect(() => {
    void api.mcpStatus().then(setMcp).catch(() => setMcp(null))
  }, [])

  const openSession = useCallback(async (id: number) => {
    setSelected(await api.getSession(id))
  }, [])

  // Ctrl+1..5 switch views (command-driven navigation)
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || e.shiftKey || e.altKey) return
      const views: View[] = ['sessions', 'memories', 'notes', 'graph', 'settings']
      const i = ['1', '2', '3', '4', '5'].indexOf(e.key)
      if (i >= 0) {
        e.preventDefault()
        setView(views[i])
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // spotlight result → open the session in the main window
  useEffect(() => {
    const off = window.memorysql.on('push:open-session', (...args: unknown[]) => {
      const id = Number(args[0])
      if (!id) return
      setView('sessions')
      void openSession(id)
    })
    return off
  }, [openSession])

  const runSearch = useCallback(async () => {
    if (!query.trim()) {
      setHits(null)
      return
    }
    setHits(await api.search(query))
  }, [query])

  const scanAll = useCallback(async () => {
    setScanning(true)
    try {
      for (const { id } of CAPTURE_PLUGINS) {
        await api.scanNow(id)
      }
      await refresh()
    } finally {
      setScanning(false)
    }
  }, [refresh])

  const devlog = useCallback(async () => {
    setDevlogBusy(true)
    try {
      const res = await api.generateDevlog()
      setDevlogNote(
        res.files.length > 0
          ? `已生成 ${res.files.length} 个项目日志 → vault/devlog/`
          : (res.message ?? '没有可生成的项目')
      )
      await refresh()
    } catch {
      setDevlogNote('生成失败')
    } finally {
      setDevlogBusy(false)
      setTimeout(() => setDevlogNote(null), 4000)
    }
  }, [refresh])

  const commitRename = useCallback(async () => {
    if (!rename) return
    try {
      await api.renameSession(rename.id, rename.value)
      setRename(null)
      await refresh()
      if (selected?.session.id === rename.id) setSelected(await api.getSession(rename.id))
    } catch (e) {
      setKbMsg(`重命名失败: ${String(e)}`)
    }
  }, [rename, refresh, selected])

  const sessionRow = (s: SessionSummaryRow) => (
    <div key={s.id} className="session" data-agent={s.agentType} onClick={() => void openSession(s.id)}>
      <div className="session-head">
        <AgentBadge type={s.agentType} />
        {rename?.id === s.id ? (
          <span className="session-title" onClick={(e) => e.stopPropagation()}>
            <input
              autoFocus
              value={rename.value}
              onChange={(e) => setRename({ id: s.id, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commitRename()
                if (e.key === 'Escape') setRename(null)
              }}
            />
            <button className="btn btn-small" onClick={(e) => { e.stopPropagation(); void commitRename() }}>
              保存
            </button>
            <button className="btn btn-small" onClick={(e) => { e.stopPropagation(); setRename(null) }}>
              取消
            </button>
          </span>
        ) : (
          <span className="session-title">
            {s.title ?? s.externalId}
            {s.titleLocked ? ' 🖊' : ''}
          </span>
        )}
        <span className="sess-id">#{s.id}</span>
        <span className="session-time">{fmtTime(s.startedAt)}</span>
      </div>
      {s.summary && <div className="session-summary">{s.summary.split('\n')[0]}</div>}
      <div className="session-meta">
        {s.project && <span>{s.project}</span>}
        {s.similarTo != null && <span className="relay-tag">↩ 续 #{s.similarTo}</span>}
        <span>{s.messageCount} msg</span>
        <span>{s.toolCallCount} tool</span>
        <span className="mem-actions" onClick={(e) => e.stopPropagation()}>
          <button className="link" onClick={() => setRename({ id: s.id, value: s.title ?? '' })}>
            重命名
          </button>
          <button className="link" onClick={() => void api.archiveSession(s.id, s.archived !== 1).then(refresh)}>
            {s.archived === 1 ? '取消归档' : '归档'}
          </button>
        </span>
      </div>
    </div>
  )

  return (
    <div className="app">
      <div className="aurora" aria-hidden />
      <nav className="rail">
        <div className="rail-brand" title="MemorySQL">
          <Diamond size={17} strokeWidth={2.4} />
        </div>
        <div className="rail-nav">
          {(['sessions', 'memories', 'notes', 'graph'] as View[]).map((v) => {
            const Icon = VIEW_ICON[v]
            return (
              <button key={v} className={`rail-btn ${view === v ? 'active' : ''}`} title={VIEW_LABEL[v]} onClick={() => setView(v)}>
                <Icon size={18} strokeWidth={1.8} />
              </button>
            )
          })}
        </div>
        <div className="rail-bottom">
          <button
            className={`rail-btn ${view === 'settings' ? 'active' : ''}`}
            title={VIEW_LABEL.settings}
            onClick={() => setView('settings')}
          >
            <Settings2 size={18} strokeWidth={1.8} />
          </button>
        </div>
      </nav>
      <div className="app-main">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">◆</span> MemorySQL
        </div>
        <input
          className="search"
          placeholder="全文搜索会话与消息 (Enter 搜索)…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void runSearch()
            if (e.key === 'Escape') {
              setQuery('')
              setHits(null)
            }
          }}
        />
        <button className="btn" onClick={() => void runSearch()}>
          搜索
        </button>
        {hits && (
          <button
            className="btn btn-ghost"
            onClick={() => {
              setHits(null)
              setQuery('')
            }}
          >
            清除
          </button>
        )}
        <button className="btn btn-accent" disabled={scanning} onClick={() => void scanAll()}>
          {scanning ? '扫描中…' : '立即扫描'}
        </button>
        <button className="btn" disabled={devlogBusy} onClick={() => void devlog()}>
          {devlogBusy ? '生成中…' : '生成项目日志'}
        </button>
        {devlogNote && <span className="devlog-note">{devlogNote}</span>}
      </header>

      <div className="body">
        <aside className="sidebar">
          {view === 'sessions' && (
            <>
          <div className="side-section">
            <div className="side-title">Agent</div>
            {AGENTS.map((a) => {
              const stat = overview?.byAgent.find((x) => x.agent_type === a)
              const count = a === 'all'
                ? overview?.byAgent.reduce((n, x) => n + x.sessions, 0) ?? 0
                : stat?.sessions ?? 0
              return (
                <button
                  key={a}
                  className={`side-item ${filter === a ? 'active' : ''}`}
                  onClick={() => setFilter(a)}
                >
                  {a === 'all' ? '全部' : <AgentBadge type={a} />}
                  <span className="count">{count}</span>
                </button>
              )
            })}
          </div>

          <div className="side-section">
            <div className="side-title">捕获状态</div>
            {CAPTURE_PLUGINS.map(({ id, label }) => (
              <div key={id} className="capture-status">
                <span className={`dot ${statuses[id]?.startsWith('错误') ? 'err' : 'ok'}`} />
                <div>
                  <div className="capture-name">{label}</div>
                  <div className="capture-detail">{statuses[id] ?? '…'}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="side-section">
            <div className="side-title">知识库</div>
            <div className="kb-stat">记忆条目: {overview?.memories ?? 0}</div>
            <div className="kb-actions">
              <button
                className="btn btn-small"
                onClick={() => {
                  void api.exportArchive().then(
                    (r) => setKbMsg(`已导出 ${(r.bytes / 1024 / 1024).toFixed(1)} MB`),
                    (e) => setKbMsg(`导出失败: ${String(e)}`)
                  )
                }}
              >
                导出备份
              </button>
              <button
                className="btn btn-small"
                onClick={() => {
                  void api.importArchive().then(
                    (r) => {
                      if (!r.relaunched) setKbMsg('导入已取消')
                    },
                    (e) => setKbMsg(`导入失败: ${String(e)}`)
                  )
                }}
              >
                导入备份
              </button>
            </div>
            {kbMsg && <div className="kb-stat kb-msg">{kbMsg}</div>}
            <div className="kb-stat">
              MCP: {mcp ? (mcp.running ? `127.0.0.1:${mcp.port} · ${mcp.toolCount} 工具` : '未运行') : '—'}
            </div>
          </div>
            </>
          )}
        </aside>

        {view === 'memories' ? (
          <MemoriesView />
        ) : view === 'notes' ? (
          <NotesView />
        ) : view === 'graph' ? (
          <GraphView />
        ) : view === 'settings' ? (
          <SettingsView />
        ) : (
        <main className="main">
          {hits ? (
            <div className="list-pane">
              <div className="pane-title">搜索结果 ({hits.length})</div>
              <div className="session-list">
                {hits.map((h) => (
                  <button
                    key={`${h.kind}-${h.id}`}
                    className="hit"
                    data-agent={h.agentType ?? undefined}
                    onClick={() => h.sessionId && void openSession(h.sessionId)}
                  >
                    <div className="hit-head">
                      <AgentBadge type={h.agentType ?? '?'} />
                      <span className="hit-kind">
                        {({ session: '会话', message: '消息', memory: '记忆', note: '笔记' } as const)[h.kind]}
                      </span>
                      <span className="hit-title">{h.title ?? ''}</span>
                    </div>
                    <div className="hit-snippet">{h.snippet}</div>
                  </button>
                ))}
                {hits.length === 0 && <div className="empty">无匹配结果</div>}
              </div>
            </div>
          ) : (
            <div className="list-pane">
              <div className="pane-title">
                会话 ({sessions.length})
                <label className="hint" style={{ marginLeft: 10, display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    checked={showArchived}
                    onChange={(e) => setShowArchived(e.target.checked)}
                  />
                  显示已归档
                </label>
              </div>
              <div className="session-list">
                {(() => {
                  // group: all→project (multi-agent projects get agent sub-heads);
                  // agent filter→project. Sessions without a project land in (未分配).
                  const groups = new Map<string, SessionSummaryRow[]>()
                  for (const s of sessions) {
                    const key = s.project ?? '(未分配项目)'
                    const bucket = groups.get(key)
                    if (bucket) bucket.push(s)
                    else groups.set(key, [s])
                  }
                  const latest = (k: string): number =>
                    Math.max(...groups.get(k)!.map((r) => r.startedAt ?? 0))
                  const keys = [...groups.keys()].sort((a, b) => {
                    if (a === '(未分配项目)') return 1
                    if (b === '(未分配项目)') return -1
                    return latest(b) - latest(a)
                  })
                  return keys.flatMap((project) => {
                    const rows = groups.get(project)!
                    const ids = new Set(rows.map((r) => r.id))
                    const primary = rows.filter((r) => !(r.similarTo != null && ids.has(r.similarTo)))
                    const relay = rows.filter((r) => r.similarTo != null && ids.has(r.similarTo))
                    const agents = [...new Set(primary.map((r) => r.agentType))]
                    const body: ReactNode[] = []
                    if (filter === 'all' && agents.length > 1) {
                      for (const a of agents.sort()) {
                        body.push(
                          <div key={`${project}-${a}-head`} className="group-subhead">
                            <AgentBadge type={a as AgentType} />
                            <span>{a}</span>
                          </div>
                        )
                        for (const s of primary.filter((r) => r.agentType === a)) body.push(sessionRow(s))
                      }
                    } else {
                      for (const s of primary) body.push(sessionRow(s))
                    }
                    if (relay.length > 0) {
                      if (expandedGroups.has(project)) {
                        body.push(...relay.map((r) => sessionRow(r)))
                        body.push(
                          <button
                            key={`${project}-relay-fold`}
                            className="relay-fold"
                            onClick={() =>
                              setExpandedGroups((prev) => {
                                const next = new Set(prev)
                                next.delete(project)
                                return next
                              })
                            }
                          >
                            收起接力会话
                          </button>
                        )
                      } else {
                        body.push(
                          <button
                            key={`${project}-relay`}
                            className="relay-fold"
                            onClick={() => setExpandedGroups((prev) => new Set(prev).add(project))}
                          >
                            ↩ {relay.length} 条接力会话(与组内高相似,点击展开)
                          </button>
                        )
                      }
                    }
                    return [
                      <div key={`${project}-head`} className="group-head">
                        {project}
                        <span className="group-count">{rows.length}</span>
                      </div>,
                      ...body
                    ]
                  })
                })()}
                {sessions.length === 0 && (
                  <div className="empty">暂无会话 — 点击右上角「立即扫描」导入 agent 会话</div>
                )}
              </div>
            </div>
          )}

          <div className="detail-pane">
            {selected ? (
              <>
                <div className="detail-head">
                  <div className="detail-title">
                    <AgentBadge type={selected.session.agent_type} />
                    {selected.session.title ?? selected.session.external_id}
                    <span className="tape-id">{selected.session.external_id}</span>
                  </div>
                  <div className="detail-meta">
                    <button
                      className="sess-id copyable"
                      title="复制会话 id(agent 可用 memory_get_session 读取)"
                      onClick={() => void navigator.clipboard.writeText(String(selected.session.id)).then(() => setKbMsg(`已复制会话 id: ${selected.session.id}`))}
                    >
                      #{selected.session.id} ⧉
                    </button>
                    {selected.session.project && <span>项目: {selected.session.project}</span>}
                    <span>开始: {fmtTime(selected.session.started_at)}</span>
                    <span>消息: {selected.messages.length}</span>
                    <button
                      className="btn btn-small"
                      onClick={() =>
                        void api.exportSession(selected.session.id).then((r) => {
                          if (r.saved) setKbMsg(`已导出(脱敏 ${r.redactions ?? 0} 处): ${r.filePath}`)
                        })
                      }
                    >
                      导出 MD(脱敏)
                    </button>
                  </div>
                  {selected.session.summary && (
                    <pre className="detail-summary">{selected.session.summary}</pre>
                  )}
                </div>
                <div className="messages">
                  {selected.messages.map((m) => (
                    <div key={m.id} className={`msg msg-${m.role}`}>
                      <div className="msg-role">
                        {m.role === 'tool' ? `🔧 ${m.toolName ?? 'tool'}` : m.role}
                        {m.ts ? <span className="msg-ts"> · {fmtTime(m.ts)}</span> : null}
                      </div>
                      <pre className="msg-content">{m.content}</pre>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="empty detail-empty">左侧选择一个会话查看完整时间线</div>
            )}
          </div>
        </main>
        )}
      </div>
      </div>
    </div>
  )
}
