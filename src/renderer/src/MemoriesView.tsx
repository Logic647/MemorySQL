import { useCallback, useEffect, useState } from 'react'
import { api } from './api'

interface MemoryRow {
  id: number
  kind: string
  content: string
  source: string | null
  status: string
  agentType: string | null
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
}

export default function MemoriesView() {
  const [rows, setRows] = useState<MemoryRow[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [msg, setMsg] = useState('')
  const [agentFilter, setAgentFilter] = useState<string>('all')
  const [kindFilter, setKindFilter] = useState<string>('all')
  const [refining, setRefining] = useState(false)
  const [detecting, setDetecting] = useState(false)
  const [conflicts, setConflicts] = useState<
    Array<{ aId: number; bId: number; reason: string; aExcerpt: string; bExcerpt: string }>
  >([])

  const load = useCallback(async (): Promise<void> => {
    setRows((await api.memories()) as unknown as MemoryRow[])
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const agents = [...new Set(rows.map((r) => r.agentType).filter((a): a is string => Boolean(a)))]
  const visible = rows.filter((r) => agentFilter === 'all' || r.agentType === agentFilter || (!r.agentType && agentFilter === 'global'))

  const save = useCallback(async (): Promise<void> => {
    if (!draft) return
    try {
      await api.memoriesSave({ id: draft.id, kind: draft.kind, content: draft.content })
      setDraft(null)
      setMsg('')
      await load()
    } catch (e) {
      setMsg(`保存失败: ${String(e)}`)
    }
  }, [draft, load])

  const refine = useCallback(async (): Promise<void> => {
    setRefining(true)
    try {
      const r = await api.memoriesRefine(agentFilter === 'all' ? undefined : agentFilter)
      setMsg(r.message)
      await load()
    } catch (e) {
      setMsg(`精炼失败: ${String(e)}`)
    } finally {
      setRefining(false)
    }
  }, [agentFilter, load])

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

  const kindRows = kindFilter === 'all' ? undefined : rows.filter((r) => r.kind === kindFilter)

  return (
    <div className="memories-pane">
      <aside className="sidebar mem-sidebar">
        <div className="side-section">
          <div className="side-title">分类</div>
          <button className={`side-item ${kindFilter === 'all' ? 'active' : ''}`} onClick={() => setKindFilter('all')}>
            全部 <span className="count">{rows.length}</span>
          </button>
          {KINDS.map((k) => (
            <button
              key={k}
              className={`side-item ${kindFilter === k ? 'active' : ''}`}
              onClick={() => setKindFilter(k)}
            >
              {KIND_LABEL[k]} <span className="count">{rows.filter((r) => r.kind === k).length}</span>
            </button>
          ))}
        </div>
        <div className="side-section">
          <div className="side-title">Agent</div>
          {['all', 'global', ...agents].map((a) => (
            <button key={a} className={`side-item ${agentFilter === a ? 'active' : ''}`} onClick={() => setAgentFilter(a)}>
              {a === 'all' ? '全部' : a === 'global' ? '全局' : a}
            </button>
          ))}
        </div>
      </aside>
      <div className="mem-main">
      <div className="pane-title">
        记忆 ({rows.length})
        <button className="btn btn-small" style={{ marginLeft: 12 }} onClick={() => setDraft({ kind: 'fact', content: '' })}>
          + 新增
        </button>
        <button
          className="btn btn-small"
          style={{ marginLeft: 6 }}
          onClick={() =>
            void api.dispatchGenerate().then(
              (r) => setMsg(`已生成分发文件: ${r.files.join(' , ')}`),
              (e) => setMsg(`生成失败: ${String(e)}`)
            )
          }
        >
          生成分发文件
        </button>
        <button className="btn btn-small" style={{ marginLeft: 6 }} disabled={refining} onClick={() => void refine()}>
          {refining ? '精炼中…' : 'LLM 精炼候选'}
        </button>
        <button className="btn btn-small" style={{ marginLeft: 6 }} disabled={detecting} onClick={() => void detect()}>
          {detecting ? '检测中…' : '冲突检测'}
        </button>
        <button
          className="btn btn-small"
          style={{ marginLeft: 6 }}
          onClick={() =>
            void api
              .memoriesConfirmAll(agentFilter === 'all' ? undefined : agentFilter)
              .then((r) => {
                setMsg(`已确认 ${r.confirmed} 条候选`)
                return load()
              })
              .catch((e) => setMsg(`确认失败: ${String(e)}`))
          }
        >
          确认候选
        </button>
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
          <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]} ({k})
              </option>
            ))}
          </select>
          <textarea
            placeholder="记忆内容…(人物画像、偏好、事实、决策)"
            value={draft.content}
            onChange={(e) => setDraft({ ...draft, content: e.target.value })}
            rows={4}
          />
          <div className="mem-edit-actions">
            <button className="btn btn-accent btn-small" disabled={!draft.content.trim()} onClick={() => void save()}>
              保存
            </button>
            <button className="btn btn-small" onClick={() => setDraft(null)}>
              取消
            </button>
          </div>
        </div>
      )}

      <div className="mem-list">
        {kindFilter !== 'all' && (kindRows?.length ?? 0) === 0 && (
          <div className="empty">该分类暂无记忆</div>
        )}
        {(kindFilter === 'all' ? KINDS : [kindFilter as (typeof KINDS)[number]]).map((kind) => {
          const group = visible.filter((r) => r.kind === kind)
          if (group.length === 0) return null
          return (
            <div key={kind}>
              <div className="mem-group">
                {KIND_LABEL[kind]} ({group.length})
              </div>
              {group.map((r) => (
                <div key={r.id} className={`mem-row ${r.status !== 'active' ? 'mem-retired' : ''}`}>
                  <pre className="mem-content">{r.content}</pre>
                  <div className="mem-meta">
                    <span className="mem-source">{r.source ?? 'manual'}</span>
                    {r.agentType && <span className="mono-tag">· {r.agentType}</span>}
                    {r.status !== 'active' && <span>· {r.status}</span>}
                    <span className="mem-actions">
                      <button className="link" onClick={() => setDraft({ id: r.id, kind: r.kind, content: r.content })}>
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
                      <button className="link danger" onClick={() => void api.memoriesDelete(r.id).then(load)}>
                        删除
                      </button>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )
        })}
        {rows.length === 0 && <div className="empty">暂无记忆 — 通过 MCP memory_write、Hermes 记忆导入或手动新增</div>}
      </div>
      </div>
    </div>
  )
}
