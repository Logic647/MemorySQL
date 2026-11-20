// MemorySQL 页面（由 service.mjs 提供，不在 magpie 的 sandbox 里）。
// 记忆页：状态分段、搜索、项目总结、整理记忆、记忆注入、逐条确认/归档/编辑。
const state = {
  backend: '',
  agent: new URLSearchParams(location.search).get('agent') || '',
  view: 'memory',
  projects: [],
  selected: null,
  tab: 'context',
  mem: { status: 'active', scope: '', q: '', open: null, draft: null, data: null, removing: null, timer: 0 },
  sess: { removing: null },
  search: { scope: '' },
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

// 页面 token 每次宿主启动都会换：旧页面调 API 会 401。自动重载一次拿新 token；
// fresh 时间戳兼作防循环（<5s 内不再重载，避免服务真不可用时来回刷）。
function reloadForToken() {
  try {
    const url = new URL(location.href)
    const at = Number(url.searchParams.get('fresh') || 0)
    if (Date.now() - at < 5000) return false
    url.searchParams.set('fresh', String(Date.now()))
    // 从搜索页触发的重载：把视图/关键词/范围带过去，重载后自动重搜
    if (state.view === 'search') {
      url.searchParams.set('view', 'search')
      const query = ($('#query')?.value || '').trim()
      if (query) url.searchParams.set('q', query)
      if (state.search.scope) url.searchParams.set('scope', state.search.scope)
    }
    location.replace(url.toString())
    return true
  } catch {
    return false
  }
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
  if (!data || data.ok !== true) {
    const message = data?.error || `HTTP ${res.status}`
    if ((res.status === 401 || /unauthorized/i.test(message)) && reloadForToken()) {
      throw new Error('页面已过期，正在重新载入…')
    }
    throw new Error(message)
  }
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
  if (view === 'search') {
    if (!state.projects.length) void loadProjects()
    renderSearchScope()
    $('#query').focus()
  }
}

// ----- 记忆：控制卡 --------------------------------------------------------

function modelName(id) {
  const model = (state.distill?.models || []).find((m) => m.id === id)
  return model ? model.name : id
}

function renderDistill() {
  const d = state.distill
  if (!d) return
  $('#digestOn').checked = !!d.digestOn
  $('#dreamOn').checked = !!d.dream
  $('#quietPick').value = String(d.digestQuietMinutes || 30)
  $('#dreamEvery').value = String(d.dreamEveryHours || 24)

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

  const digestRunning = d.running && d.job === 'digest'
  const dreamRunning = d.running && d.job === 'dream'
  const noModels = (d.models || []).length === 0 && !current
  let digestLine
  let digestBad = false
  if (noModels) {
    digestLine = '没有可用模型：先在 magpie 里配置模型'
    digestBad = true
  } else if (digestRunning) {
    digestLine = '正在生成项目总结…'
  } else if (d.digestError) {
    digestLine = `上次失败：${d.digestError}`
    digestBad = true
  } else if (d.digestLast) {
    digestLine = `上次生成 ${ago(d.digestLast)} · 更新 ${d.digestAdded || 0} 个项目`
  } else {
    digestLine = `安静期 ${d.digestQuietMinutes || 30} 分钟；会话安静后自动生成`
  }
  if (!d.digestOn && !digestRunning && !noModels) digestLine = `关闭 · ${digestLine}`
  const digestEl = $('#digestLine')
  digestEl.textContent = digestLine
  digestEl.className = `sub${digestBad ? ' err' : ''}`

  const changes = Array.isArray(d.changes) ? d.changes : []
  const merged = changes.filter((c) => c.action === 'merge').length
  const archived = changes.length - merged
  let dreamLine
  let dreamBad = false
  if (dreamRunning) dreamLine = '整理中…'
  else if (d.dreamError) {
    dreamLine = `上次失败：${d.dreamError}`
    dreamBad = true
  } else if (d.dreamt) {
    dreamLine = `上次整理 ${ago(d.dreamt)}${
      merged || archived ? ` · 合并 ${merged} 条 / 归档 ${archived} 条` : ' · 没有需要变更的记忆'
    }`
  } else {
    dreamLine = `每 ${d.dreamEveryHours || 24} 小时整理一次`
  }
  if (!d.dream && !dreamRunning) dreamLine = `关闭 · ${dreamLine}`
  const dreamEl = $('#dreamLine')
  dreamEl.textContent = dreamLine
  dreamEl.className = `sub${dreamBad ? ' err' : ''}`

  $('#digestRun').disabled = !!d.running
  $('#dreamRun').disabled = !!d.running
  renderInject()

  const hint = $('#distillHint')
  if (hint) {
    hint.hidden = true
    hint.textContent = ''
  }
}

const AGENT_LABEL = {
  claudecode: 'Claude Code',
  codex: 'Codex',
  zcode: 'ZCode',
  opencode: 'OpenCode',
  gemini: 'Gemini CLI',
  qwencode: 'Qwen Code',
  kimicli: 'Kimi CLI',
  codebuddy: 'CodeBuddy',
  workbuddy: 'WorkBuddy',
  qoder: 'Qoder',
  dsh: 'DeepSeek Harness',
  hermes: 'Hermes',
  goose: 'Goose',
  droid: 'Droid',
  cline: 'Cline',
  pi: 'Pi',
  omp: 'omp',
  omo: 'OmO',
  grok: 'Grok Build',
  minimax: 'MiniMax',
  deveco: 'DevEco',
  mimocode: 'MiMo',
  copilot: 'Copilot',
  cursor: 'Cursor',
  node: 'Node',
  bun: 'Bun',
  magpie: 'magpie'
}

// 「记忆注入」：开关 + 注入到哪些 agent（全部 / 指定，指定为空 = 不注入）。
function renderInject() {
  const d = state.distill
  if (!d) return
  const on = d.inject === true
  $('#injectOn').checked = on
  $('#injectPick').hidden = !on
  const agents = Array.isArray(d.agents) ? d.agents : []
  const picked = Array.isArray(d.injectAgents) ? d.injectAgents : []
  const all = d.injectAll !== false
  $('#injectAll').checked = all
  const box = $('#injectAgents')
  box.replaceChildren()
  for (const agent of agents) {
    const label = el('label', 'check agent-pick')
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = all || picked.includes(agent.id)
    input.addEventListener('change', () => {
      // 在「全部」状态下取消某个 agent：先展开成完整列表再减掉它
      const base = all ? agents.map((item) => item.id) : [...picked]
      const next = new Set(base)
      if (input.checked) next.add(agent.id)
      else next.delete(agent.id)
      const ids = [...next]
      // 全部选中（且非空）就回到「全部」；0 个 = 不注入，不能再变成全部
      const allNow = ids.length > 0 && ids.length === agents.length
      void saveDistill({ injectAll: allNow, injectAgents: allNow ? [] : ids })
    })
    const display = (agent.magpie && agent.name) || AGENT_LABEL[agent.id] || agent.name || agent.id
    label.title = `${display} · ${agent.sessions || 0} 场会话${
      agent.lastAt ? ` · ${fmtDay(agent.lastAt)}` : ''
    }${agent.magpie ? ' · magpie 已识别' : ''}`
    label.append(input, display)
    box.append(label)
  }
  if (!agents.length) box.append(el('span', 'muted', 'magpie 还没识别到 agent'))
  $('#injectLine').textContent = !on
    ? '关闭（默认）'
    : all
      ? '开启 · 全部 agent'
      : picked.length
        ? `开启 · ${picked.length} 个 agent`
        : '开启 · 未选 agent（不会注入）'
  $('#injectLine').className = 'sub'
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
  kind.title = '记忆类型：画像 / 偏好 / 事实 / 决策'
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
  scope.title = '全局记忆所有项目都能用；项目记忆只在该项目续接时出现'
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
  projectPick.title = '项目记忆归属的项目'
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
  tags.title = '标签也会进搜索；最多 10 个'
  tags.value = draft.tags
  tags.addEventListener('input', () => {
    draft.tags = tags.value
  })

  line.append(kind, scope, projectPick, tags)
  form.append(line)

  const why = el('input', 'field')
  why.type = 'text'
  why.placeholder = '为什么（可选，模型整理时会参考）'
  why.title = '为什么记这条；模型整理/合并时会参考'
  why.value = draft.why
  why.addEventListener('input', () => {
    draft.why = why.value
  })
  form.append(why)

  const acts = el('div', 'acts')
  if (memory) {
    if (memory.source !== 'user') {
      acts.append(
        button(
          memory.locked ? '取消置顶' : '置顶',
          async () => {
            await act('api/memories/pin', { id: memory.id, pinned: !memory.locked })
          },
          '',
          '置顶（锁定）后，模型整理永远不会改动这条'
        )
      )
    }
    if (memory.status === 'candidate') {
      acts.append(
        button(
          '确认',
          () => act('api/memories/status', { ids: [memory.id], status: 'active' }),
          '',
          '确认这条候选；确认后才会进入续接包'
        )
      )
    } else if (memory.status === 'active') {
      acts.append(
        button(
          '归档',
          () => act('api/memories/status', { ids: [memory.id], status: 'archived' }),
          '',
          '归档后不再进入续接包（可随时恢复）'
        )
      )
    } else {
      acts.append(
        button(
          '恢复',
          () => act('api/memories/status', { ids: [memory.id], status: 'active' }),
          '',
          '恢复为「使用中」，重新进入续接包'
        )
      )
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
        sure ? 'danger-fill' : 'danger',
        sure ? '再点一次彻底删除这条记忆' : '删除这条记忆（打 deleted 标记，不再出现在搜索/续接包）'
      )
    )
  }
  acts.append(el('span', 'grow'))
  acts.append(
    button(
      '取消',
      () => {
        state.mem.open = null
        state.mem.draft = null
        state.mem.removing = null
        renderMemList()
      },
      '',
      '放弃这次编辑'
    )
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
      'primary',
      memory ? '保存修改（这条会标记为手写，整理不会改动）' : '写入本地记忆库（手写记忆，整理不会改动）'
    )
  )
  form.append(acts)
  box.append(form)
  return box
}

