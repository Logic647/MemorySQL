#!/usr/bin/env node
/**
 * 生成一个「记忆分层」UI 验收用演示库(out/ 已 gitignore,不会碰真实库)。
 *
 * 用法:
 *   node --experimental-strip-types scripts/seed-memory-ui-demo.ts
 *
 * 产出:<repo>/out/memory-ui-demo/{memory.db,settings.json}
 * 启动:
 *   npm run build
 *   $env:MEMORYSQL_DATA_DIR="<repo>\\out\\memory-ui-demo"
 *   npx electron . --user-data-dir="<repo>\\out\\memory-ui-demo-userdata"
 *
 * settings.json 只从真实设置里复制 `summarizer-llm:*`(用于「立即整理」),
 * 并关闭所有 capture-* 插件,避免演示库扫进真实会话;其余设置不复用。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Db } from '../src/main/core/db.ts'
import { CORE_MIGRATIONS } from '../src/plugins/core-schema/migrations.ts'
import { DIGEST_MIGRATIONS } from '../src/plugins/project-digest/migrations.ts'
import { CURATOR_MIGRATIONS } from '../src/plugins/memory-curator/migrations.ts'
import { BUILTIN_PLUGIN_IDS } from '../src/shared/builtin-plugins.ts'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const demoDir = path.join(repoRoot, 'out', 'memory-ui-demo')
const settingsPath = path.join(demoDir, 'settings.json')
fs.rmSync(demoDir, { recursive: true, force: true })
fs.mkdirSync(demoDir, { recursive: true })

const db = new Db(path.join(demoDir, 'memory.db'))
db.migrate('core-schema', CORE_MIGRATIONS)
db.migrate('project-digest', DIGEST_MIGRATIONS)
db.migrate('memory-curator', CURATOR_MIGRATIONS)
const sqlite = db.sqlite
const now = Date.now()
const nowSec = Math.floor(now / 1000)

const projectId = Number(
  sqlite
    .prepare(`INSERT INTO projects (path, name, tech_stack, updated_at, device_id) VALUES (?, ?, ?, ?, 'local')`)
    .run('H:\\demo\\memory-ui-demo', 'memory-ui-demo', 'TypeScript · Electron · SQLite', now).lastInsertRowid
)
const otherProjectId = Number(
  sqlite
    .prepare(`INSERT INTO projects (path, name, updated_at, device_id) VALUES (?, ?, ?, 'local')`)
    .run('H:\\demo\\other-project', 'other-project', now).lastInsertRowid
)

const insSession = sqlite.prepare(
  `INSERT INTO sessions
     (agent_type, external_id, project_id, cwd, started_at, ended_at, last_message_at, title, summary,
      content_hash, message_count, tool_call_count, updated_at, device_id)
   VALUES ('zcode', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local')`
)
const insMessage = sqlite.prepare(
  `INSERT INTO session_messages (session_id, seq, role, content, ts, tool_name) VALUES (?, ?, ?, ?, ?, ?)`
)
const addSession = (externalId: string, title: string, summary: string, messages: Array<[string, string, string?]>): number => {
  const started = nowSec - 7200
  const ended = nowSec - 600
  const id = Number(
    insSession.run(
      externalId,
      projectId,
      'H:\\demo\\memory-ui-demo',
      started,
      ended,
      ended,
      title,
      summary,
      `demo-${externalId}`,
      messages.length,
      1,
      now
    ).lastInsertRowid
  )
  messages.forEach(([role, content, toolName], i) => {
    insMessage.run(id, i, role, content, started + i, toolName ?? null)
  })
  return id
}
addSession('demo-1', '实现记忆分层', '把 memories 拆成全局/项目,并让 curator 从总结自动整理', [
  ['user', '把记忆分成全局和项目两层,项目记忆从项目总结里自动整理'],
  ['assistant', '已完成 memories.scope/locked 迁移,新增 memory-curator 插件'],
  ['tool', '{"path":"src/plugins/memory-curator/curate.ts"}', 'Write']
])
addSession('demo-2', '拆分项目总结', 'summary 只留总览,recent 专门写最近进展', [
  ['user', '总结太长了,最近做了什么要详细,其他部分短一点'],
  ['assistant', '已把 digest 拆成 summary + recent,注入时 recent 单独展示']
])
addSession('demo-3', '注入顺序调整', 'memory_get_context 改为全局记忆→项目记忆→总结→最近进展', [
  ['user', '每次调用先给记忆再看总结'],
  ['assistant', '已调整上下文顺序并加 2200/2600 字符预算']
])

const digestId = Number(
  sqlite
    .prepare(
      `INSERT INTO project_digests
         (project_id, period_start, period_end, summary, recent, per_session, todos, decisions, model, sessions_covered, created_at, updated_at, device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'llm:demo', 3, ?, ?, 'local')`
    )
    .run(
      projectId,
      nowSec - 7200,
      nowSec - 600,
      '项目总览: MemorySQL 的记忆分层。目标是把记忆按全局/项目两层维护,由项目总结自动整理,类型仍为画像/偏好/事实/决策。技术栈 Electron + TypeScript + SQLite(FTS5)。关键决策:LLM 只维护派生记忆,原始会话只读;用户编辑过的条目锁定。',
      '最近进展: 实现了 memories v9 迁移(scope/locked/access)与 project_digests.recent;新增 memory-curator 插件,在总结完成后自动整理项目/全局记忆;memory_get_context 改为「全局记忆→项目记忆→总结→最近进展」,并加了注入预算。已知问题:sync-folder 还没带 scope。下一步:补同步字段、加 UI 验收。',
      JSON.stringify([
        { id: 1, title: '实现记忆分层', note: 'memories 加 scope/locked' },
        { id: 2, title: '拆分项目总结', note: 'summary + recent' },
        { id: 3, title: '注入顺序调整', note: '记忆在前、总结在后' }
      ]),
      JSON.stringify([
        { content: '给 sync-folder 补 scope/project_id', status: 'open' },
        { content: '补 UI 验收', status: 'open' }
      ]),
      JSON.stringify(['LLM 只产派生记忆,原始会话只读', '用户编辑过的记忆 locked=1']),
      now,
      now
    ).lastInsertRowid
)
sqlite
  .prepare(
    `INSERT INTO project_digest_state (project_id, status, last_digest_at, last_covered_ts, last_error, updated_at)
     VALUES (?, 'idle', ?, ?, NULL, ?)`
  )
  .run(projectId, now, nowSec - 600, now)

const insMemory = sqlite.prepare(
  `INSERT INTO memories
     (kind, content, source, confidence, status, updated_at, device_id, scope, project_id, locked, access_count, last_access_at)
   VALUES (?, ?, ?, ?, 'active', ?, 'local', ?, ?, ?, ?, ?)`
)
const addMemory = (input: {
  kind: string
  content: string
  scope: 'global' | 'project'
  projectId?: number | null
  source: string
  locked?: number
  access?: number
}): number =>
  Number(
    insMemory.run(
      input.kind,
      input.content,
      input.source,
      0.9,
      now,
      input.scope,
      input.projectId ?? null,
      input.locked ?? 0,
      input.access ?? 0,
      input.access ? now : null
    ).lastInsertRowid
  )

addMemory({
  kind: 'persona',
  content: '用户是后端/全栈开发者,主要使用 TypeScript 与 Electron,偏好中文注释和直接给结论。',
  scope: 'global',
  source: 'manual',
  locked: 1
})
addMemory({
  kind: 'preference',
  content: '回复尽量简短,先给结论再展开;改动前先说明影响范围。',
  scope: 'global',
  source: 'llm-curator:global',
  access: 3
})
addMemory({
  kind: 'fact',
  content: '项目使用 SQLite + FTS5 作为会话与记忆的权威存储,原始会话只读。',
  scope: 'project',
  projectId,
  source: `llm-curator:project:${projectId}`,
  access: 2
})
addMemory({
  kind: 'decision',
  content: 'LLM 自动整理只维护派生记忆;用户编辑过的条目 locked=1,不再覆盖。',
  scope: 'project',
  projectId,
  source: `llm-curator:project:${projectId}`
})
addMemory({
  kind: 'preference',
  content: '项目总结的 summary 只留总览,最近做了什么放到 recent 详细写。',
  scope: 'project',
  projectId,
  source: `llm-curator:project:${projectId}`
})
addMemory({
  kind: 'decision',
  content: '用户手写:这条是锁定记忆,自动整理不能改它。',
  scope: 'project',
  projectId,
  source: 'manual',
  locked: 1
})
addMemory({
  kind: 'fact',
  content: '别的项目专属事实:不应出现在 memory-ui-demo 的项目记忆里。',
  scope: 'project',
  projectId: otherProjectId,
  source: 'manual'
})

db.close()

// 只复制 LLM 配置,避免把真实 capture 路径/密钥无关配置带进演示库
const realSettings = path.join(
  process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
  'memorysql',
  'data',
  'settings.json'
)
const settings: Record<string, unknown> = {}
let copiedLlm = false
if (fs.existsSync(realSettings)) {
  try {
    const all = JSON.parse(fs.readFileSync(realSettings, 'utf-8')) as Record<string, unknown>
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith('summarizer-llm:')) {
        settings[k] = v
        copiedLlm = true
      }
    }
  } catch {
    /* 真实设置读不了就留空,UI 会提示未配置 LLM */
  }
}
settings['project-digest:enabled'] = true
settings['memory-curator:enabled'] = true
settings['semantic-search:enabled'] = false
for (const id of BUILTIN_PLUGIN_IDS) {
  if (id.startsWith('capture-') || id === 'import-chat') settings[`plugin.${id}.enabled`] = false
}
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8')

console.log(`演示库已生成: ${demoDir}`)
console.log(`项目: memory-ui-demo(id=${projectId}) · 总结 id=${digestId} · 项目/全局记忆已种入`)
console.log(`LLM 配置: ${copiedLlm ? '已从本机设置复制 summarizer-llm:*' : '未找到(可在设置页手填后再点立即整理)'}`)
console.log('')
console.log('启动:')
console.log('  npm run build')
console.log(`  $env:MEMORYSQL_DATA_DIR="${demoDir}"`)
console.log(`  npx electron . --user-data-dir="${demoDir}-userdata"`)
