import { useCallback, useEffect, useRef, useState } from 'react'
import { EditorView, keymap } from '@codemirror/view'
import { Annotation } from '@codemirror/state'
import { basicSetup } from 'codemirror'
import { markdown } from '@codemirror/lang-markdown'
import { api } from './api'

interface NoteRow {
  id: number
  relPath: string
  title: string
  tags: string[]
  updatedAt: number
}

/** marks programmatic doc replacements so the dirty-flag ignores them */
const ExternalEdit = Annotation.define<boolean>()

const editorTheme = EditorView.theme(
  {
    '&': { backgroundColor: '#14171c', color: '#dee4ee', fontSize: '13.5px', height: '100%' },
    '.cm-content': { fontFamily: "'Cascadia Code', Consolas, monospace", caretColor: '#e2a93e' },
    '.cm-gutters': { backgroundColor: '#14171c', color: '#5c6980', border: 'none' },
    '.cm-activeLine': { backgroundColor: '#1a1f27' },
    '.cm-activeLineGutter': { backgroundColor: '#1a1f27' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: '#2b3342' },
    '.cm-panels': { backgroundColor: '#1a1f27', color: '#dee4ee' }
  },
  { dark: true }
)

export default function NotesView() {
  const [notes, setNotes] = useState<NoteRow[]>([])
  const [current, setCurrent] = useState<{ id: number; title: string; tags: string[] } | null>(null)
  const [backlinks, setBacklinks] = useState<Array<{ id: number; title: string }>>([])
  const [dirty, setDirty] = useState(false)
  const [msg, setMsg] = useState('')
  const [search, setSearch] = useState('')
  const editorRef = useRef<EditorView | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const currentIdRef = useRef<number | null>(null)
  const dirtyRef = useRef(false)

  const loadList = useCallback(async (): Promise<NoteRow[]> => {
    const rows = await api.notesList()
    setNotes(rows)
    return rows
  }, [])

  // create the editor once
  useEffect(() => {
    if (!containerRef.current || editorRef.current) return
    const view = new EditorView({
      parent: containerRef.current,
      extensions: [
        basicSetup,
        markdown(),
        EditorView.lineWrapping,
        editorTheme,
        keymap.of([
          {
            key: 'Mod-s',
            run: () => {
              void saveCurrent()
              return true
            }
          }
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && !u.transactions.some((t) => t.annotation(ExternalEdit))) setDirty(true)
        })
      ]
    })
    editorRef.current = view
    return () => {
      view.destroy()
      editorRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openNote = useCallback(async (id: number) => {
    const data = await api.notesGet(id)
    currentIdRef.current = id
    setCurrent({ id, title: data.note.title, tags: data.note.tags })
    editorRef.current?.dispatch({
      changes: { from: 0, to: editorRef.current.state.doc.length, insert: data.content },
      annotations: ExternalEdit.of(true)
    })
    setDirty(false)
    dirtyRef.current = false
    setBacklinks(await api.notesBacklinks(id))
  }, [])

  const saveCurrent = useCallback(async () => {
    const id = currentIdRef.current
    const view = editorRef.current
    if (!id || !view) return
    await api.notesSave(id, view.state.doc.toString())
    setDirty(false)
    dirtyRef.current = false
    setMsg(`已保存 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`)
    await loadList()
    setBacklinks(await api.notesBacklinks(id))
  }, [loadList])

  useEffect(() => {
    void loadList().then((rows) => {
      if (rows.length > 0 && currentIdRef.current === null) void openNote(rows[0].id)
    })
  }, [loadList, openNote])

  const filtered = notes.filter(
    (n) =>
      !search.trim() ||
      n.title.toLowerCase().includes(search.toLowerCase()) ||
      n.relPath.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="notes-view">
      <div className="notes-list">
        <div className="pane-title">
          笔记 ({notes.length})
          <button
            className="btn btn-small"
            style={{ marginLeft: 8 }}
            onClick={() => {
              const title = prompt('新笔记标题:')
              if (!title) return
              void api
                .notesCreate(title)
                .then((r) => loadList().then(() => openNote(r.id)))
                .catch((e) => setMsg(String(e)))
            }}
          >
            + 新建
          </button>
        </div>
        <input
          className="search notes-search"
          placeholder="筛选笔记…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="session-list">
          {filtered.map((n) => (
            <button
              key={n.id}
              className={`session ${current?.id === n.id ? 'note-active' : ''}`}
              data-agent="zcode"
              onClick={() => void openNote(n.id)}
            >
              <div className="session-head">
                <span className="session-title">{n.title}</span>
              </div>
              <div className="session-meta">
                <span>{n.relPath}</span>
              </div>
            </button>
          ))}
          {filtered.length === 0 && <div className="empty">无笔记 — vault/ 目录下的 .md 会自动索引</div>}
        </div>
      </div>

      <div className="notes-editor">
        {current ? (
          <>
            <div className="detail-head">
              <div className="detail-title">
                {current.title}
                {dirty && <span className="dirty-mark">● 未保存</span>}
                <button className="btn btn-accent btn-small" style={{ marginLeft: 'auto' }} onClick={() => void saveCurrent()}>
                  保存 (Ctrl+S)
                </button>
              </div>
              {current.tags.length > 0 && (
                <div className="detail-meta">
                  {current.tags.map((t) => (
                    <span key={t}>#{t}</span>
                  ))}
                </div>
              )}
            </div>
            <div ref={containerRef} className="cm-container" />
            <div className="backlinks">
              <div className="side-title">反向链接 ({backlinks.length})</div>
              {backlinks.map((b) => (
                <button key={b.id} className="link" onClick={() => void openNote(b.id)}>
                  {b.title}
                </button>
              ))}
              {backlinks.length === 0 && <span className="hint">暂无 — 用 [[笔记标题]] 链接此页</span>}
            </div>
            {msg && <div className="kb-msg" style={{ padding: '0 16px 8px' }}>{msg}</div>}
          </>
        ) : (
          <div className="empty detail-empty">左侧选择或新建笔记</div>
        )}
      </div>
    </div>
  )
}
