// MemorySQL 页面（由 service.mjs 提供，不在 magpie 的 sandbox 里）。
// 记忆页参考 magpie 的 Library → Memory：状态分段、搜索、模型选择、
// 从对话学习、整理、逐条确认/归档/编辑。
const state = {
  backend: '',
  agent: new URLSearchParams(location.search).get('agent') || '',
  view: 'memory',
  projects: [],
  selected: null,
  tab: 'context',
  mem: { status: 'active', scope: '', q: '', open: null, draft: null, data: null, removing: null, timer: 0 },
  distill: null,
  poll: 0
}

const KIND_OPTIONS = ['persona', 'preference', 'fact', 'decision']
const KIND_LABEL = { persona: '画像', preference: '偏好', fact: '事实', decision: '决策' }

const $ = (sel) => document.querySelector(sel)
const TOKEN =
  document.querySelector('meta[name="memorysql-token"]')?.getAttribute('content') ?? ''

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      accept: 'application/json',
      'x-memorysql-token': TOKEN,
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  })
  let data
  try {
    data = await res.json()
  } catch {
    throw new Error(`HTTP ${res.status}`)
  }
  if (!data || data.ok !== true) throw new Error(data?.error || `HTTP ${res.status}`)
  return data
}

function setStatus(text, kind = '') {
  const node = $('#status')
  node.textContent = text
  node.className = `pill ${kind}`.trim()
}

function notice(text) {
  const node = $('#unavailable')
  node.hidden = !text
  node.textContent = text || ''
}

function fmtDay(seconds) {
  return seconds ? new Date(seconds * 1000).toLocaleDateString('zh-CN') : ''
}

