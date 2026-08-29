import { useCallback, useEffect, useState } from 'react'
import { api } from './api'

interface MemoryRow {
  id: number
  kind: string
  content: string
  source: string | null
  status: string
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

  const load = useCallback(async () => {
    setRows((await api.memories()) as unknown as MemoryRow[])
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const save = useCallback(async () => {
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

  return (
    <div className="memories-pane">
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
        {msg && <span className="pane-msg">{msg}</span>}
      </div>

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
        {KINDS.map((kind) => {
          const group = rows.filter((r) => r.kind === kind)
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
  )
}
