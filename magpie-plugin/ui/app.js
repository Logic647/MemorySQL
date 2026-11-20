// MemorySQL 页面（由 service.mjs 提供，不在 magpie 的 sandbox 里）。
// 只读：状态、项目、续接包/总结/会话、跨 agent 搜索。
const state = {
  projects: [],
  selected: null,
  tab: 'context',
  agent: new URLSearchParams(location.search).get('agent') || ''
}

const $ = (sel) => document.querySelector(sel)
const TOKEN =
  document.querySelector('meta[name="memorysql-token"]')?.getAttribute('content') ?? ''

async function api(path) {
  const res = await fetch(path, {
    headers: { accept: 'application/json', 'x-memorysql-token': TOKEN }
  })
  let body
  try {
    body = await res.json()
  } catch {
    throw new Error(`HTTP ${res.status}`)
  }
  if (!body || body.ok !== true) throw new Error(body?.error || `HTTP ${res.status}`)
  return body
}

function setStatus(text, kind = '') {
  const el = $('#status')
  el.textContent = text
  el.className = `pill ${kind}`.trim()
}

function fmtDay(seconds) {
  return seconds ? new Date(seconds * 1000).toLocaleDateString('zh-CN') : ''
}

function notice(text) {
  const el = $('#unavailable')
  el.hidden = !text
  el.textContent = text || ''
}

async function loadStatus() {
  try {
    const s = await api('api/status')
    const stats = s.stats || {}
    const bits = [s.backend === 'embedded' ? '内置存储' : `MemorySQL v${s.version || '?'}`]
    if (s.port) bits.push(`:${s.port}`)
    if (Number.isFinite(stats.sessions)) bits.push(`${stats.sessions} 会话`)
    if (Number.isFinite(stats.memories)) bits.push(`${stats.memories} 记忆`)
    if (Number.isFinite(stats.projects)) bits.push(`${stats.projects} 项目`)
    setStatus(bits.join(' · '), 'ok')
    notice('')
    return true
  } catch (err) {
    setStatus('未连接', 'bad')
    notice(`知识库不可用：${err.message}。`)
    return false
  }
}

async function loadProjects() {
  try {
    const body = await api('api/projects?limit=100')
    state.projects = Array.isArray(body.projects) ? body.projects : []
    renderProjects()
  } catch (err) {
    notice(`项目加载失败：${err.message}`)
  }
}

function renderProjects() {
  const filter = $('#filter').value.trim().toLowerCase()
  const list = state.projects.filter((p) => {
    if (!filter) return true
    return `${p.name ?? ''} ${p.path ?? ''}`.toLowerCase().includes(filter)
  })
  $('#projectCount').textContent = `(${state.projects.length})`
  const ul = $('#projectList')
  ul.replaceChildren()
  for (const p of list) {
    const li = document.createElement('li')
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `project${state.selected?.id === p.id ? ' active' : ''}`
    const name = document.createElement('span')
    name.className = 'pname'
    name.textContent = p.name || `项目 #${p.id}`
    const path = document.createElement('span')
    path.className = 'ppath'
    path.textContent = p.path || ''
    const meta = document.createElement('em')
    meta.textContent = `${p.sessions ?? 0} 个会话${p.lastActive ? ` · ${fmtDay(p.lastActive)}` : ''}`
    btn.append(name, path, meta)
    btn.addEventListener('click', () => selectProject(p))
    li.append(btn)
    ul.append(li)
  }
  if (list.length === 0) {
    const li = document.createElement('li')
    li.className = 'muted pad'
    li.textContent = '没有匹配的项目'
    ul.append(li)
  }
}

function projectArg() {
  return state.selected ? state.selected.path || state.selected.name : ''
}

async function selectProject(project) {
  state.selected = project
  $('#detailTitle').textContent = project.name || `项目 #${project.id}`
  renderProjects()
  await loadTab()
}

async function loadTab() {
  if (!state.selected) return
  const body = $('#detailBody')
  body.classList.remove('empty')
  body.textContent = '加载中…'
  const project = projectArg()
  try {
    if (state.tab === 'sessions') {
      const qs = new URLSearchParams({ project, limit: '30' })
      if (state.agent) qs.set('agent', state.agent)
      const data = await api(`api/sessions?${qs.toString()}`)
      renderSessions(data.sessions)
      return
    }
    const qs = new URLSearchParams({ project })
    if (state.agent) qs.set('agent', state.agent)
    const path = state.tab === 'digest' ? 'api/digest' : 'api/context'
    const data = await api(`${path}?${qs.toString()}`)
    const pre = document.createElement('pre')
    pre.className = 'result'
    pre.textContent = data.text || '(没有内容)'
    body.replaceChildren(pre)
  } catch (err) {
    body.textContent = `加载失败：${err.message}`
  }
}

function renderSessions(sessions) {
  const body = $('#detailBody')
  const wrap = document.createElement('div')
  wrap.className = 'sessions'
  const list = Array.isArray(sessions) ? sessions : []
  for (const s of list) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'session'
    const title = document.createElement('strong')
    title.textContent = s.title || `会话 #${s.id}`
    const meta = document.createElement('span')
    meta.textContent = `${s.agent || '?'} · ${fmtDay(s.lastMessageAt || s.startedAt)} · ${s.messageCount ?? 0} 条`
    btn.append(title, meta)
    btn.addEventListener('click', () => openSession(s.id))
    wrap.append(btn)
  }
  if (list.length === 0) {
    const p = document.createElement('p')
    p.className = 'muted'
    p.textContent = '这个项目还没有会话。'
    wrap.append(p)
  }
  body.replaceChildren(wrap)
}

async function openSession(id) {
  const body = $('#detailBody')
  body.textContent = '加载中…'
  try {
    const data = await api(`api/session?id=${encodeURIComponent(id)}&tail=200`)
    const back = document.createElement('button')
    back.type = 'button'
    back.className = 'back'
    back.textContent = '← 返回'
    back.addEventListener('click', () => loadTab())
    const pre = document.createElement('pre')
    pre.className = 'result'
    pre.textContent = data.text || '(空会话)'
    body.replaceChildren(back, pre)
  } catch (err) {
    body.textContent = `读取失败：${err.message}`
  }
}

function wire() {
  $('#filter').addEventListener('input', renderProjects)
  $('#refresh').addEventListener('click', async () => {
    await loadStatus()
    await loadProjects()
    if (state.selected) await loadTab()
  })
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      for (const other of document.querySelectorAll('.tab')) other.classList.toggle('active', other === tab)
      state.tab = tab.dataset.tab || 'context'
      void loadTab()
    })
  }
  $('#searchForm').addEventListener('submit', async (event) => {
    event.preventDefault()
    const query = $('#query').value.trim()
    if (!query) return
    const out = $('#searchResult')
    out.hidden = false
    out.textContent = '搜索中…'
    const qs = new URLSearchParams({ q: query })
    if (state.agent) qs.set('agent', state.agent)
    if (state.selected) qs.set('project', projectArg())
    try {
      const data = await api(`api/search?${qs.toString()}`)
      out.textContent = data.text || '(没有结果)'
    } catch (err) {
      out.textContent = `搜索失败：${err.message}`
    }
  })
  if (state.agent) {
    const chip = $('#agentChip')
    chip.hidden = false
    chip.textContent = `agent: ${state.agent}`
  }
}

wire()
void (async () => {
  await loadStatus()
  await loadProjects()
})()