function ago(ms) {
  if (!ms) return ''
  const minutes = Math.floor((Date.now() - ms) / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

function firstLine(text) {
  const line = String(text ?? '')
    .split('\n')
    .find((l) => l.trim())
  return (line ?? '').trim()
}

// ----- 状态 / 视图 ---------------------------------------------------------

async function loadStatus() {
  try {
    const s = await api('api/status')
    state.backend = s.backend || 'embedded'
    const stats = s.stats || {}
    const bits = [s.backend === 'embedded' ? '内置存储' : `MemorySQL v${s.version || '?'}`]
    if (s.port) bits.push(`:${s.port}`)
    if (Number.isFinite(stats.sessions)) bits.push(`${stats.sessions} 会话`)
    if (Number.isFinite(stats.memories)) bits.push(`${stats.memories} 记忆`)
    if (Number.isFinite(stats.projects)) bits.push(`${stats.projects} 项目`)
    setStatus(bits.join(' · '), 'ok')
    if (state.backend !== 'embedded') {
      notice('app 后端：记忆管理请在 MemorySQL 应用里操作；这里仍可查看项目与搜索。')
      for (const sel of ['#view-memory .controls', '#view-memory .mem-bar']) {
        const node = $(sel)
        if (node) node.hidden = true
      }
      const list = $('#memList')
      if (list) list.replaceChildren(el('div', 'mem-none', 'app 后端：请到 MemorySQL 应用里管理记忆。'))
    } else {
      notice('')
      for (const sel of ['#view-memory .controls', '#view-memory .mem-bar']) {
        const node = $(sel)
        if (node) node.hidden = false
      }
    }
    return true
  } catch (err) {
    setStatus('未连接', 'bad')
    notice(`知识库不可用：${err.message}。`)
    return false
  }
}

function switchView(view) {
  state.view = view
  for (const name of ['memory', 'projects', 'search']) {
    const node = $(`#view-${name}`)
    if (node) node.hidden = name !== view
  }
  for (const tab of document.querySelectorAll('.mtab')) {
    tab.classList.toggle('active', tab.dataset.view === view)
  }
  if (view === 'memory' && state.backend === 'embedded') {
    void loadDistill()
    void loadMemory()
  }
  if (view === 'projects') void loadProjects()
  if (view === 'search') $('#query').focus()
}

// ----- 记忆：控制卡 --------------------------------------------------------

function modelName(id) {
  const model = (state.distill?.models || []).find((m) => m.id === id)
  return model ? model.name : id
}

function renderDistill() {
  const d = state.distill
  if (!d) return
  $('#distillOn').checked = !!d.on
  $('#dreamOn').checked = !!d.dream
  $('#autoDigest').checked = !!d.autoDigest
  $('#rangePick').value = String(d.days || 7)

  const pick = $('#modelPick')
  const current = d.model || ''
  pick.replaceChildren()
  const auto = el(
    'option',
    '',
    d.defaultModel ? `自动 · ${modelName(d.defaultModel)}` : '自动（magpie 记忆的模型）'
  )
  auto.value = ''
  pick.append(auto)
  for (const model of d.models || []) {
    const option = el('option', '', `${model.name}${model.provider ? ` · ${model.provider}` : ''}`)
    option.value = model.id
    pick.append(option)
  }
  if (current && !(d.models || []).some((m) => m.id === current)) {
    const option = el('option', '', current)
    option.value = current
    pick.append(option)
  }
  pick.value = current
  pick.disabled = (d.models || []).length === 0 && !current

  const distillRunning = d.running && d.job !== 'dream'
  const dreamRunning = d.running && d.job === 'dream'
  let line
  let bad = false
  if (!d.on && !distillRunning) line = '关闭'
  else if (distillRunning) {
    line = d.of ? `正在读取会话… ${d.doing || 0}/${d.of}` : '正在读取会话…'
    if (d.left) line += ` · 还剩 ${d.left} 条`
  } else if (d.error) {
    line = `上次失败：${d.error}`
    bad = true
  } else if (d.last) {
    line = `上次 ${ago(d.last)} · 新增 ${d.added || 0} 条`
    if (d.left) line += ` · 还有 ${d.left} 条未读`
  } else {
    line = '读取安静 30 分钟的会话，每小时一次'
  }
  const distillLine = $('#distillLine')
  distillLine.textContent = line
  distillLine.className = `sub${bad ? ' err' : ''}`

  const changes = Array.isArray(d.changes) ? d.changes : []
  const merged = changes.filter((c) => c.action === 'merge').length
  const archived = changes.length - merged
  let dreamLine
  let dreamBad = false
  if (!d.dream && !dreamRunning) dreamLine = '关闭'
  else if (dreamRunning) dreamLine = '整理中…'
  else if (d.dreamError) {
    dreamLine = `上次失败：${d.dreamError}`
    dreamBad = true
  } else if (d.dreamt) {
    dreamLine = `上次 ${ago(d.dreamt)} · 合并 ${merged} 条 / 归档 ${archived} 条`
  } else {
    dreamLine = '每晚 03:00 合并重复、归档过时'
  }
  const dreamEl = $('#dreamLine')
  dreamEl.textContent = dreamLine
  dreamEl.className = `sub${dreamBad ? ' err' : ''}`

  const hint = $('#distillHint')
  if ((d.models || []).length === 0) {
    hint.textContent = '没有可用模型：先在 magpie 里配置模型'
    hint.className = 'muted err'
  } else if (d.defaultModel) {
    hint.textContent = `默认模型：${modelName(d.defaultModel)}`
    hint.className = 'muted'
  } else {
    hint.textContent = ''
  }
}

async function loadDistill() {
  if (state.backend !== 'embedded') return
  try {
    const wasRunning = state.distill?.running === true
    state.distill = await api('api/distill')
    renderDistill()
    if (wasRunning && !state.distill.running) {
      if (state.view === 'memory') void loadMemory()
      void loadStatus()
    }
    if (state.distill.running) {
      clearTimeout(state.poll)
      state.poll = setTimeout(() => void loadDistill(), 1500)
    }
  } catch (err) {
    notice(`整理状态读取失败：${err.message}`)
  }
}

async function saveDistill(patch) {
  try {
    state.distill = await api('api/distill', { method: 'POST', body: patch })
    renderDistill()
    if (state.distill.running) void loadDistill()
  } catch (err) {
    notice(`设置失败：${err.message}`)
  }
}

async function runJob(path) {
  try {
    const res = await api(path, { method: 'POST', body: {} })
    if (res.running) {
      notice('已经有一轮在跑了，等它结束。')
      return
    }
    clearTimeout(state.poll)
    state.poll = setTimeout(() => void loadDistill(), 500)
  } catch (err) {
    notice(`启动失败：${err.message}`)
  }
}

// ----- 记忆：列表 ----------------------------------------------------------

function memQuery() {
  const qs = new URLSearchParams()
  qs.set('status', state.mem.status)
  if (state.mem.scope) qs.set('scope', state.mem.scope)
  if (state.mem.q.trim()) qs.set('q', state.mem.q.trim())
  qs.set('limit', '300')
  return qs.toString()
}

async function loadMemory() {
  if (state.backend !== 'embedded') return
  try {
    const data = await api(`api/memories?${memQuery()}`)
    state.mem.data = data
    renderMemBar()
    renderMemList()
  } catch (err) {
    notice(`记忆加载失败：${err.message}`)
  }
}

function renderMemBar() {
  const data = state.mem.data
  if (!data) return
  const counts = data.counts || {}
  for (const button of document.querySelectorAll('#memStatus button')) {
    const status = button.dataset.status
    const label = status === 'active' ? '使用中' : status === 'candidate' ? '待确认' : '已归档'
    const count = counts[status] || 0
    button.textContent = count ? `${label} · ${count}` : label
    button.classList.toggle('active', state.mem.status === status)
  }

  const scope = $('#memScope')
  const current = state.mem.scope
  scope.replaceChildren()
  const all = el('option', '', '全部作用域')
  all.value = ''
  scope.append(all)
  const global = el('option', '', '全局')
  global.value = 'global'
  scope.append(global)
  for (const project of data.projects || []) {
    const option = el('option', '', `项目 · ${project.name}`)
    option.value = `project:${project.id}`
    scope.append(option)
  }
  scope.value = current
}

function memRow(memory) {
  const open = state.mem.open === memory.id
  const row = el('div', `mem${open ? ' open' : ''}`)
  const head = el('div', 'mem-head')
  const main = el('div', 'mem-main')
  main.append(el('div', 'mem-name', open ? memory.text : firstLine(memory.text)))
  const scope = memory.scope === 'global' ? '全局' : memory.project ? `项目 · ${memory.project}` : '项目'
  const bits = [scope, ...(memory.tags || []).map((t) => `#${t}`)]
  if (memory.source === 'user') bits.push('手动')
  else if (memory.agent) bits.push(`来自 ${memory.agent}`)
  main.append(el('div', 'mem-sub', bits.join(' · ')))
  const tags = el('div', 'mem-tags')
  if (memory.source === 'user') tags.append(el('span', 'tag lock', '手写'))
  else if (memory.locked) tags.append(el('span', 'tag lock', '置顶'))
  tags.append(el('span', 'tag', KIND_LABEL[memory.kind] || memory.kind))
  head.append(main, tags, el('span', 'chev', '›'))
  head.addEventListener('click', () => {
    state.mem.removing = null
    state.mem.draft = null
    state.mem.open = open ? null : memory.id
    renderMemList()
  })
  row.append(head)
  if (open) row.append(memDetail(memory))
  return row
}

function memDetail(memory) {
  const data = state.mem.data || {}
  const projects = data.projects || []
  const draft =
    state.mem.draft ||
    (state.mem.draft = {
      id: memory ? memory.id : null,
      text: memory ? memory.text : '',
      kind: memory ? memory.kind : 'fact',
      scope: memory ? memory.scope : 'global',
      projectId: memory?.projectId ?? projects[0]?.id ?? null,
      tags: memory ? (memory.tags || []).join(', ') : '',
      why: memory?.why ?? ''
    })
  const box = el('div', 'mem-detail')
  const form = el('div', 'mem-form')

  const text = el('textarea', 'field')
  text.value = draft.text
  text.placeholder = '要记住什么，一句话，例如：这个仓库用 pnpm，不要用 npm'
  text.addEventListener('input', () => {
    draft.text = text.value
  })
  form.append(text)

  const line = el('div', 'mem-line')
  const kind = el('select', 'field select')
  for (const value of KIND_OPTIONS) {
    const option = el('option', '', KIND_LABEL[value])
    option.value = value
    kind.append(option)
  }
  kind.value = draft.kind
  kind.addEventListener('change', () => {
    draft.kind = kind.value
  })

  const scope = el('select', 'field select')
  const global = el('option', '', '全局')
  global.value = 'global'
  scope.append(global)
  const project = el('option', '', '项目')
  project.value = 'project'
  scope.append(project)
  scope.value = draft.scope
  scope.addEventListener('change', () => {
    draft.scope = scope.value
    projectPick.disabled = scope.value !== 'project'
  })

  const projectPick = el('select', 'field select')
  for (const item of projects) {
    const option = el('option', '', item.name)
    option.value = String(item.id)
    projectPick.append(option)
  }
  projectPick.value = draft.projectId != null ? String(draft.projectId) : String(projects[0]?.id ?? '')
  projectPick.disabled = draft.scope !== 'project'
  projectPick.addEventListener('change', () => {
    draft.projectId = Number(projectPick.value) || null
  })

  const tags = el('input', 'field grow')
  tags.type = 'text'
  tags.placeholder = '标签，用逗号分隔'
  tags.value = draft.tags
  tags.addEventListener('input', () => {
    draft.tags = tags.value
  })

  line.append(kind, scope, projectPick, tags)
  form.append(line)

  const why = el('input', 'field')
  why.type = 'text'
  why.placeholder = '为什么（可选，模型整理时会参考）'
  why.value = draft.why
  why.addEventListener('input', () => {
    draft.why = why.value
  })
  form.append(why)

  const acts = el('div', 'acts')
  if (memory) {
    if (memory.source !== 'user') {
      acts.append(
        button(memory.locked ? '取消置顶' : '置顶', async () => {
          await act('api/memories/pin', { id: memory.id, pinned: !memory.locked })
        })
      )
    }
    if (memory.status === 'candidate') {
      acts.append(button('确认', () => act('api/memories/status', { ids: [memory.id], status: 'active' })))
    } else if (memory.status === 'active') {
      acts.append(button('归档', () => act('api/memories/status', { ids: [memory.id], status: 'archived' })))
    } else {
      acts.append(button('恢复', () => act('api/memories/status', { ids: [memory.id], status: 'active' })))
    }
    const sure = state.mem.removing === memory.id
    acts.append(
      button(
        sure ? '确认删除' : '删除',
        () => {
          if (!sure) {
            state.mem.removing = memory.id
            renderMemList()
            return
          }
          state.mem.removing = null
          void act('api/memories/remove', { ids: [memory.id] })
        },
        sure ? 'danger-fill' : 'danger'
      )
    )
  }
  acts.append(el('span', 'grow'))
  acts.append(
    button('取消', () => {
      state.mem.open = null
      state.mem.draft = null
      state.mem.removing = null
      renderMemList()
    })
  )
  acts.append(
    button(
      memory ? '保存' : '记住',
      async () => {
        try {
          await api('api/memories', {
            method: 'POST',
            body: {
              id: draft.id ?? undefined,
              text: draft.text,
              kind: draft.kind,
              scope: draft.scope,
              projectId: draft.scope === 'project' ? draft.projectId : undefined,
              tags: draft.tags
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean),
              why: draft.why
            }
          })
          state.mem.open = null
          state.mem.draft = null
          await loadMemory()
        } catch (err) {
          notice(`保存失败：${err.message}`)
        }
      },
      'primary'
    )
  )
  form.append(acts)
  box.append(form)
  return box
}

function button(label, onClick, className = '') {
  const node = el('button', className, label)
  node.type = 'button'
  node.addEventListener('click', (event) => {
    event.stopPropagation()
    void onClick()
  })
  return node
}

async function act(path, body) {
  try {
    await api(path, { method: 'POST', body })
    await loadMemory()
  } catch (err) {
    notice(`操作失败：${err.message}`)
  }
}

function renderMemList() {
  const list = $('#memList')
  if (!list) return
  const data = state.mem.data
  if (!data) {
    list.replaceChildren(el('div', 'mem-none', '正在加载记忆…'))
    return
  }
  list.replaceChildren()
  if (state.mem.open === 'new') {
    const wrap = el('div', 'mem open')
    wrap.append(memDetail(null))
    list.append(wrap)
  }
  for (const memory of data.memories || []) list.append(memRow(memory))
  if (!(data.memories || []).length && state.mem.open !== 'new') {
    const text =
      state.mem.status === 'candidate'
        ? '没有待确认的记忆。'
        : state.mem.status === 'archived'
          ? '没有归档的记忆。'
          : '还没有记忆。可以告诉 agent「记住…」，或点右上角添加。'
    list.append(el('div', 'mem-none', text))
  }
}

// ----- 项目 ----------------------------------------------------------------

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
  for (const project of list) {
    const li = document.createElement('li')
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `project${state.selected?.id === project.id ? ' active' : ''}`
    const name = el('span', 'pname', project.name || `项目 #${project.id}`)
    const path = el('span', 'ppath', project.path || '')
    const meta = el(
      'em',
      '',
      `${project.sessions ?? 0} 个会话${project.lastActive ? ` · ${fmtDay(project.lastActive)}` : ''}`
    )
    btn.append(name, path, meta)
    btn.addEventListener('click', () => selectProject(project))
    li.append(btn)
    ul.append(li)
  }
  if (list.length === 0) ul.append(el('li', 'muted pad', '没有匹配的项目'))
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

function setGenerateVisible(visible) {
  const node = $('#digestGenerate')
  if (node) node.hidden = !visible
}

async function loadTab() {
  if (!state.selected) return
  const body = $('#detailBody')
  body.classList.remove('empty')
  body.textContent = '加载中…'
  const project = projectArg()
  try {
    if (state.tab === 'sessions') {
      setGenerateVisible(false)
      const qs = new URLSearchParams({ project, limit: '30' })
      if (state.agent) qs.set('agent', state.agent)
      const data = await api(`api/sessions?${qs.toString()}`)
      renderSessions(data.sessions)
      return
    }
    setGenerateVisible(state.tab === 'digest')
    const qs = new URLSearchParams({ project })
    if (state.agent) qs.set('agent', state.agent)
    const path = state.tab === 'digest' ? 'api/digest' : 'api/context'
    const data = await api(`${path}?${qs.toString()}`)
    const pre = el('pre', 'result', data.text || '(没有内容)')
    body.replaceChildren(pre)
  } catch (err) {
    body.textContent = `加载失败：${err.message}`
  }
}

function renderSessions(sessions) {
  const body = $('#detailBody')
  const wrap = el('div', 'sessions')
  const list = Array.isArray(sessions) ? sessions : []
  for (const session of list) {
    const btn = el('button', 'session')
    btn.type = 'button'
    btn.append(
      el('strong', '', session.title || `会话 #${session.id}`),
      el(
        'span',
        '',
        `${session.agent || '?'} · ${fmtDay(session.lastMessageAt || session.startedAt)} · ${
          session.messageCount ?? 0
        } 条`
      )
    )
    btn.addEventListener('click', () => void openSession(session.id))
    wrap.append(btn)
  }
  if (list.length === 0) wrap.append(el('p', 'muted', '这个项目还没有会话。'))
  body.replaceChildren(wrap)
}

async function openSession(id) {
  const body = $('#detailBody')
  body.textContent = '加载中…'
  try {
    const data = await api(`api/session?id=${encodeURIComponent(id)}&tail=200`)
    const back = el('button', 'back', '← 返回')
    back.type = 'button'
    back.addEventListener('click', () => void loadTab())
    body.replaceChildren(back, el('pre', 'result', data.text || '(空会话)'))
  } catch (err) {
    body.textContent = `读取失败：${err.message}`
  }
}

async function generateDigest() {
  if (!state.selected) return
  const btn = $('#digestGenerate')
  const old = btn.textContent
  btn.disabled = true
  btn.textContent = '生成中…'
  try {
    const data = await api('api/digest/generate', {
      method: 'POST',
      body: { project: projectArg() }
    })
    if (data.ok === false) throw new Error(data.error || '生成失败')
    await loadTab()
  } catch (err) {
    notice(`项目总结生成失败：${err.message}`)
  } finally {
    btn.disabled = false
    btn.textContent = old
  }
}

// ----- 搜索 ----------------------------------------------------------------

function wire() {
  for (const tab of document.querySelectorAll('.mtab')) {
    tab.addEventListener('click', () => switchView(tab.dataset.view || 'memory'))
  }
  $('#refresh').addEventListener('click', async () => {
    await loadStatus()
    if (state.view === 'memory') {
      await loadDistill()
      await loadMemory()
    } else if (state.view === 'projects') {
      await loadProjects()
      if (state.selected) await loadTab()
    }
  })

  // memory controls
  $('#distillOn').addEventListener('change', (event) => {
    void saveDistill({ on: event.target.checked })
  })
  $('#dreamOn').addEventListener('change', (event) => {
    void saveDistill({ dream: event.target.checked })
  })
  $('#autoDigest').addEventListener('change', (event) => {
    void saveDistill({ autoDigest: event.target.checked })
  })
  $('#modelPick').addEventListener('change', (event) => {
    void saveDistill({ model: event.target.value })
  })
  $('#rangePick').addEventListener('change', (event) => {
    void saveDistill({ days: Number(event.target.value) })
  })
  $('#distillRun').addEventListener('click', () => void runJob('api/distill/run'))
  $('#dreamRun').addEventListener('click', () => void runJob('api/dream/run'))
  $('#memAdd').addEventListener('click', () => {
    state.mem.open = 'new'
    state.mem.draft = null
    state.mem.removing = null
    renderMemList()
  })
  $('#memSearch').addEventListener('input', (event) => {
    state.mem.q = event.target.value
    clearTimeout(state.mem.timer)
    state.mem.timer = setTimeout(() => void loadMemory(), 250)
  })
  $('#memScope').addEventListener('change', (event) => {
    state.mem.scope = event.target.value
    void loadMemory()
  })
  for (const button of document.querySelectorAll('#memStatus button')) {
    button.addEventListener('click', () => {
      state.mem.status = button.dataset.status || 'active'
      state.mem.open = null
      state.mem.draft = null
      void loadMemory()
    })
  }

  // projects
  $('#filter').addEventListener('input', renderProjects)
  for (const tab of document.querySelectorAll('#view-projects .tab')) {
    tab.addEventListener('click', () => {
      for (const other of document.querySelectorAll('#view-projects .tab')) {
        other.classList.toggle('active', other === tab)
      }
      state.tab = tab.dataset.tab || 'context'
      void loadTab()
    })
  }
  $('#digestGenerate').addEventListener('click', () => void generateDigest())

  // search
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
  const ok = await loadStatus()
  if (ok) switchView('memory')
})()
