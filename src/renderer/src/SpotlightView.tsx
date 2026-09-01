import { useCallback, useEffect, useRef, useState } from 'react'
import type { SearchHit } from '../../shared/types'
import { api } from './api'

const KIND_LABEL: Record<SearchHit['kind'], string> = {
  session: '会话',
  message: '消息',
  memory: '记忆',
  note: '笔记'
}

/**
 * Spotlight quick-search surface (?spotlight=1), hosted in a frameless
 * always-on-top window. Enter/click on a session or message hands the id to
 * the main window via memorysql:host:openSession; Escape hides the window.
 */
export default function SpotlightView(): React.JSX.Element {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const off = window.memorysql.on('push:spotlight-shown', () => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    inputRef.current?.focus()
    return off
  }, [])

  useEffect(() => {
    if (!q.trim()) {
      setHits([])
      return
    }
    const t = setTimeout(() => {
      void api
        .search(q)
        .then((h) => setHits(h.slice(0, 10)))
        .catch(() => setHits([]))
    }, 200)
    return () => clearTimeout(t)
  }, [q])

  const open = useCallback((h: SearchHit | undefined): void => {
    if (!h) return
    if ((h.kind === 'session' || h.kind === 'message') && h.sessionId != null) {
      void window.memorysql.invoke('memorysql:host:openSession', { id: h.sessionId })
    } else {
      // memories/notes: bring the main window up (no deep link yet)
      void window.memorysql.invoke('memorysql:host:openSession', { id: 0 })
    }
  }, [])

  return (
    <div className="spotlight">
      <div className="aurora" aria-hidden />
      <input
        ref={inputRef}
        className="spotlight-input"
        placeholder="秒搜:会话 / 消息 / 记忆 / 笔记…(Enter 打开第一条,Esc 关闭)"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') void window.memorysql.invoke('memorysql:host:hideSpotlight')
          if (e.key === 'Enter') open(hits[0])
        }}
      />
      <div className="spotlight-list">
        {hits.map((h) => (
          <button key={`${h.kind}-${h.id}`} className="spotlight-hit" onClick={() => open(h)}>
            <span className="hit-kind">{KIND_LABEL[h.kind]}</span>
            <span className="spotlight-title">
              {h.title || (h.kind === 'memory' ? h.snippet.slice(0, 40) : '(无标题)')}
              {h.sessionId != null ? ` · 会话 #${h.sessionId}` : ''}
            </span>
            <span className="spotlight-snippet">{h.snippet.replace(/\n/g, ' ')}</span>
          </button>
        ))}
        {q.trim() && hits.length === 0 && <div className="spotlight-empty">无匹配结果</div>}
      </div>
    </div>
  )
}
