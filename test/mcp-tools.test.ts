import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { CORE_MIGRATIONS } from '../src/plugins/core-schema/migrations'
import { createSearchService } from '../src/plugins/core-schema/search'
import { createIngestService } from '../src/plugins/core-schema/ingest'
import { createMcpTools } from '../src/plugins/core-schema/mcp-tools'

let db: Database.Database

function seedBase(): void {
  db.prepare(
    `INSERT INTO projects (id, path, name, updated_at, device_id) VALUES (1, 'F:/code/MemorySQL', 'MemorySQL', 1, 'local')`
  ).run()
  // two codex sessions in the project, one hermes session elsewhere
  db.prepare(
    `INSERT INTO sessions (id, agent_type, external_id, project_id, started_at, title, summary, content_hash, message_count, tool_call_count, updated_at, device_id)
     VALUES (10, 'codex', 'c1', 1, strftime('%s','now','-1 day'), '实现 FTS 触发器', '给 memories 建 FTS 触发器同步', 'h1', 3, 0, strftime('%s','now','-1 day'), 'local')`
  ).run()
  db.prepare(
    `INSERT INTO sessions (id, agent_type, external_id, project_id, started_at, title, summary, content_hash, message_count, tool_call_count, updated_at, device_id)
     VALUES (11, 'codex', 'c2', 1, strftime('%s','now','-10 day'), '早期会话', '很早以前的工作', 'h2', 1, 0, strftime('%s','now','-10 day'), 'local')`
  ).run()
  db.prepare(
    `INSERT INTO sessions (id, agent_type, external_id, project_id, started_at, title, summary, content_hash, message_count, tool_call_count, updated_at, device_id)
     VALUES (12, 'hermes', 'h1', NULL, strftime('%s','now','-2 day'), 'Hermes 别的项目', '无关会话', 'h3', 1, 0, strftime('%s','now','-2 day'), 'local')`
  ).run()
  const ins = db.prepare(
    `INSERT INTO session_messages (session_id, seq, role, content, ts) VALUES (?, ?, ?, ?, strftime('%s','now'))`
  )
  ins.run(10, 0, 'user', '请把记忆表接进全文检索')
  ins.run(10, 1, 'assistant', '已完成:memories_fts 触发器就位,搜索三路查询通过')
  ins.run(12, 0, 'user', 'hermes 无关消息')
  // production keeps these in sync via ingest; seeds must mirror that
  db.exec(`INSERT INTO sessions_fts (rowid, title, summary) SELECT id, title, summary FROM sessions`)
  db.exec(`INSERT INTO messages_fts (rowid, content) SELECT id, content FROM session_messages`)
  // memories: one global, one codex-specific, one retired
  db.prepare(
    `INSERT INTO memories (kind, content, source, status, updated_at, device_id) VALUES ('fact', '全局记忆内容示例部署流程', 'test', 'active', 1, 'local')`
  ).run()
  db.prepare(
    `INSERT INTO memories (kind, content, source, status, updated_at, device_id, agent_type) VALUES ('preference', 'Codex 专属偏好先写测试再实现', 'test', 'active', 2, 'local', 'codex')`
  ).run()
  db.prepare(
    `INSERT INTO memories (kind, content, source, status, updated_at, device_id) VALUES ('decision', '退休的旧决策不应出现', 'test', 'retired', 3, 'local')`
  ).run()
}

beforeEach(() => {
  db = new Database(':memory:')
  for (const m of CORE_MIGRATIONS) db.exec(m.up)
  seedBase()
})

function tools(semantic?: {
  search: (q: string, limit?: number) => Promise<Array<{ kind: 'memory' | 'session'; refId: number; score: number }>>
}) {
  return createMcpTools({
    sqlite: db,
    search: createSearchService(db),
    memories: createIngestService({ sqlite: db, getSummarizer: () => null, onIngest: () => {} }),
    services: {
      use: <T = unknown>(name: string) => {
        if (name === 'semantic-search' && semantic) return semantic as T
        throw new Error(`Service not provided: ${name}`)
      }
    }
  })
}
const call = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
  const tool = tools().find((t) => t.name === name)
  if (!tool) throw new Error(`missing tool ${name}`)
  return String(await tool.handler(args))
}

describe('memory_list_sessions', () => {
  it('lists sessions with ids and filters by agent', async () => {
    const all = await call('memory_list_sessions', {})
    expect(all).toContain('#10')
    expect(all).toContain('#12')
    const codexOnly = await call('memory_list_sessions', { agent: 'codex' })
    expect(codexOnly).toContain('#10')
    expect(codexOnly).not.toContain('#12')
  })

  it('filters by project keyword and since days', async () => {
    const scoped = await call('memory_list_sessions', { project: 'MemorySQL' })
    expect(scoped).toContain('#10')
    expect(scoped).not.toContain('#12')
    const recent = await call('memory_list_sessions', { since: 5 })
    expect(recent).toContain('#10')
    expect(recent).not.toContain('#11') // 10 days old
    expect(await call('memory_list_sessions', { project: '不存在' })).toContain('未找到')
  })
})