function button(label, onClick, className = '', title = '') {
  const node = el('button', className, label)
  if (title) node.title = title
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
    const query = state.mem.q.trim()
    if (query) {
      const empty = el('div', 'mem-none', `没有匹配「${query}」的记忆。`)
      empty.append(
        document.createElement('br'),
        button(
          '去搜索会话和消息',
          () => {
            state.mem.q = ''
            const input = $('#memSearch')
            if (input) input.value = ''
            state.search.scope = ''
            switchView('search')
            $('#query').value = query
            $('#searchForm').requestSubmit()
          },
          'ghost',
          '到「搜索」页在会话标题、消息和记忆里搜同样的关键词'
        )
      )
      list.append(empty)
    } else {
      const text =
        state.mem.status === 'candidate'
          ? '没有待确认的记忆。'
          : state.mem.status === 'archived'
            ? '没有归档的记忆。'
            : '还没有记忆。可以告诉 agent「记住…」，或点右上角添加。'
      list.append(el('div', 'mem-none', text))
    }
  }
}

// ----- 项目 ----------------------------------------------------------------

async function loadProjects() {
  try {
    const body = await api('api/projects?limit=100')
    state.projects = Array.isArray(body.projects) ? body.projects : []
    renderProjects()
    renderSearchScope()
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
    const row = el('div', 'session-row')
    const btn = el('button', 'session')
    btn.type = 'button'
    btn.title = `打开会话 #${session.id}，看最近 200 条消息`
    const title = el('strong', '', session.title || `会话 #${session.id}`)
    const meta = el('span', '')
    meta.append(
      el('b', 'sid', `#${session.id}`),
      ` · ${session.agent || '?'} · ${fmtDay(session.lastMessageAt || session.startedAt)} · ${
        session.messageCount ?? 0
      } 条`
    )
    btn.append(title, meta)
    btn.addEventListener('click', () => void openSession(session.id, session.title))
    row.append(btn)

    const sure = state.sess.removing === session.id
    row.append(
      button(
        sure ? '确认删除' : '删除',
        () => {
          if (!sure) {
            state.sess.removing = session.id
            renderSessions(list)
            return
          }
          state.sess.removing = null
          void removeSession(session.id)
        },
        `session-del${sure ? ' danger-fill' : ''}`,
        sure
          ? '再点一次彻底删除这个会话'
          : `删除会话 #${session.id}：不再出现在列表/搜索/续接包；同一会话后续回写默认不会恢复`
      )
    )
    wrap.append(row)
  }
  if (list.length === 0) {
    wrap.append(
      el('p', 'muted', '这个项目还没有会话。agent 经 magpie 网关跑一轮后，对话会自动回写到这里。')
    )
  }
  body.replaceChildren(wrap)
}

