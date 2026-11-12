import { Fragment, useCallback, useEffect, useState } from 'react'
import { api } from './api'

interface MemoryRow {
  id: number
  kind: string
  content: string
  source: string | null
  status: string
  agentType: string | null
  projectId: number | null
  projectName: string | null
  scope: 'global' | 'project'
  locked: number
  accessCount: number
  lastAccessAt: number | null
  updated_at: number
}

const KINDS = ['persona', 'preference', 'fact', 'decision'] as const
const KIND_LABEL: Record<string, string> = {
  persona: '画像',
  preference: '偏好',
  fact: '事实',
  decision: '决策'
}

interface Draft {
  id?: number
  kind: string
  content: string
  scope: 'global' | 'project'
  projectId: number | null
  locked: boolean
}

type ScopeFilter = 'all' | 'global' | 'project'

const PAGE = 500

export default function MemoriesView() {
  const [rows, setRows] = useState<MemoryRow[]>([])
  const [projects, setProjects] = useState<Array<{ id: number; name: string; count: number }>>([])
  const [hasMore, setHasMore] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [msg, setMsg] = useState('')
  const [kindFilter, setKindFilter] = useState<string>('all')
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all')
  const [projectFilter, setProjectFilter] = useState<number | null>(null)
  const [showRetired, setShowRetired] = useState(false)
  const [detecting, setDetecting] = useState(false)
  const [conflicts, setConflicts] = useState<
    Array<{ aId: number; bId: number; reason: string; aExcerpt: string; bExcerpt: string }>
  >([])

  const load = useCallback(async (): Promise<void> => {
    const scope = scopeFilter === 'all' ? undefined : scopeFilter
    const first = (await api.memories({
      scope,
      projectId: projectFilter ?? undefined
    })) as unknown as MemoryRow[]
    setRows(first)
    setHasMore(first.length >= PAGE)
    try {
      setProjects(await api.memoriesProjects())
    } catch {
      /* projects list is optional UI sugar */
    }
  }, [scopeFilter, projectFilter])

  const loadMore = useCallback(async (): Promise<void> => {
    const scope = scopeFilter === 'all' ? undefined : scopeFilter
    const more = (await api.memories({
      offset: rows.length,
      scope,
      projectId: projectFilter ?? undefined
    })) as unknown as MemoryRow[]
    setRows((cur) => [...cur, ...more])
    setHasMore(more.length >= PAGE)
  }, [rows.length, scopeFilter, projectFilter])

  useEffect(() => {
    void load()
  }, [load])

  // 自动整理/候选确认/扫描都会发 sessions:changed;1.5s 防抖后重载,
  // 否则 LLM 刚整理完的记忆要切页面才看得到。
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = api.onSessionsChanged(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void load(), 1500)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [load])

  const save = useCallback(async (): Promise<void> => {
    if (!draft) return
    try {
      await api.memoriesSave({
        id: draft.id,
        kind: draft.kind,
        content: draft.content,
        scope: draft.scope,
        projectId: draft.scope === 'project' ? draft.projectId : null,
        locked: draft.locked
      })
      setDraft(null)
      setMsg('')
      await load()
    } catch (e) {
      setMsg(`保存失败: ${String(e)}`)
    }
  }, [draft, load])

  const detect = useCallback(async (): Promise<void> => {
    setDetecting(true)
    try {
      const r = await api.memoriesDetectConflicts()
      setConflicts(r.conflicts)
      setMsg(r.message)
    } catch (e) {
      setMsg(`检测失败: ${String(e)}`)
    } finally {
      setDetecting(false)
    }
  }, [])

  const sourceLabel = (s: string | null): string => {
    if (!s) return '手动'
    if (s === 'manual') return '手动'
    if (s.startsWith('llm-curator')) return '自动整理'
    if (s.startsWith('project-digest')) return '总结候选'
    if (s.startsWith('distill')) return '规则提取'
    return s
  }

  // 分类放进项目里:查看「全部」或「全部项目记忆」时先按项目分组,
  // 每个项目内部再按画像/偏好/事实/决策分小节。
  // 自动整理会持续 retire 旧候选/低热度条目,默认不显示已停用行,避免列表被死条目淹没。
  const visibleRows = showRetired ? rows : rows.filter((r) => r.status !== 'retired')
  const multiProject = scopeFilter === 'all' || (scopeFilter === 'project' && projectFilter == null)
  const filteredCount =
    kindFilter === 'all' ? visibleRows.length : visibleRows.filter((r) => r.kind === kindFilter).length
  const projectGroups = (() => {
    if (!multiProject) return []
    const order = new Map<string, number>()
    projects.forEach((p, i) => order.set(`p${p.id}`, i + 1))
    const map = new Map<string, { key: string; label: string; order: number; rows: MemoryRow[] }>()
    for (const r of visibleRows) {
      const key = r.scope === 'global' ? 'global' : `p${r.projectId ?? 0}`
      const label = r.scope === 'global' ? '全局记忆' : (r.projectName ?? '未归属项目')
      const g = map.get(key) ?? {
        key,
        label,
        order: key === 'global' ? 0 : (order.get(key) ?? 900),
        rows: []
      }
      g.rows.push(r)
      map.set(key, g)
    }
    return [...map.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
  })()

  const renderRow = (r: MemoryRow) => (
    <div key={r.id} className={`mem-row ${r.status !== 'active' ? 'mem-retired' : ''}`}>
      <pre className="mem-content">{r.content}</pre>
      <div className="mem-meta">
        <span className={`mem-scope ${r.scope}`}>
          {r.scope === 'project' ? (r.projectName ?? '项目') : '全局'}
        </span>
        <span className="mem-source">{sourceLabel(r.source)}</span>
        {r.agentType && <span className="mono-tag">· {r.agentType}</span>}
        {r.locked === 1 && <span className="mono-tag">· 已锁定</span>}
        {r.status !== 'active' && <span>· {r.status}</span>}
        <span className="mem-actions">
          <button
            className="link"
            onClick={() =>
              setDraft({
                id: r.id,
                kind: r.kind,
                content: r.content,
                scope: r.scope,
                projectId: r.projectId,
                // 用户编辑即接管:默认锁定,避免自动整理覆盖这次修改
                locked: true
              })
            }
          >
            编辑
          </button>
          {r.status === 'active' ? (
            <button className="link" onClick={() => void api.memoriesSetStatus(r.id, 'retired').then(load)}>
              停用
            </button>
          ) : (
            <button className="link" onClick={() => void api.memoriesSetStatus(r.id, 'active').then(load)}>
              启用
            </button>
          )}
          <button
            className="link"
            onClick={() =>
              void api
                .memoriesSetLocked(r.id, r.locked !== 1)
                .then(() => load())
                .catch((e) => setMsg(`操作失败: ${String(e)}`))
            }
          >
            {r.locked === 1 ? '解锁' : '锁定'}
          </button>
          <button className="link danger" onClick={() => void api.memoriesDelete(r.id).then(load)}>
            删除
          </button>
        </span>
      </div>
    </div>
  )

  const renderKindGroups = (list: MemoryRow[], headerClass: string) =>
    (kindFilter === 'all' ? KINDS : [kindFilter as (typeof KINDS)[number]]).map((kind) => {
      const group = list.filter((r) => r.kind === kind)
      if (group.length === 0) return null
      return (
        <div key={kind}>
          <div className={headerClass}>
            {KIND_LABEL[kind]} ({group.length})
          </div>
          {group.map(renderRow)}
        </div>
      )
    })

  return (
    <div className="memories-pane">
      <aside className="sidebar mem-sidebar">
        <div className="side-section">
          <div className="side-title">范围</div>
          <button
            className={`side-item ${scopeFilter === 'all' ? 'active' : ''}`}
            onClick={() => {
              setScopeFilter('all')
              setProjectFilter(null)
              setKindFilter('all')
            }}
          >
            全部 <span className="count">{visibleRows.length}</span>
          </button>
          <button
            className={`side-item ${scopeFilter === 'global' ? 'active' : ''}`}
            onClick={() => {
              setScopeFilter('global')
              setProjectFilter(null)
              setKindFilter('all')
            }}
          >
            全局记忆
          </button>
          <button
            className={`side-item ${scopeFilter === 'project' && projectFilter == null ? 'active' : ''}`}
            onClick={() => {
              setScopeFilter('project')
              setProjectFilter(null)
              setKindFilter('all')
            }}
          >
            全部项目记忆
          </button>
          {projects.map((p) => {
            const current = scopeFilter === 'project' && projectFilter === p.id
            return (
              <Fragment key={p.id}>
                <button
                  className={`side-item ${current ? 'active' : ''}`}
                  onClick={() => {
                    setScopeFilter('project')
                    setProjectFilter(p.id)
                    setKindFilter('all')
                  }}
                  title={p.name}
                >
                  <span className="mem-project-name">{p.name}</span>
                  <span className="count">{p.count}</span>
                </button>
                {/* 分类跟着项目走:选中项目后才展开该项目下的分类计数 */}
                {current && (
                  <div className="mem-subkinds">
                    <button
                      className={`side-item side-sub ${kindFilter === 'all' ? 'active' : ''}`}
                      onClick={() => setKindFilter('all')}
                    >
                      全部分类 <span className="count">{visibleRows.length}</span>
                    </button>
                    {KINDS.map((k) => {
                      const n = visibleRows.filter((r) => r.kind === k).length
                      return (
                        <button
                          key={k}
                          className={`side-item side-sub ${kindFilter === k ? 'active' : ''} ${n === 0 ? 'dim' : ''}`}
                          onClick={() => setKindFilter(k)}
                        >
                          {KIND_LABEL[k]} <span className="count">{n}</span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </Fragment>
            )
          })}
        </div>
      </aside>
      <div className="mem-main">
      <div className="pane-title">
        记忆 ({visibleRows.length})
        <button
          className="btn btn-small"
          style={{ marginLeft: 12 }}
          onClick={() =>
            setDraft({
              kind: 'fact',
              content: '',
              // 跟随当前范围:在「项目记忆」里新增默认归当前项目,否则默认全局
              scope: scopeFilter === 'project' ? 'project' : 'global',
              projectId: scopeFilter === 'project' ? (projectFilter ?? projects[0]?.id ?? null) : null,
              locked: true
            })
          }
        >
          + 新增
        </button>
        <button
          className="btn btn-small"
          style={{ marginLeft: 6 }}
          onClick={() =>
            void api.dispatchGenerate().then(
              async (r) => {
                // 与「导出备份」一致:生成完直接把目录弹到资源管理器,
                // 省得用户再自己找 vault/dispatch
                let opened = false
                try {
                  const pp = await api.paths()
                  await api.openPath(pp.dispatchDir)
                  opened = true
                } catch {
                  /* 目录打不开(例如自定义到数据目录外)不影响生成结果 */
                }
                setMsg(`已生成分发文件: ${r.files.join(' , ')}${opened ? ',已打开分发文件夹' : ''}`)
              },
              (e) => setMsg(`生成失败: ${String(e)}`)
            )
          }
        >
          生成分发文件
        </button>
        <button className="btn btn-small" style={{ marginLeft: 6 }} disabled={detecting} onClick={() => void detect()}>
          {detecting ? '检测中…' : '冲突检测'}
        </button>
        <label className="mem-retired-toggle" title="自动整理停用的旧条目默认隐藏">
          <input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} />
          显示已停用
        </label>
        {msg && <span className="pane-msg">{msg}</span>}
      </div>

      {conflicts.length > 0 && (
        <div className="mem-edit">
          <div className="mem-edit-actions" style={{ justifyContent: 'space-between' }}>
            <strong>疑似矛盾记忆({conflicts.length} 组)— 请人工裁决:停用旧版本或改写</strong>
            <button className="btn btn-small" onClick={() => setConflicts([])}>
              知道了
            </button>
          </div>
          {conflicts.map((c) => (
            <div key={`${c.aId}-${c.bId}`} className="mem-row">
              <pre className="mem-content">
                {`#${c.aId}: ${c.aExcerpt.slice(0, 160)}\n#${c.bId}: ${c.bExcerpt.slice(0, 160)}`}
              </pre>
              <div className="mem-meta">
                <span className="mem-source">⚠ {c.reason}</span>
                <span className="mem-actions">
                  <button className="link danger" onClick={() => void api.memoriesSetStatus(c.bId, 'retired').then(load)}>
                    停用 #{c.bId}
                  </button>
                  <button className="link danger" onClick={() => void api.memoriesSetStatus(c.aId, 'retired').then(load)}>
                    停用 #{c.aId}
                  </button>
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {draft && (
        <div className="mem-edit">
          <div className="mem-edit-row">
            <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]} ({k})
                </option>
              ))}
            </select>
            <select
              value={draft.scope}
              onChange={(e) => {
                const scope = e.target.value as 'global' | 'project'
                setDraft({
                  ...draft,
                  scope,
                  projectId: scope === 'project' ? (draft.projectId ?? projectFilter ?? projects[0]?.id ?? null) : null
                })
              }}
            >
              <option value="global">全局记忆</option>
              <option value="project">项目记忆</option>
            </select>
            {draft.scope === 'project' && (
              <select
                value={draft.projectId ?? ''}
                onChange={(e) => setDraft({ ...draft, projectId: e.target.value ? Number(e.target.value) : null })}
              >
                <option value="">(选择项目)</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
            <label className="mem-lock">
              <input
                type="checkbox"
                checked={draft.locked}
                onChange={(e) => setDraft({ ...draft, locked: e.target.checked })}
              />
              锁定(自动整理不覆盖)
            </label>
          </div>
          <textarea
            placeholder="记忆内容…(人物画像、偏好、事实、决策)"
            value={draft.content}
            onChange={(e) => setDraft({ ...draft, content: e.target.value })}
            rows={4}
          />
          <div className="mem-edit-actions">
            <button
              className="btn btn-accent btn-small"
              disabled={!draft.content.trim() || (draft.scope === 'project' && draft.projectId == null)}
              onClick={() => void save()}
            >
              保存
            </button>
            <button className="btn btn-small" onClick={() => setDraft(null)}>
              取消
            </button>
          </div>
        </div>
      )}

      <div className="mem-list">
        {filteredCount === 0 && (
          <div className="empty">
            {kindFilter !== 'all'
              ? '该分类暂无记忆'
              : '暂无记忆 — 通过 MCP memory_write、项目总结自动整理或手动新增'}
          </div>
        )}
        {multiProject
          ? projectGroups.map((g) => (
              <div key={g.key} className="mem-project-group">
                <div className="mem-project-head">
                  {g.label} <span className="count">{g.rows.length}</span>
                </div>
                {renderKindGroups(g.rows, 'mem-group mem-group-sub')}
              </div>
            ))
          : renderKindGroups(visibleRows, 'mem-group')}
        {hasMore && (
          <button className="btn btn-small" style={{ alignSelf: 'center' }} onClick={() => void loadMore()}>
            加载更多(已显示 {rows.length} 条)
          </button>
        )}
      </div>
      </div>
    </div>
  )
}
