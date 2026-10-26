import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Brain, Settings2, History } from 'lucide-react'
import appIcon from './assets/icon.png'
import type { SearchHit, SessionSummaryRow } from '../../shared/types'
import { api, type DigestLatest, type DigestStatusInfo, type Overview, type SessionDetail } from './api'
import { edgeScrollDelta } from './drag-autoscroll'
import { orderAgentChips } from './chips-order'
import MemoriesView from './MemoriesView'
import SettingsView from './SettingsView'

type View = 'sessions' | 'memories' | 'settings'
const VIEW_LABEL: Record<View, string> = {
  sessions: '会话',
  memories: '记忆',
  settings: '设置'
}

const VIEW_ICON: Record<View, typeof History> = {
  sessions: History,
  memories: Brain,
  settings: Settings2
}
const CAPTURE_PLUGINS: Array<{ id: string; label: string }> = [
  { id: 'capture-codex', label: 'Codex' },
  { id: 'capture-zcode', label: 'ZCode' },
  { id: 'capture-hermes', label: 'Hermes' },
  { id: 'capture-claudecode', label: 'Claude Code' },
  { id: 'capture-qwencode', label: 'Qwen Code' },
  { id: 'capture-kimicli', label: 'Kimi CLI' },
  { id: 'capture-codebuddy', label: 'CodeBuddy' },
  { id: 'capture-workbuddy', label: 'WorkBuddy' },
  { id: 'capture-qoder', label: 'Qoder CLI' },
  { id: 'capture-gemini', label: 'Gemini CLI' },
  { id: 'capture-cursor', label: 'Cursor' },
  { id: 'capture-opencode', label: 'OpenCode' },
  { id: 'capture-dsh', label: 'DeepSeek Harness' }
]

function fmtTime(ts: number | null | undefined): string {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false })
}

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n))

