import { useCallback, useEffect, useRef, useState } from 'react'
import cytoscape from 'cytoscape'
import { api } from './api'

export default function GraphView() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  // the cytoscape instance is held here so a re-render destroys the previous
  // one first — dropping it leaks the whole graph (canvas DOM + listeners)
  const cyRef = useRef<cytoscape.Core | null>(null)
  const [stats, setStats] = useState<{ nodes: number; edges: number } | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  const render = useCallback(async () => {
    const { nodes, edges } = await api.notesGraph()
    setStats({ nodes: nodes.length, edges: edges.length })
    if (!containerRef.current) return
    cyRef.current?.destroy()
    cyRef.current = null
    const cy = cytoscape({
      container: containerRef.current,
      elements: [
        ...nodes.map((n) => ({
          data: { id: String(n.id), label: n.title },
          classes: n.id % 2 === 0 ? 'even' : 'odd'
        })),
        ...edges.map((e, i) => ({
          data: { id: `e${i}`, source: String(e.from), target: String(e.to) }
        }))
      ],
      style: [
        {
          selector: 'node',
          style: {
            label: 'data(label)',
            'background-color': '#34d399',
            'background-opacity': 0.9,
            'font-size': 9,
            color: '#f8fafc',
            'text-valign': 'bottom',
            'text-margin-y': 4,
            width: 14,
            height: 14,
            'font-family': 'Segoe UI, Microsoft YaHei'
          }
        },
        {
          selector: 'edge',
          style: {
            width: 1.2,
            'line-color': 'rgba(148, 163, 184, 0.25)',
            'curve-style': 'bezier',
            'target-arrow-color': 'rgba(148, 163, 184, 0.25)',
            'target-arrow-shape': 'triangle'
          }
        },
        {
          selector: 'node:selected',
          style: { 'background-color': '#7dd3fc', 'font-size': 12 }
        }
      ],
      layout: { name: 'cose', animate: false, padding: 30, idealEdgeLength: 90 },
      wheelSensitivity: 0.2
    })
    cy.on('tap', 'node', (evt) => setSelected(String(evt.target.data('label'))))
    cyRef.current = cy
  }, [])

  useEffect(() => {
    void render()
    return () => {
      cyRef.current?.destroy()
      cyRef.current = null
    }
  }, [render])

  return (
    <div className="graph-view">
      <aside className="sidebar graph-sidebar">
        <div className="side-section">
          <div className="side-title">知识图谱</div>
          <div className="kb-stat">笔记为节点,[[双链]]为边。</div>
          <div className="kb-stat">缩放/拖拽画布,点选节点高亮关联。</div>
          {stats && (
            <div className="kb-stat">
              节点 {stats.nodes} · 边 {stats.edges}
            </div>
          )}
        </div>
        <div className="side-section">
          <div className="side-title">操作</div>
          <button className="btn btn-small" onClick={() => void render()}>
            重新布局
          </button>
        </div>
      </aside>
      <div className="graph-main">
      <div className="pane-title">
        知识图谱 {stats ? `· ${stats.nodes} 节点 / ${stats.edges} 链接` : ''}
        {selected && <span className="pane-msg">选中: {selected}</span>}
        <button className="btn btn-small" style={{ marginLeft: 'auto' }} onClick={() => void render()}>
          重新布局
        </button>
      </div>
      <div ref={containerRef} className="graph-container" />
      {stats && stats.nodes === 0 && <div className="empty">vault/ 下还没有笔记 — 到「笔记」视图新建,用 [[标题]] 建立链接</div>}
      </div>
    </div>
  )
}
