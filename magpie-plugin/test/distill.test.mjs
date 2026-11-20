import test from 'node:test'
import assert from 'node:assert/strict'
import { createEmbeddedBackend } from '../lib/backend/embedded.mjs'

function mockLlm({ distilled = [], digest = {}, dream = {} } = {}) {
  return {
    async resolveModel() {
      return 'test/model'
    },
    async models() {
      return [{ id: 'test/model', name: 'Test Model', provider: 'test' }]
    },
    async chat(messages) {
      const system = messages[0]?.content ?? ''
      if (system.includes('rolling handoff summary')) {
        return { model: 'test/model', content: JSON.stringify(digest) }
      }
      if (system.includes('tidy a list of memories')) {
        return { model: 'test/model', content: JSON.stringify(dream) }
      }
      return { model: 'test/model', content: JSON.stringify(distilled) }
    }
  }
}

async function waitIdle(backend) {
  for (let i = 0; i < 300; i += 1) {
    const state = await backend.ui.distillState()
    if (!state.running) return state
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('distill did not finish')
}

async function importQuietSession(backend) {
  const twoHoursAgo = Math.floor(Date.now() / 1000) - 7200
  return JSON.parse(
    await backend.call('memory_import_session', {
      agent: 'claudecode',
      externalId: 'quiet-1',
      cwd: 'H:/work/demo',
      title: '讨论测试习惯',
      endedAt: twoHoursAgo,
      messages: [
        { role: 'user', content: '这个项目先写测试再实现', ts: twoHoursAgo - 60 },
        { role: 'assistant', content: '好的，先补测试。', ts: twoHoursAgo }
      ]
    })
  )
}

test('LLM 蒸馏：安静会话 → 候选记忆（引用校验 + 项目作用域）', async (t) => {
  const backend = await createEmbeddedBackend({
    memory: true,
    llm: mockLlm({
      distilled: [
        {
          text: '用户偏好先写测试再实现',
          kind: 'preference',
          scope: 'project',
          why: '用户明确说了测试优先',
          quote: '先写测试再实现'
        },
        {
          text: '引用对不上的应该被丢掉',
          kind: 'fact',
          scope: 'global',
          why: 'x',
          quote: '模型编的话'
        }
      ]
    })
  })
  t.after(() => backend.close())
  await importQuietSession(backend)

  await backend.ui.setDistill({ on: true, model: 'test/model' })
  const started = backend.ui.runDistill()
  assert.equal(started.started, true)
  const state = await waitIdle(backend)
  assert.equal(state.error, '')
  assert.ok(state.added >= 1)
  assert.equal(state.lastModel, 'test/model')

  const list = await backend.ui.listMemories({ status: 'candidate' })
  assert.equal(list.memories.length, 1)
  assert.equal(list.memories[0].text, '用户偏好先写测试再实现')
  assert.equal(list.memories[0].kind, 'preference')
  assert.equal(list.memories[0].scope, 'project')
  assert.equal(list.memories[0].project, 'demo')
  assert.equal(list.memories[0].why, '用户明确说了测试优先')
  assert.equal(list.memories[0].source, 'llm-distill:1')

  // 第二次没有新会话 → 不再重复调模型
  const before = state.added
  backend.ui.runDistill()
  const again = await waitIdle(backend)
  assert.equal(again.added, 0)
  assert.equal(again.lastModel, 'test/model')
  assert.ok(before >= 1)
})

test('LLM 项目总结：生成后 memory_get_project_digest 返回模型总结', async (t) => {
  const backend = await createEmbeddedBackend({
    memory: true,
    llm: mockLlm({
      digest: { summary: '这是一个 demo 项目，当前在补测试。', recent: '修了登录并补了测试。', todos: ['补端到端测试'] }
    })
  })
  t.after(() => backend.close())
  await importQuietSession(backend)

  const made = await backend.ui.generateDigest({ project: 'demo' })
  assert.equal(made.ok, true)
  assert.equal(made.model, 'test/model')

  const text = await backend.call('memory_get_project_digest', { project: 'demo' })
  assert.match(text, /这是一个 demo 项目/)
  assert.match(text, /修了登录并补了测试/)
  assert.match(text, /补端到端测试/)
  assert.match(text, /test\/model/)
})

test('LLM 整理：合并重复记忆，用户锁定/手写的不动', async (t) => {
  const backend = await createEmbeddedBackend({
    memory: true,
    llm: mockLlm({
      dream: { merge: [{ ids: [1, 2], text: '登录问题优先查 session 过期', kind: 'fact' }], archive: [] }
    })
  })
  t.after(() => backend.close())
  await importQuietSession(backend)
  // 两条未锁定记忆（candidate / active 都进整理）
  const a = await backend.call('memory_write', {
    kind: 'fact',
    content: '登录先查 session 过期',
    cwd: 'H:/work/demo'
  })
  const b = await backend.call('memory_write', {
    kind: 'fact',
    content: '登录问题优先查 session 过期时间',
    cwd: 'H:/work/demo'
  })
  assert.match(String(a), /已写入/)
  assert.match(String(b), /已写入/)

  backend.ui.runDream()
  const state = await waitIdle(backend)
  assert.equal(state.dreamError, '')
  assert.ok(state.changes.some((c) => c.action === 'merge'))

  const active = await backend.ui.listMemories({ status: 'active', scope: 'project:1' })
  assert.ok(active.memories.some((m) => m.text === '登录问题优先查 session 过期'))
  const archived = await backend.ui.listMemories({ status: 'archived', scope: 'project:1' })
  assert.ok(archived.memories.some((m) => m.text === '登录先查 session 过期' || m.text === '登录问题优先查 session 过期时间'))
})

test('记忆页 API：新增/编辑/置顶/归档/删除', async (t) => {
  const backend = await createEmbeddedBackend({ memory: true })
  t.after(() => backend.close())

  const added = await backend.ui.saveMemory({
    text: '用户偏好中文回复',
    kind: 'preference',
    scope: 'global',
    tags: ['偏好'],
    why: '用户说的'
  })
  assert.equal(added.ok, true)
  assert.ok(added.id > 0)

  const active = await backend.ui.listMemories({ status: 'active' })
  assert.equal(active.memories.length, 1)
  assert.equal(active.memories[0].locked, true)
  assert.deepEqual(active.memories[0].tags, ['偏好'])

  const edited = await backend.ui.saveMemory({
    id: added.id,
    text: '用户偏好中文回复，代码注释也用中文',
    kind: 'preference',
    scope: 'global',
    tags: ['偏好', '中文']
  })
  assert.equal(edited.ok, true)
  const afterEdit = await backend.ui.listMemories({ status: 'active' })
  assert.match(afterEdit.memories[0].text, /代码注释也用中文/)

  assert.equal((await backend.ui.pinMemory({ id: added.id, pinned: true })).ok, true)
  assert.equal((await backend.ui.setMemoryStatus({ ids: [added.id], status: 'archived' })).ok, true)
  const archived = await backend.ui.listMemories({ status: 'archived' })
  assert.equal(archived.memories.length, 1)
  assert.equal((await backend.ui.removeMemories({ ids: [added.id] })).ok, true)
  const gone = await backend.ui.listMemories({ status: 'archived' })
  assert.equal(gone.memories.length, 0)
})

test('蒸馏设置：模型/范围/开关持久在 state 上', async (t) => {
  const backend = await createEmbeddedBackend({ memory: true, llm: mockLlm() })
  t.after(() => backend.close())
  const state = await backend.ui.setDistill({ on: true, model: 'test/model', days: 30, autoDigest: true })
  assert.equal(state.on, true)
  assert.equal(state.model, 'test/model')
  assert.equal(state.days, 30)
  assert.equal(state.autoDigest, true)
  assert.equal(state.models[0].id, 'test/model')
})