/** compact stamp for the dense session list: "10-22 13:02" */
function fmtShort(ts: number | null | undefined): string {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/**
 * Same compact stamp, with the year when it is not the current one — a session
 * that last spoke 8 months ago is exactly the case where "03-15" is ambiguous.
 */
function fmtShortYear(ts: number | null | undefined): string {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  const md = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  return d.getFullYear() === new Date().getFullYear() ? md : `${d.getFullYear()}-${md}`
}

/**
 * "how long ago did this session last talk" — the signal that tells a session
 * that started last week but ended this morning apart from one that has been
 * quiet since the day it started. Beyond 30 days the relative form stops
 * helping, so it falls back to an absolute stamp (year included when needed).
 */
function fmtRelative(ts: number | null | undefined): string {
  if (!ts) return '—'
  const diff = Date.now() / 1000 - ts
  // a future timestamp is not "just now": a clock that jumped backwards or a
  // peer device reporting ahead would otherwise read as live activity
  if (diff < -60) return '时间异常'
  if (diff < 0) return '刚刚'
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`
  return fmtShortYear(ts)
}

function AgentBadge({ type }: { type: string }) {
  return <span className={`badge badge-${type}`}>{type}</span>
}

/** digest 徽标四态(会话组头与「项目总结」弹窗共用) */
function digestBadgeOf(dst?: {
  status: string
  lastDigestAt: number | null
  lastError: string | null
}): { cls: string; text: string; title: string } {
  if (dst?.status === 'running') return { cls: 'running', text: '⟳ 总结中', title: '正在生成滚动总结' }
  if (dst?.lastDigestAt) {
    return {
      cls: 'ok',
      text: `✓ ${fmtRelative(dst.lastDigestAt / 1000)}`,
      title: `上次总结: ${fmtTime(dst.lastDigestAt / 1000)}${dst.lastError ? `\n${dst.lastError}` : ''}`
    }
  }
  return { cls: 'dim', text: '未总结', title: '有会话待总结;新会话安静期后自动生成,或点「总结」立即生成' }
}

/**
 * Drag near the top/bottom edge of a scrollable list and it scrolls for you.
 *
 * The wheel does not work while an HTML5 drag is in flight — the browser owns
 * the pointer once dragstart fires, so the only way to reach sessions beyond
 * the fold is to scroll the container from code. The per-frame math lives in
 * ./drag-autoscroll (unit-tested there); this hook is the DOM side.
 *
 * onEdgeHover(id, below) reports the row currently under the pointer while the
 * list scrolls under it, so the drop indicator follows the drag instead of
 * freezing on whatever row happened to be there when the scrolling began.
 */
function useDragAutoScroll(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  active: boolean,
  onEdgeHover: (id: number, below: boolean) => void
): void {
  // keep the callback in a ref so the effect does not restart every render
  const hoverRef = useRef(onEdgeHover)
  hoverRef.current = onEdgeHover

  useEffect(() => {
    if (!active) return
    const el = scrollRef.current
    if (!el) return
    let raf = 0
    let x = 0
    let y = 0

    const track = (e: PointerEvent): void => {
      x = e.clientX
      y = e.clientY
    }
    const tick = (): void => {
      const delta = edgeScrollDelta(y, el.getBoundingClientRect())
      if (delta !== 0) {
        const before = el.scrollTop
        el.scrollTop += delta
        // the list moved under a stationary pointer: re-read the row so the
        // drop indicator tracks the drag instead of sticking to one row
        if (el.scrollTop !== before) {
          const row = document.elementFromPoint(x, y)?.closest('.session')
          const id = Number(row?.getAttribute('data-id'))
          if (id) {
            const r = (row as HTMLElement).getBoundingClientRect()
            hoverRef.current(id, y - r.top > r.height / 2)
          }
        }
      }
      raf = requestAnimationFrame(tick)
    }

    window.addEventListener('pointermove', track, true)
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', track, true)
    }
  }, [scrollRef, active])
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
  const [devlogDir, setDevlogDir] = useState<string | null>(null)
  const [mcp, setMcp] = useState<{ port: number; running: boolean; toolCount: number } | null>(null)
  const [kbMsg, setKbMsg] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [importTitle, setImportTitle] = useState('')
  const [importSource, setImportSource] = useState('')
  const [importBusy, setImportBusy] = useState(false)
  const [importErr, setImportErr] = useState<string | null>(null)
  const [view, setView] = useState<View>('sessions')
  const [enabledCaptures, setEnabledCaptures] = useState<Record<string, boolean>>({})
  const [showArchived, setShowArchived] = useState(false)
  const [rename, setRename] = useState<{ id: number; value: string } | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [expandedChains, setExpandedChains] = useState<Set<number>>(new Set())
  const [draggingId, setDraggingId] = useState<number | null>(null)
  const [dropLine, setDropLine] = useState<{ afterId: number; below: boolean } | null>(null)
  /** the scrolling session list — drag auto-scroll needs its DOM node */
  const sessionListRef = useRef<HTMLDivElement | null>(null)
  // dragging: the wheel is dead during an HTML5 drag, so the list scrolls itself
  // when the pointer nears its top/bottom edge
  useDragAutoScroll(sessionListRef, draggingId != null, (id, below) =>
    setDropLine((prev) => (prev?.afterId === id && prev.below === below ? prev : { afterId: id, below }))
  )
  const [upBanner, setUpBanner] = useState<{
    available?: boolean
    version?: string
    downloaded?: boolean
    error?: string
    progress?: { percent: number; transferred: number; total: number }
  } | null>(null)
  // "later" dismissal of the ready-to-install dialog, keyed by version so a
  // NEWLY downloaded version re-asks instead of staying silenced
  const [updateAskDismissed, setUpdateAskDismissed] = useState<string | null>(null)

  const [relayPick, setRelayPick] = useState<{ id: number; project: string } | null>(null)

  // 项目滚动总结:总开关关闭时 digestInfo.enabled=false,组头不渲染任何总结 UI
  const [digestInfo, setDigestInfo] = useState<DigestStatusInfo | null>(null)
  const [digestCards, setDigestCards] = useState<Record<number, DigestLatest | null>>({})
  const [openDigest, setOpenDigest] = useState<Set<number>>(new Set())
  const openDigestRef = useRef<Set<number>>(new Set())
  // 「项目总结」弹窗(顶栏入口):选中项目 + 内容懒取
  const [digestModal, setDigestModal] = useState(false)
  const [digestModalSel, setDigestModalSel] = useState<number | null>(null)
  // 项目组折叠(纯 UI 偏好,localStorage 记住;undefined = 展开为默认)
  const [closedGroups, setClosedGroups] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem('msql.projectGroups') ?? '{}') as Record<string, boolean>
    } catch {
      return {}
    }
  })

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

  const refreshDigest = useCallback(async (): Promise<void> => {
    try {
      setDigestInfo(await api.digestStatus())
      // 展开中的卡片同步刷新内容(总结刚完成时能看到新产物)
      for (const pid of openDigestRef.current) {
        void api
          .digestLatest(pid)
          .then((d) => setDigestCards((prev) => ({ ...prev, [pid]: d })))
          .catch(() => {})
      }
    } catch {
      setDigestInfo(null)
    }
  }, [])

  // 总结开始/完成都会推 digest:changed —— 徽标与卡片跟着刷新
  useEffect(() => {
    void refreshDigest()
    return api.onDigestChanged(() => void refreshDigest())
  }, [refreshDigest])

  const fetchDigest = useCallback((projectId: number): void => {
    void api
      .digestLatest(projectId)
      .then((d) => setDigestCards((prev) => ({ ...prev, [projectId]: d })))
      .catch(() => {})
  }, [])

  const toggleDigestCard = useCallback((projectId: number): void => {
    setOpenDigest((prev) => {
      const next = new Set(prev)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      openDigestRef.current = next
      return next
    })
    fetchDigest(projectId)
  }, [fetchDigest])

  const runDigestNow = useCallback(
    (projectId: number): void => {
      void api.digestRun(projectId).then(() => void refreshDigest())
    },
    [refreshDigest]
  )

  // startup auto-check pushes state here — show a non-blocking banner outside Settings
  useEffect(() => {
    const show = (s: {
      available?: boolean
      version?: string
      downloaded?: boolean
      error?: string
    }): void => {
      setUpBanner(s.available || s.downloaded ? s : null)
    }
    void api.updateStatus().then(show).catch(() => {})
    return api.onUpdateStatus(show)
  }, [])

  const openSession = useCallback(async (id: number) => {
    setSelected(await api.getSession(id))
  }, [])

  // walk back one page of messages (tail-first paging keeps big sessions out
  // of the renderer until the user asks for them)
  const loadEarlier = useCallback(async () => {
    setSelected((cur) => {
      if (!cur || !cur.hasMore || cur.firstSeq == null) return cur
      const sid = cur.session.id
      void api
        .getSession(sid, { beforeSeq: cur.firstSeq })
        .then((prev) => {
          setSelected((c) =>
            c && c.session.id === sid
              ? { ...prev, messages: [...prev.messages, ...c.messages] }
              : c
          )
        })
        .catch((err) => setKbMsg(`加载更早消息失败: ${String(err)}`))
      return cur
    })
  }, [])

  // Ctrl+1..3 switch views (command-driven navigation)
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || e.shiftKey || e.altKey) return
      const views: View[] = ['sessions', 'memories', 'settings']
      const i = ['1', '2', '3'].indexOf(e.key)
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
      // the vault is no longer an in-app note library — the generated files
      // are only reachable from disk, so offer the folder right away.
      // devlogDir lives in its own state (NOT devlogNote): the note is a 4s
      // toast, but this button has to outlive it or the folder is unreachable.
      if (res.files.length > 0) {
        void api
          .paths()
          .then((pp) => setDevlogDir(pp.devlogDir))
          .catch(() => setDevlogDir(null))
      } else {
        setDevlogDir(null)
      }
      await refresh()
    } catch {
      setDevlogNote('生成失败')
      setDevlogDir(null)
    } finally {
      setDevlogBusy(false)
      setTimeout(() => setDevlogNote(null), 4000)
    }
  }, [refresh])

  const openDevlogDir = useCallback(() => {
    void api.openPath(devlogDir ?? '').catch((e) =>
      setKbMsg(`打开日志目录失败: ${String(e)}`)
    )
  }, [devlogDir])

  const doImport = useCallback(async () => {
    if (!importText.trim()) return
    setImportBusy(true)
    setImportErr(null)
    try {
      const res = await api.importChat({
        text: importText,
        title: importTitle.trim() || undefined,
        source: importSource.trim() || undefined
      })
      setImportOpen(false)
      setImportText('')
      setImportTitle('')
      setImportSource('')
      setKbMsg(
        res.imported === 0 && res.skipped > 0
          ? '同样的内容已经导入过,无需重复'
          : `已导入为会话 #${res.sessionId}(${res.messages} 条消息)`
      )
      await refresh()
    } catch (err) {
      setImportErr(String(err instanceof Error ? err.message : err))
    } finally {
      setImportBusy(false)
    }
  }, [importText, importTitle, importSource, refresh])

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
          <span className="session-times">
            <span className="session-time" title={`会话开始: ${fmtTime(s.startedAt)}`}>
              <span className="session-time-key">开始</span>
              {fmtShort(s.startedAt)}
            </span>
            <span
              className="session-time session-time-last"
              title={`最后一次对话: ${fmtTime(s.lastMessageAt)}`}
            >
              <span className="session-time-key">最后</span>
              {fmtRelative(s.lastMessageAt)}
            </span>
          </span>
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
          {(['sessions', 'memories'] as View[]).map((v) => {
            const Icon = VIEW_ICON[v]
            return (
              <button
                key={v}
                className={`rail-btn rail-btn-fill ${view === v ? 'active' : ''}`}
                aria-label={VIEW_LABEL[v]}
                title={VIEW_LABEL[v]}
                onClick={() => setView(v)}
              >
                <Icon size={18} strokeWidth={1.8} />
              </button>
            )
          })}
        </div>
        <div className="rail-bottom">
          <button
            className={`rail-btn ${view === 'settings' ? 'active' : ''}`}
            aria-label={VIEW_LABEL.settings}
            onClick={() => setView('settings')}
          >
            <Settings2 size={18} strokeWidth={1.8} />
          </button>
        </div>
      </nav>
      <div className="app-main">
      <header className="topbar">
        <div className="brand">MemorySQL</div>
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
        <button className="btn" onClick={() => { setImportOpen(true); setImportErr(null) }}>
          导入对话
        </button>
        <button
          className="btn"
          title="浏览各项目的滚动总结(摘要/待办/决策),可立即总结"
          onClick={() => {
            setDigestModal(true)
            void refreshDigest()
          }}
        >
          项目总结
        </button>
        <button className="btn btn-accent" disabled={scanning} onClick={() => void scanAll()}>
          {scanning ? '扫描中…' : '立即扫描'}
        </button>
        <button className="btn" disabled={devlogBusy} onClick={() => void devlog()}>
          {devlogBusy ? '生成中…' : '生成项目日志'}
        </button>
        {devlogNote && <span className="devlog-note">{devlogNote}</span>}
        {devlogDir && (
          <button
            className="btn btn-small"
            title={devlogDir}
            onClick={openDevlogDir}
          >
            打开日志目录
          </button>
        )}
      </header>

      {upBanner && (upBanner.downloaded || upBanner.available) && (
        <div className="update-banner" role="status">
          {upBanner.downloaded
            ? `新版本 v${upBanner.version ?? ''} 已下载,退出应用后自动安装`
            : upBanner.error
              ? `发现新版本 v${upBanner.version ?? ''},下载失败——${upBanner.error}`
              : upBanner.progress
                ? `正在下载 v${upBanner.version ?? ''}… ${Math.round(upBanner.progress.percent)}%`
                : `发现新版本 v${upBanner.version ?? ''},正在后台下载…`}
          {upBanner.progress && !upBanner.downloaded && (
            <div className="update-progress" style={{ marginLeft: 10 }}>
              <div
                className="update-progress-fill"
                style={{ width: `${Math.min(100, Math.max(0, upBanner.progress.percent))}%` }}
              />
            </div>
          )}
          {upBanner.downloaded && (
            <button
              className="btn btn-accent btn-small"
              style={{ marginLeft: 10 }}
              onClick={() => void api.updateInstallNow()}
            >
              立即重启安装
            </button>
          )}
          <button
            className="btn btn-small"
            style={{ marginLeft: 10 }}
            onClick={() => setView('settings')}
          >
            查看
          </button>
          <button className="btn btn-ghost btn-small" onClick={() => setUpBanner(null)}>
            稍后
          </button>
        </div>
      )}

      <div className="body">
        {view === 'sessions' && (
        <aside className="sidebar">
            <>
          <div className="side-section">
            <div className="side-title">Agent</div>
            {/*「显示取决于检测到了多少」:数量降序,0 条沉底弱化(捕获对所有已启用
                agent 默认开启,0 条 = 本机未装/未用到,不是故障) */}
            {(() => {
              const counts = new Map((overview?.byAgent ?? []).map((x) => [x.agent_type, x.sessions]))
              // 「显示取决于检测到了多少」:数量降序;未检测到(0 条)的 agent 不占位
              const chips = orderAgentChips(
                CAPTURE_PLUGINS.filter(({ id }) => enabledCaptures[id] !== false).map(({ id }) => id.replace('capture-', '')),
                counts
              ).filter((c) => c.count > 0)
              return ['all', ...chips.map((c) => c.agent)].map((a) => {
                const count = a === 'all'
                  ? overview?.byAgent.reduce((n, x) => n + x.sessions, 0) ?? 0
                  : counts.get(a) ?? 0
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
              })
            })()}
          </div>

          <div className="side-section">
            <div className="side-title">捕获状态</div>
            {(() => {
              const counts = new Map((overview?.byAgent ?? []).map((x) => [x.agent_type, x.sessions]))
              const ordered = [...CAPTURE_PLUGINS.filter(({ id }) => enabledCaptures[id] !== false)].sort(
                (x, y) => (counts.get(y.id.replace('capture-', '')) ?? 0) - (counts.get(x.id.replace('capture-', '')) ?? 0)
              )
              return ordered.map(({ id, label }) => {
                const n = counts.get(id.replace('capture-', '')) ?? 0
                return (
                  <div key={id} className={`capture-status ${n === 0 ? 'dim' : ''}`}>
                    <span className={`dot ${statuses[id]?.startsWith('错误') ? 'err' : 'ok'}`} />
                    <div>
                      <div className="capture-name">{label}</div>
                      <div className="capture-detail">{statuses[id] ?? '…'}</div>
                    </div>
                  </div>
                )
              })
            })()}
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
                        {({ session: '会话', message: '消息', memory: '记忆' } as const)[h.kind]}
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
              <div className="session-list" ref={sessionListRef}>
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
                    // 项目滚动总结徽标(总开关开启才渲染;未分配项目组无 projectId 不参与)
                    const dPid = rows[0]?.projectId ?? null
                    const dOn = digestInfo?.enabled === true && dPid != null
                    const dst = dPid != null ? digestInfo?.projects.find((p) => p.projectId === dPid) : undefined
                    const badge = digestBadgeOf(dst)
                    const card = dPid != null ? digestCards[dPid] : undefined
                    const groupOpen = closedGroups[project] !== false
                    const toggleGroup = (): void => {
                      setClosedGroups((prev) => {
                        const next = { ...prev, [project]: !(prev[project] !== false) }
                        try {
                          localStorage.setItem('msql.projectGroups', JSON.stringify(next))
                        } catch {
                          /* 隐私模式写不进只影响本会话 */
                        }
                        return next
                      })
                    }
                    const digestCardNode =
                      dOn && dPid != null && openDigest.has(dPid) && groupOpen ? (
                        <div key={`${project}-digest`} className="digest-card">
                          {card ? (
                            <>
                              <div className="digest-card-head">
                                <span className="mono-tag">滚动总结 · {card.model}</span>
                                <span className="hint">
                                  覆盖 {fmtShort(card.periodStart)} ~ {fmtShort(card.periodEnd)} · {card.sessionsCovered} 会话 · 生成于{' '}
                                  {fmtTime(card.createdAt / 1000)}
                                </span>
                              </div>
                              <pre className="digest-summary">{card.summary}</pre>
                              {card.perSession?.length > 0 && (
                                <div className="digest-sessions">
                                  <div className="digest-sessions-title">按会话</div>
                                  {card.perSession.map((p, i) => (
                                    <div key={i} className="digest-session">
                                      <span className="sess-id">#{p.id}</span> {p.title || '(无标题)'} — {p.note}
                                    </div>
                                  ))}
                                </div>
                              )}
                              {card.todos.length > 0 && (
                                <div className="digest-todos">
                                  {card.todos.map((t, i) => (
                                    <div key={i} className={`digest-todo ${t.status === 'done' ? 'done' : ''}`}>
                                      [{t.status === 'done' ? 'x' : ' '}] {t.content}
                                    </div>
                                  ))}
                                </div>
                              )}
                              {card.decisions.length > 0 && (
                                <div className="digest-decisions">
                                  {card.decisions.map((d, i) => (
                                    <div key={i}>· {d}</div>
                                  ))}
                                </div>
                              )}
                            </>
                          ) : (
                            <div className="empty">该项目的总结还没生成 —— 点组头右侧「总结」立即生成一次</div>
                          )}
                        </div>
                      ) : null

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
                        title="点击折叠/展开该项目的会话"
                        onClick={() => toggleGroup()}
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
                        <span className={`chev ${groupOpen ? 'open' : ''}`}>▸</span>
                        {project}
                        <span className="group-count">{rows.length}</span>
                        {dOn && (
                          <span
                            className={`digest-badge ${badge.cls}`}
                            title={badge.title}
                            onClick={(e) => {
                              e.stopPropagation()
                              toggleDigestCard(dPid as number)
                            }}
                          >
                            {badge.text}
                          </span>
                        )}
                        {dOn && (
                          <button
                            className="btn btn-small digest-now"
                            title="立即总结该项目的新会话(LLM 引擎未配置时为本地规则总结,零外发)"
                            onClick={(e) => {
                              e.stopPropagation()
                              runDigestNow(dPid as number)
                            }}
                          >
                            总结
                          </button>
                        )}
                      </div>,
                      ...(groupOpen ? [...(digestCardNode ? [digestCardNode] : []), ...body] : []),
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
                    <span>最后: {fmtTime(selected.session.last_message_at)}</span>
                    <span>
                      消息: {selected.messages.length}
                      {selected.total > selected.messages.length ? ` / ${selected.total}` : ''}
                    </span>
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
                  {selected.hasMore && (
                    <button className="btn btn-small load-earlier" onClick={() => void loadEarlier()}>
                      加载更早的消息(已显示 {selected.messages.length} / {selected.total})
                    </button>
                  )}
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
        {upBanner?.downloaded && upBanner.version !== updateAskDismissed && (
          <div className="modal-overlay" onClick={() => setUpdateAskDismissed(upBanner.version ?? '')}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-title">更新已就绪 — v{upBanner.version ?? ''}</div>
              <p className="hint">
                安装包已下载完成。立即重启并安装,或稍后手动重启——退出应用时也会自动安装。
              </p>
              <div className="field-row" style={{ justifyContent: 'flex-end' }}>
                <button className="btn btn-small" onClick={() => setUpdateAskDismissed(upBanner.version ?? '')}>
                  稍后手动重启
                </button>
                <button className="btn btn-accent btn-small" onClick={() => void api.updateInstallNow()}>
                  立即重启安装
                </button>
              </div>
            </div>
          </div>
        )}
        {digestModal && (
          <div className="modal-overlay" onClick={() => setDigestModal(false)}>
            <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
              <div className="modal-title">项目总结 · 各项目滚动摘要</div>
              {digestInfo == null ? (
                <p className="hint">加载中…</p>
              ) : !digestInfo.enabled ? (
                <p className="hint">
                  项目总结未开启 —— 在 设置 → 智能引擎 → 项目总结 中开启后,这里会显示各项目的滚动总结。
                </p>
              ) : (
                <div className="digest-modal-body">
                  <div className="digest-modal-list">
                    {digestInfo.projects.map((p) => {
                      const b = digestBadgeOf(p)
                      return (
                        <button
                          key={p.projectId}
                          className={`modal-item digest-modal-item ${digestModalSel === p.projectId ? 'sel' : ''}`}
                          onClick={() => {
                            setDigestModalSel(p.projectId)
                            fetchDigest(p.projectId)
                          }}
                        >
                          <span className="digest-modal-name">{p.name}</span>
                          <span className={`digest-badge ${b.cls}`} title={b.title}>
                            {b.text}
                          </span>
                        </button>
                      )
                    })}
                    {digestInfo.projects.length === 0 && <div className="empty">还没有带会话的项目</div>}
                  </div>
                  <div className="digest-modal-detail">
                    {(() => {
                      const d = digestModalSel != null ? digestCards[digestModalSel] : undefined
                      if (digestModalSel == null) return <div className="empty">左侧选择项目查看最新总结</div>
                      if (!d) {
                        return (
                          <div className="empty">
                            该项目还没有总结 —— 点下方「立即总结该项目」生成一次
                          </div>
                        )
                      }
                      return (
                        <>
                          <div className="digest-card-head">
                            <span className="mono-tag">
                              {d.projectName} · {d.model}
                            </span>
                            <span className="hint">
                              覆盖 {fmtShort(d.periodStart)} ~ {fmtShort(d.periodEnd)} · {d.sessionsCovered} 会话 · 生成于{' '}
                              {fmtTime(d.createdAt / 1000)}
                            </span>
                          </div>
                          <pre className="digest-summary">{d.summary}</pre>
                          {d.perSession?.length > 0 && (
                            <div className="digest-sessions">
                              <div className="digest-sessions-title">按会话</div>
                              {d.perSession.map((p, i) => (
                                <div key={i} className="digest-session">
                                  <span className="sess-id">#{p.id}</span> {p.title || '(无标题)'} — {p.note}
                                </div>
                              ))}
                            </div>
                          )}
                          {d.todos.length > 0 && (
                            <div className="digest-todos">
                              {d.todos.map((t, i) => (
                                <div key={i} className={`digest-todo ${t.status === 'done' ? 'done' : ''}`}>
                                  [{t.status === 'done' ? 'x' : ' '}] {t.content}
                                </div>
                              ))}
                            </div>
                          )}
                          {d.decisions.length > 0 && (
                            <div className="digest-decisions">
                              {d.decisions.map((x, i) => (
                                <div key={i}>· {x}</div>
                              ))}
                            </div>
                          )}
                        </>
                      )
                    })()}
                    {digestModalSel != null && (
                      <div className="field-row" style={{ justifyContent: 'flex-end' }}>
                        <button
                          className="btn btn-accent btn-small"
                          onClick={() => {
                            runDigestNow(digestModalSel as number)
                            fetchDigest(digestModalSel as number)
                          }}
                        >
                          立即总结该项目
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}
              <div className="field-row" style={{ justifyContent: 'flex-end' }}>
                <button className="btn btn-small" onClick={() => setDigestModal(false)}>
                  关闭
                </button>
              </div>
            </div>
          </div>
        )}

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
                      <span className="sess-id">#{r.id}</span>
                      <span className="session-times">
                        <span className="session-time">
                          <span className="session-time-key">开始</span>
                          {fmtShortYear(r.startedAt)}
                        </span>
                        <span
                          className="session-time session-time-last"
                          title={`最后一次对话: ${fmtTime(r.lastMessageAt)}`}
                        >
                          <span className="session-time-key">最后</span>
                          {fmtRelative(r.lastMessageAt)}
                        </span>
                      </span>
                    </button>
                  ))}
              </div>
              <button className="btn btn-small" onClick={() => setRelayPick(null)}>
                取消
              </button>
            </div>
          </div>
        )}

        {importOpen && (
          <div className="modal-overlay" onClick={() => setImportOpen(false)}>
            <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
              <div className="modal-title">导入对话</div>
              <p className="hint">
                粘贴聊天记录(识别「用户 / Assistant:」等角色标记,支持中英文与 Markdown 加粗/标题)或导入
                agent 导出的 md / txt / json 文件。同一内容重复导入会自动去重。
              </p>
              <input
                className="import-input"
                placeholder="标题(可选,默认取首条消息开头)"
                value={importTitle}
                onChange={(e) => setImportTitle(e.target.value)}
              />
              <textarea
                className="import-textarea"
                placeholder={'粘贴对话内容,例如:\n\n用户:帮我看看这个报错\n助手:这是因为…\n\n或拖入/选择导出的对话文件'}
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
              />
              <div className="field-row">
                <label className="btn btn-small">
                  选择文件…
                  <input
                    type="file"
                    accept=".md,.txt,.json,.log"
                    style={{ display: 'none' }}
                    onChange={async (e) => {
                      const f = e.target.files?.[0]
                      if (!f) return
                      setImportText(await f.text())
                      setImportSource(f.name)
                    }}
                  />
                </label>
                {importSource && <span className="hint">{importSource}</span>}
                <span style={{ flex: 1 }} />
                <button className="btn btn-small" onClick={() => setImportOpen(false)}>
                  取消
                </button>
                <button
                  className="btn btn-accent btn-small"
                  disabled={importBusy || !importText.trim()}
                  onClick={() => void doImport()}
                >
                  {importBusy ? '导入中…' : '导入'}
                </button>
              </div>
              {importErr && <p className="hint">导入失败:{importErr}</p>}
            </div>
          </div>
        )}

      </div>
    </div>
  )
}