describe('memory_get_context', () => {
  it('filters long-term memories by agent, keeping global ones', async () => {
    const forHermes = await call('memory_get_context', { agent: 'hermes' })
    expect(forHermes).toContain('全局记忆内容示例')
    expect(forHermes).not.toContain('Codex 专属偏好')
    const forCodex = await call('memory_get_context', { agent: 'codex' })
    expect(forCodex).toContain('Codex 专属偏好')
    expect(forCodex).not.toContain('退休的旧决策')
  })

  it('inlines the last session tail when requested', async () => {
    const plain = await call('memory_get_context', { project: 'MemorySQL' })
    expect(plain).not.toContain('上一棒交接摘要')
    expect(plain).toContain('#10')
    const withTail = await call('memory_get_context', { project: 'MemorySQL', include_last_session: true })
    expect(withTail).toContain('上一棒交接摘要')
    expect(withTail).toContain('memories_fts 触发器就位')
  })
})

describe('memory_get_session full mode', () => {
  it('keeps long messages intact only in full mode', async () => {
    const long = '很长的工具输出'.repeat(500) // 3500 chars
    db.prepare('INSERT INTO session_messages (session_id, seq, role, content) VALUES (10, 2, ?, ?)').run('tool', long)
    const def = await call('memory_get_session', { id: 10 })
    expect(def).toContain('[截断]')
    const full = await call('memory_get_session', { id: 10, full: true })
    expect(full).toContain(long)
  })
})

describe('memory_search filters', () => {
  it('kind filter restricts the searched asset', async () => {
    const mems = await call('memory_search', { query: '部署流程', kind: 'memory' })
    expect(mems).toContain('[memory')
    expect(mems).not.toContain('[session')
    const sessions = await call('memory_search', { query: '触发器', kind: 'session' })
    expect(sessions).toContain('[session')
    expect(sessions).not.toContain('[memory')
  })

  it('agent + project filters apply', async () => {
    const hermes = await call('memory_search', { query: '无关会话', agent: 'hermes' })
    expect(hermes).toContain('#12')
    const codex = await call('memory_search', { query: '无关会话', agent: 'codex' })
    expect(codex).toBe('未找到与"无关会话"相关的记录。')
    const inProject = await call('memory_search', { query: '触发器', project: 'MemorySQL' })
    expect(inProject).toContain('会话#10')
  })

  it('backfills semantic-only hits when the plugin is available', async () => {
    const semantic = {
      search: async () => [{ kind: 'session' as const, refId: 10, score: 0.9 }]
    }
    const out = await callWith(semantic, 'memory_search', { query: '量子纠缠式重构方案xyz' })
    expect(out).toContain('语义检索召回')
    expect(out).toContain('·语义')
    expect(out).toContain('#10')
    // agent filter must apply to semantic hits too
    const filtered = await callWith(semantic, 'memory_search', { query: '量子纠缠式重构方案xyz', agent: 'hermes' })
    expect(filtered).not.toContain('·语义')
  })
})

async function callWith(
  semantic: Parameters<typeof tools>[0],
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const tool = tools(semantic).find((t) => t.name === name)
  if (!tool) throw new Error(`missing tool ${name}`)
  return String(await tool.handler(args))
}

describe('memory_write attribution + dedup', () => {
  it('persists agent/project/tags and rejects exact duplicates', async () => {
    const out = await call('memory_write', {
      kind: 'preference',
      content: '偏好中文注释',
      agent: 'codex',
      project: 'MemorySQL',
      tags: ['风格', '注释']
    })
    expect(out).toContain('已写入记忆')
    const row = db
      .prepare(`SELECT agent_type, project_id, tags FROM memories WHERE content = '偏好中文注释'`)
      .get() as { agent_type: string | null; project_id: number | null; tags: string | null }
    expect(row.agent_type).toBe('codex')
    expect(row.project_id).toBe(1)
    expect(JSON.parse(row.tags ?? '[]')).toEqual(['风格', '注释'])

    const dup = await call('memory_write', { kind: 'fact', content: '偏好中文注释' })
    expect(dup).toContain('已存在相同内容的记忆')
    expect(
      (db.prepare(`SELECT COUNT(*) n FROM memories WHERE content = '偏好中文注释'`).get() as { n: number }).n
    ).toBe(1)
  })
})

describe('memory_log_progress + brief', () => {
  it('writes a candidate progress memory linked to the project', async () => {
    const out = await call('memory_log_progress', {
      project: 'MemorySQL',
      done: '矩阵 v2 六工具落地',
      next: '下一步写交接简报测试',
      issues: 'LLM 冲突检测未做',
      agent: 'codex'
    })
    expect(out).toContain('已记录收工进度')
    const row = db
      .prepare(`SELECT status, project_id, agent_type FROM memories WHERE source LIKE 'agent:mcp:log_progress%'`)
      .get() as { status: string; project_id: number | null; agent_type: string | null }
    expect(row.status).toBe('candidate')
    expect(row.project_id).toBe(1)
    expect(row.agent_type).toBe('codex')
  })

  it('brief assembles sessions, tail, memories and pending progress', async () => {
    await call('memory_log_progress', { project: 'MemorySQL', done: '写了一半的功能' })
    const brief = await call('memory_get_project_brief', { project: 'MemorySQL' })
    expect(brief).toContain('# 项目交接简报: MemorySQL')
    expect(brief).toContain('最近会话')
    expect(brief).toContain('#10')
    expect(brief).toContain('上一棒进行到哪')
    expect(brief).toContain('memories_fts 触发器就位')
    expect(brief).toContain('待确认进度')
    expect(brief).toContain('写了一半的功能')
  })
})