async function removeSession(id) {
  try {
    await api('api/sessions/remove', { method: 'POST', body: { ids: [id] } })
    await loadTab()
    await loadStatus()
    void loadProjects()
    notice(`已删除会话 #${id}：不会再出现在列表、搜索或续接包里。`)
  } catch (err) {
    notice(`删除失败：${err.message}`)
  }
}

async function openSession(id, title) {
  const body = $('#detailBody')
  body.textContent = '加载中…'
  try {
    const data = await api(`api/session?id=${encodeURIComponent(id)}&tail=200`)
    const back = el('button', 'back', '← 返回会话列表')
    back.type = 'button'
    back.title = '回到该项目的会话列表'
    back.addEventListener('click', () => void loadTab())
    const head = el('div', 'session-detail-head')
    head.append(el('strong', '', title || `会话 #${id}`), el('b', 'sid', `#${id}`))
    body.replaceChildren(back, head, el('pre', 'result', data.text || '(空会话)'))
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

function renderSearchScope() {
  const pick = $('#searchScope')
  if (!pick) return
  pick.replaceChildren()
  const all = el('option', '', '全部项目')
  all.value = ''
  pick.append(all)
  for (const project of state.projects || []) {
    const option = el('option', '', project.name || `项目 #${project.id}`)
    option.value = project.path || project.name
    pick.append(option)
  }
  // 项目还没加载完（例如 token 重载后从 URL 恢复搜索）时保留 scope，
  // 等 loadProjects 回来再对齐，别把它清成「全部项目」。
  if (!(state.projects || []).length) {
    pick.value = ''
    pick.hidden = true
    return
  }
  const values = [...pick.options].map((option) => option.value)
  pick.value = values.includes(state.search.scope) ? state.search.scope : ''
  state.search.scope = pick.value
  pick.hidden = false
}

const HIT_LABEL = { session: '会话', message: '消息', memory: '记忆' }

// 把命中的关键词包成 <mark>（textContent 方式，不拼 innerHTML）。
function highlighted(text, query) {
  const frag = document.createDocumentFragment()
  const raw = String(text ?? '')
  const needle = String(query ?? '').trim()
  if (!needle) {
    frag.append(document.createTextNode(raw))
    return frag
  }
  const lower = raw.toLowerCase()
  const q = needle.toLowerCase()
  let at = 0
  while (at < raw.length) {
    const idx = lower.indexOf(q, at)
    if (idx < 0) break
    if (idx > at) frag.append(document.createTextNode(raw.slice(at, idx)))
    frag.append(el('mark', '', raw.slice(idx, idx + needle.length)))
    at = idx + needle.length
  }
  if (at < raw.length) frag.append(document.createTextNode(raw.slice(at)))
  return frag
}

function renderSearchHits(hits, query, showAll = false) {
  const pre = $('#searchResult')
  const box = $('#searchHits')
  pre.hidden = true
  pre.textContent = ''
  box.hidden = false
  box.replaceChildren()
  if (!hits.length) {
    const empty = el(
      'div',
      'mem-none',
      `没有找到「${query}」相关的记录。试试更短的关键词${
        state.search.scope ? '，或把范围改成「全部项目」' : ''
      }。`
    )
    if (state.search.scope) {
      empty.append(
        document.createElement('br'),
        button(
          '在全部项目中搜索',
          () => {
            state.search.scope = ''
            renderSearchScope()
            $('#searchForm').requestSubmit()
          },
          'ghost',
          '清除项目范围，重新在全库搜索'
        )
      )
    }
    box.append(empty)
    return
  }
  // 同一场会话的消息最多先展示 3 条，避免 20 条结果全来自同一个长会话。
  const kept = []
  const perSession = new Map()
  let hidden = 0
  for (const hit of hits) {
    if (showAll || hit.kind !== 'message' || !hit.sessionId) {
      kept.push(hit)
      continue
    }
    const seen = perSession.get(hit.sessionId) || 0
    if (seen >= 3) {
      hidden += 1
      continue
    }
    perSession.set(hit.sessionId, seen + 1)
    kept.push(hit)
  }
  const head = el('div', 'muted hint')
  head.append(
    `共 ${hits.length} 条命中（按相关度排序）` +
      (hidden ? `，先展示 ${kept.length} 条：同一会话最多 3 条消息` : '')
  )
  if (hidden) {
    head.append(
      button(
        '显示全部',
        () => renderSearchHits(hits, query, true),
        'ghost small',
        '展开同一会话里的其余命中'
      )
    )
  }
  box.append(head)
  for (const hit of kept) {
    const card = el('div', `hit hit-${hit.kind}`)
    const head = el('div', 'hit-head')
    head.append(el('span', `tag hit-tag ${hit.kind}`, HIT_LABEL[hit.kind] || hit.kind))
    if (hit.sessionId) head.append(el('b', 'sid', `#${hit.sessionId}`))
    if (hit.title) head.append(el('strong', 'hit-title', hit.title))
    const bits = []
    if (hit.agent) bits.push(`来自 ${hit.agent}`)
    if (hit.scope) bits.push(hit.scope === 'project' ? '项目记忆' : '全局记忆')
    if (hit.lastMessageAt) bits.push(fmtDay(hit.lastMessageAt))
    else if (hit.updatedAt) bits.push(fmtDay(Math.floor(hit.updatedAt / 1000)))
    if (bits.length) head.append(el('span', 'hit-meta', bits.join(' · ')))
    card.append(head)

    const snip = el('div', 'hit-snippet')
    snip.append(highlighted(hit.snippet || '', query))
    card.append(snip)

    if (hit.sessionId) {
      const acts = el('div', 'hit-acts')
      const toggle = button(
        '看会话',
        async () => {
          const shown = card.querySelector('.hit-session')
          if (shown) {
            shown.remove()
            toggle.textContent = '看会话'
            return
          }
          toggle.disabled = true
          const view = el('pre', 'result hit-session', '读取中…')
          card.append(view)
          try {
            const data = await api(`api/session?id=${encodeURIComponent(hit.sessionId)}&tail=200`)
            view.textContent = data.text || '(空会话)'
            toggle.textContent = '收起'
          } catch (err) {
            view.textContent = `读取失败：${err.message}`
          } finally {
            toggle.disabled = false
          }
        },
        'ghost',
        `展开会话 #${hit.sessionId} 最近 200 条消息`
      )
      acts.append(toggle)
      card.append(acts)
    }
    box.append(card)
  }
}

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
  $('#digestOn').addEventListener('change', (event) => {
    void saveDistill({ digestOn: event.target.checked })
  })
  $('#quietPick').addEventListener('change', (event) => {
    const n = Number(event.target.value)
    void saveDistill({ digestQuietMinutes: Number.isFinite(n) ? n : 30 })
  })
  $('#dreamOn').addEventListener('change', (event) => {
    void saveDistill({ dream: event.target.checked })
  })
  $('#dreamEvery').addEventListener('change', (event) => {
    const n = Number(event.target.value)
    void saveDistill({ dreamEveryHours: Number.isFinite(n) ? n : 24 })
  })
  $('#injectOn').addEventListener('change', (event) => {
    void saveDistill({ inject: event.target.checked })
  })
  $('#injectAll').addEventListener('change', (event) => {
    const agents = state.distill?.agents || []
    // 勾「全部」= 全部（列表清空）；取消后展开成逐个 agent，便于再取消某几个
    void saveDistill(
      event.target.checked
        ? { injectAll: true, injectAgents: [] }
        : { injectAll: false, injectAgents: agents.map((agent) => agent.id) }
    )
  })
  $('#modelPick').addEventListener('change', (event) => {
    void saveDistill({ model: event.target.value })
  })
  $('#digestRun').addEventListener('click', () => void runJob('api/digest/run'))
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
  $('#searchScope').addEventListener('change', (event) => {
    state.search.scope = event.target.value
    if ($('#query').value.trim()) $('#searchForm').requestSubmit()
  })
  $('#searchForm').addEventListener('submit', async (event) => {
    event.preventDefault()
    const query = $('#query').value.trim()
    if (!query) return
    const out = $('#searchResult')
    const hits = $('#searchHits')
    hits.hidden = true
    hits.replaceChildren()
    out.hidden = false
    out.textContent = '搜索中…'
    const qs = new URLSearchParams({ q: query })
    if (state.agent) qs.set('agent', state.agent)
    if (state.search.scope) qs.set('project', state.search.scope)
    try {
      const data = await api(`api/search?${qs.toString()}`)
      if (Array.isArray(data.hits)) renderSearchHits(data.hits, query)
      else out.textContent = data.text || '(没有结果)'
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
  const params = new URLSearchParams(location.search)
  const wantView = params.get('view')
  const wantQuery = (params.get('q') || '').trim()
  const wantScope = params.get('scope') || ''
  if (wantScope) state.search.scope = wantScope
  const ok = await loadStatus()
  if (!ok) return
  if (wantView === 'search') {
    switchView('search')
    if (wantQuery) {
      $('#query').value = wantQuery
      $('#searchForm').requestSubmit()
    }
  } else {
    switchView('memory')
  }
})()
