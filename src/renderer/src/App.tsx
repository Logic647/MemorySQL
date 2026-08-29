import { useCallback, useEffect, useState } from 'react'
import type { SearchHit, SessionSummaryRow } from '../../shared/types'
import { api, type Overview, type SessionDetail } from './api'

const AGENTS = ['all', 'codex', 'zcode', 'hermes'] as const
type AgentFilter = (typeof AGENTS)[number]
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

  const refresh = useCallback(async () => {
    setSessions(await api.listSessions(filter))
    setOverview(await api.overview())
  }, [filter])

  useEffect(() => {
    void refresh()
    CAPTURE_PLUGINS.forEach(async ({ id }) => {
      try {
        const s = await api.captureStatus(id)
        setStatuses((prev) => ({
          ...prev,
          [id]: s.lastError ? `错误: ${s.lastError}` : `${s.sessionsImported} 新导入 / ${s.sessionsFound} 扫描`
        }))
      } catch {
        setStatuses((prev) => ({ ...prev, [id]: '不可用' }))
      }
    })
    return api.onSessionsChanged(() => void refresh())
  }, [refresh])

  const openSession = useCallback(async (id: number) => {
    setSelected(await api.getSession(id))
  }, [])

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

  return (
    <div className="app">
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
      </header>

      <div className="body">
        <aside className="sidebar">
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
          </div>
        </aside>

        <main className="main">
          {hits ? (
            <div className="list-pane">
              <div className="pane-title">搜索结果 ({hits.length})</div>
              <div className="session-list">
                {hits.map((h) => (
                  <button
                    key={`${h.kind}-${h.id}`}
                    className="hit"
                    onClick={() => h.sessionId && void openSession(h.sessionId)}
                  >
                    <div className="hit-head">
                      <AgentBadge type={h.agentType ?? '?'} />
                      <span className="hit-kind">{h.kind === 'session' ? '会话' : '消息'}</span>
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
              <div className="pane-title">会话 ({sessions.length})</div>
              <div className="session-list">
                {sessions.map((s) => (
                  <button key={s.id} className="session" onClick={() => void openSession(s.id)}>
                    <div className="session-head">
                      <AgentBadge type={s.agentType} />
                      <span className="session-title">{s.title ?? s.externalId}</span>
                      <span className="session-time">{fmtTime(s.startedAt)}</span>
                    </div>
                    {s.summary && <div className="session-summary">{s.summary.split('\n')[0]}</div>}
                    <div className="session-meta">
                      {s.project && <span>📁 {s.project}</span>}
                      <span>💬 {s.messageCount}</span>
                      <span>🔧 {s.toolCallCount}</span>
                    </div>
                  </button>
                ))}
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
                  </div>
                  <div className="detail-meta">
                    {selected.session.project && <span>项目: {selected.session.project}</span>}
                    <span>开始: {fmtTime(selected.session.started_at)}</span>
                    <span>消息: {selected.messages.length}</span>
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
      </div>
    </div>
  )
}
