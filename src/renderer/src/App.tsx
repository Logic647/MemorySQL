import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { Brain, FileText, Settings2, Share2, History } from 'lucide-react'
import appIcon from './assets/icon.png'
import type { SearchHit, SessionSummaryRow } from '../../shared/types'
import { api, type Overview, type SessionDetail } from './api'
import MemoriesView from './MemoriesView'
import SettingsView from './SettingsView'
import NotesView from './NotesView'
import GraphView from './GraphView'

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
  const [filter, setFilter] = useState<string>('all')
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
  const [enabledCaptures, setEnabledCaptures] = useState<Record<string, boolean>>({})
  const [showArchived, setShowArchived] = useState(false)
  const [rename, setRename] = useState<{ id: number; value: string } | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [expandedChains, setExpandedChains] = useState<Set<number>>(new Set())
  const [draggingId, setDraggingId] = useState<number | null>(null)
  const [dropLine, setDropLine] = useState<{ afterId: number; below: boolean } | null>(null)

  const [relayPick, setRelayPick] = useState<{ id: number; project: string } | null>(null)

  const refresh = useCallback(async () => {
    setSessions(await api.listSessions(filter, { archived: showArchived }))
    setOverview(await api.overview())
    try {
      const hp = await api.hostPlugins()
      const map: Record<string, boolean> = {}
      for (const p of hp.plugins) if (p.id.startsWith('capture-')) map[p.id] = p.enabled
      setEnabledCaptures(map)
    } catch {
      /* host channels unavailable — assume all enabled */
    }
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

  // stable per-project hue so adjacent projects are visually distinct
  const projectHue = (name: string): number => {
    let h = 0
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360
    return h
  }

  const sessionRow = (
    s: SessionSummaryRow,
    depth = 0,
    listCtx?: { ordered: SessionSummaryRow[]; projectId: number | null; stagger?: number },
    draggingId?: number | null,
    dropLine?: { afterId: number; below: boolean } | null
  ): ReactNode => {
    const selectedRow = selected?.session.id === s.id
    const isDragging = draggingId === s.id
    const dropHere = dropLine?.afterId === s.id
    return (
      <div
        key={s.id}
        className={`session ${selectedRow ? 'selected' : ''} ${
          dropHere ? (dropLine?.below ? 'drop-below' : 'drop-above') : ''
        } ${isDragging ? 'dragging' : ''}`}
        data-agent={s.agentType}
        data-id={s.id}
        data-dragging={isDragging ? '1' : '0'}
        draggable
        style={
          {
            marginLeft: depth > 0 ? depth * 16 : undefined,
            '--i': String(Math.min(listCtx?.stagger ?? 0, 10))
          } as CSSProperties
        }
        onDragStart={(e) => {
          setDraggingId(s.id)
          e.dataTransfer.setData('text/session-id', String(s.id))
          e.dataTransfer.effectAllowed = 'move'
        }}
        onDragEnd={() => {
          setDraggingId(null)
          setDropLine(null)
        }}
        onDragOver={(e) => {
          if (!listCtx) return
          e.preventDefault()
          e.stopPropagation()
          const rect = e.currentTarget.getBoundingClientRect()
          const below = e.clientY - rect.top > rect.height / 2
          if (dropLine?.afterId !== s.id || dropLine?.below !== below) {
            setDropLine({ afterId: s.id, below })
          }
        }}
        onDragLeave={() => setDropLine(null)}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          const below = dropLine?.below ?? false
          setDropLine(null)
          setDraggingId(null)
          if (!listCtx) return
          const sid = Number(e.dataTransfer.getData('text/session-id'))
          if (!sid || sid === s.id) return
          const i = listCtx.ordered.findIndex((x) => x.id === s.id)
          const prevId = below ? s.id : i > 0 ? listCtx.ordered[i - 1].id : null
          const nextId = below ? listCtx.ordered[i + 1]?.id ?? null : s.id
          void api
            .moveSession(sid, { projectId: listCtx.projectId, prevId, nextId })
            .then(refresh)
            .catch((err) => setKbMsg(`移动失败: ${String(err)}`))
        }}
        onClick={() => void openSession(s.id)}
      >
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
              {s.similarTo != null && <span className="relay-tag">↩ #{s.similarTo}</span>}
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
            {s.similarTo != null ? (
              <button className="link" onClick={() => void api.setRelay(s.id, null).then(refresh)}>
                取消续接
              </button>
            ) : (
              <button
                className="link"
                onClick={() => setRelayPick({ id: s.id, project: s.project ?? '(未分配项目)' })}
              >
                设为续接
              </button>
            )}
            <button className="link" onClick={() => void api.archiveSession(s.id, s.archived !== 1).then(refresh)}>
              {s.archived === 1 ? '取消归档' : '归档'}
            </button>
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <div className="aurora" aria-hidden />
      <nav className="rail">
        <div className="rail-brand" title="MemorySQL">
          <img className="brand-icon" src={appIcon} alt="MemorySQL" />
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
          <img className="brand-icon" src={appIcon} alt="MemorySQL" /> MemorySQL
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
        {view === 'sessions' && (
        <aside className="sidebar">
            <>
          <div className="side-section">
            <div className="side-title">Agent</div>
            {['all', ...CAPTURE_PLUGINS.filter(({ id }) => enabledCaptures[id] !== false).map(({ id }) => id.replace('capture-', ''))].map((a) => {
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
                  {a === 'all' ? '全部' : a}
                  <span className="count">{count}</span>
                </button>
              )
            })}
          </div>

          <div className="side-section">
            <div className="side-title">捕获状态</div>
            {CAPTURE_PLUGINS.filter(({ id }) => enabledCaptures[id] !== false).map(({ id, label }) => (
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
                    (r) => {
                      setKbMsg(`已导出 ${(r.bytes / 1024 / 1024).toFixed(1)} MB,已打开备份文件夹`)
                      void api
                        .paths()
                        .then((pp) => api.openPath(pp.backupsDir))
                        .catch(() => {})
                    },
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
        </aside>
          )}

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
                  // group by project; a relay session always sits right after
                  // the session it continues (chain order, multi-hop safe)
                  const groups = new Map<string, SessionSummaryRow[]>()
                  for (const s of sessions) {
                    const key = s.project ?? '(未分配项目)'
                    const bucket = groups.get(key)
                    if (bucket) bucket.push(s)
                    else groups.set(key, [s])
                  }
                  const keys = [...groups.keys()].sort((x, y) => {
                    if (x === '(未分配项目)') return 1
                    if (y === '(未分配项目)') return -1
                    const lx = Math.max(...groups.get(x)!.map((r) => r.startedAt ?? 0))
                    const ly = Math.max(...groups.get(y)!.map((r) => r.startedAt ?? 0))
                    return ly - lx
                  })
                  return keys.flatMap((project) => {
                    const rows = groups.get(project)!
                    const byId = new Map(rows.map((r) => [r.id, r]))
                    const children = new Map<number, SessionSummaryRow[]>()
                    const origins: SessionSummaryRow[] = []
                    for (const r of rows) {
                      if (r.similarTo != null && byId.has(r.similarTo)) {
                        const arr = children.get(r.similarTo) ?? []
                        arr.push(r)
                        children.set(r.similarTo, arr)
                      } else origins.push(r)
                    }
                    const effKey = (r: SessionSummaryRow): number => r.sortKey ?? r.startedAt ?? 0
                    const byTime = (x: SessionSummaryRow, y: SessionSummaryRow): number =>
                      effKey(y) - effKey(x)
                    origins.sort(byTime)
                    for (const arr of children.values()) arr.sort(byTime)
                    const entries: Array<
                      | { kind: 'row'; r: SessionSummaryRow; depth: number }
                      | { kind: 'toggle'; r: SessionSummaryRow; depth: number; open: boolean; count: number }
                    > = []
                    const seen = new Set<number>()
                    const pushChain = (r: SessionSummaryRow, depth: number): void => {
                      if (seen.has(r.id)) return
                      seen.add(r.id)
                      entries.push({ kind: 'row', r, depth })
                      const kids = children.get(r.id) ?? []
                      const open = expandedChains.has(r.id)
                      if (kids.length > 0 && !open) {
                        entries.push({ kind: 'toggle', r, depth, open: false, count: kids.length })
                        const stack = [...kids]
                        while (stack.length) {
                          const c = stack.shift()!
                          seen.add(c.id)
                          for (const g of children.get(c.id) ?? []) stack.push(g)
                        }
                        return
                      }
                      if (kids.length > 0 && open) {
                        for (const c of kids) pushChain(c, depth + 1)
                        entries.push({ kind: 'toggle', r, depth, open: true, count: kids.length })
                        return
                      }
                    }
                    for (const r of [...origins].sort(byTime)) pushChain(r, 0)
                    rows.forEach((r) => {
                      if (!seen.has(r.id)) pushChain(r, 0)
                    })
                    const body: ReactNode[] = []
                    let staggerIdx = 0
                    for (const e of entries) {
                      if (e.kind === 'toggle') {
                        body.push(
                          <button
                            key={`${e.r.id}-fold`}
                            className="relay-fold chain"
                            style={{ marginLeft: 14 + e.depth * 16 }}
                            onClick={() =>
                              setExpandedChains((prev) => {
                                const next = new Set(prev)
                                if (e.open) next.delete(e.r.id)
                                else next.add(e.r.id)
                                return next
                              })
                            }
                          >
                            {e.open
                              ? '↑ 收起续接会话'
                              : `↩ ${e.count} 条续接会话 — 展开`}
                          </button>
                        )
                        continue
                      }
                      body.push(
                        sessionRow(
                          e.r,
                          e.depth,
                          {
                            ordered: entries.filter((x) => x.kind === 'row').map((x) => x.r),
                            projectId: rows[0]?.projectId ?? -1,
                            stagger: staggerIdx++
                          },
                          draggingId,
                          dropLine
                        )
                      )
                    }
                    return [
                      <div
                        key={`${project}-head`}
                        className={`group-head ${dropTarget === project ? 'drop-target' : ''}`}
                        style={
                          {
                            '--ph': String(projectHue(project)),
                            '--ps': project === '(未分配项目)' ? '14%' : '55%'
                          } as CSSProperties
                        }
                        onDragOver={(e) => {
                          e.preventDefault()
                          setDropTarget(project)
                        }}
                        onDragLeave={() => setDropTarget((prev) => (prev === project ? null : prev))}
                        onDrop={(e) => {
                          e.preventDefault()
                          setDropTarget(null)
                          const sid = Number(e.dataTransfer.getData('text/session-id'))
                          if (!sid) return
                          const clear = project === '(未分配项目)'
                          void api
                            .assignProject(sid, clear ? '' : project)
                            .then(() => refresh())
                            .catch((err) => setKbMsg(`移动失败: ${String(err)}`))
                        }}
                      >
                        {project}
                        <span className="group-count">{rows.length}</span>
                      </div>,
                      ...body,
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
        {relayPick && (
          <div className="modal-overlay" onClick={() => setRelayPick(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-title">把会话 #{relayPick.id} 设为哪条会话的续接?</div>
              <div className="modal-list">
                {sessions
                  .filter(
                    (r) =>
                      r.id !== relayPick.id && (r.project ?? '(未分配项目)') === relayPick.project
                  )
                  .map((r) => (
                    <button
                      key={r.id}
                      className="modal-item"
                      onClick={() => {
                        void api
                          .setRelay(relayPick.id, r.id)
                          .then(() => {
                            setRelayPick(null)
                            return refresh()
                          })
                          .catch((err) => setKbMsg(`设置失败: ${String(err)}`))
                      }}
                    >
                      <span className="sess-id">#{r.id}</span> {r.title ?? '(无标题)'}
                      <span className="session-time">{fmtTime(r.startedAt)}</span>
                    </button>
                  ))}
              </div>
              <button className="btn btn-small" onClick={() => setRelayPick(null)}>
                取消
              </button>
            </div>
          </div>
        )}

      </div>
    </div>
  )
}
