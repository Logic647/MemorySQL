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

  /**
   * 真实数据里同名项目很常见(换机后路径变了、斜杠两种写法、src 子目录)。
   * 过去只取 LIMIT 1 的那一个,静默丢掉其余项目的会话 —— 本机「MemorySQL」
   * 一词命中 5 个项目,实测只回 1 条会话。
   */
  it('merges sessions from every project matched by the keyword', async () => {
    // 同名的第二、第三个项目:换机后的新路径 + 同盘的另一种斜杠写法。
    // 这两个名字都是 MemorySQL —— 属于「同一项目的多份登记」,必须合并。
    db.prepare(
      `INSERT INTO projects (id, path, name, updated_at, device_id) VALUES (2, 'H:\\桌面\\MemorySQL', 'MemorySQL', 2, 'local')`
    ).run()
    db.prepare(
      `INSERT INTO projects (id, path, name, updated_at, device_id) VALUES (4, 'H:/桌面/MemorySQL', 'MemorySQL', 4, 'local')`
    ).run()
    // 另一个**不同名**的项目,只是路径恰好在同一目录树下(src 子目录)
    db.prepare(
      `INSERT INTO projects (id, path, name, updated_at, device_id) VALUES (3, 'H:/桌面/MemorySQL/src', 'src', 3, 'local')`
    ).run()
    const insSess = db.prepare(
      `INSERT INTO sessions (id, agent_type, external_id, project_id, started_at, title, summary, content_hash, message_count, tool_call_count, updated_at, device_id)
       VALUES (?, 'zcode', ?, ?, strftime('%s','now'), ?, '', ?, 1, 0, strftime('%s','now'), 'local')`
    )
    insSess.run(20, 'z2', 2, '新机的会话', 'hz2')
    insSess.run(21, 'z3', 3, 'src 子目录的会话', 'hz3')

    const merged = await call('memory_list_sessions', { project: 'MemorySQL', limit: 100 })
    expect(merged).toContain('#10') // 老项目
    expect(merged).toContain('#20') // 新机项目
    // **不同名**的项目不并入:合并判据是项目名。路径子串会把同目录下的
    // 无关项目全拉进来(真实库实测:关键词「桌面」命中 24 个项目),
    // 于是标题写 A、总结正文却是 B。
    expect(merged).not.toContain('#21')
    // 命中多个时必须明说合并了哪几个,否则 agent 会以为"就这些"
    // (名字叫 MemorySQL 的共 3 个:种子项目 1 + 新机 2 + 斜杠变体 4)
    expect(merged).toContain('命中 3 个同名/同路径项目')
    expect(merged).toContain('#2 H:\\桌面\\MemorySQL')
  })

  it('名字没命中时才退回路径匹配', async () => {
    // 只有路径含关键词、没有任何项目叫这个名字 → 仍然能找到(路径兜底)
    const byPath = await call('memory_list_sessions', { project: 'code/MemorySQL', limit: 100 })
    expect(byPath).toContain('#10')
  })
})

describe('memory_get_context', () => {
  /**
   * agent 新会话第一句「续接项目」调的就是这个工具。过去它只给会话标题列表,
   * 拿不到项目结论 —— 用户要求的「调项目记忆 = 读最近总结」在这条路径上不成立
   * (只有 memory_get_project_brief 有总结)。现在两处都带总结。
   */
  it('inlines the latest project digest before the session list', async () => {
    db.exec(`CREATE TABLE project_digests (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, period_start INTEGER,
      period_end INTEGER, summary TEXT NOT NULL DEFAULT '', todos TEXT NOT NULL DEFAULT '[]',
      decisions TEXT NOT NULL DEFAULT '[]', model TEXT NOT NULL DEFAULT '', sessions_covered INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, device_id TEXT NOT NULL DEFAULT '',
      deleted INTEGER NOT NULL DEFAULT 0)`)
    const insDigest = db.prepare(
      `INSERT INTO project_digests (project_id, summary, todos, model, sessions_covered, created_at, updated_at)
       VALUES (?, ?, ?, 'llm:test', ?, ?, ?)`
    )
    // 旧的一份(应被忽略)与最新的一份
    insDigest.run(1, '过期总结内容', '[]', 1, 100, 100)
    insDigest.run(1, '最新总结:项目已完成 M6,下一步做分发', JSON.stringify([{ content: '做分发', status: 'open' }]), 3, 200, 200)

    const ctx = await call('memory_get_context', { project: 'MemorySQL' })
    expect(ctx).toContain('项目滚动总结')
    expect(ctx).toContain('最新总结:项目已完成 M6')
    expect(ctx).not.toContain('过期总结内容') // 只取最新那一份
    expect(ctx).toContain('待办: 做分发')
    // 总结必须排在会话列表之前 —— agent 先读结论,再决定要不要翻会话
    expect(ctx.indexOf('项目滚动总结')).toBeLessThan(ctx.indexOf('最近会话'))

    // brief 同样带总结,且与 context 取的是同一份
    const brief = await call('memory_get_project_brief', { project: 'MemorySQL' })
    expect(brief).toContain('最新总结:项目已完成 M6')
  })

  it('degrades gracefully when the digest table does not exist', async () => {
    // project-digest 插件被停用 / 从未迁移过 → 不能抛错
    const ctx = await call('memory_get_context', { project: 'MemorySQL' })
    expect(ctx).toContain('## 项目: MemorySQL')
    expect(ctx).not.toContain('项目滚动总结')
  })

  /**
   * 回归:总结必须来自**标题所指示的那个项目集合**。
   *
   * 曾经标题走 findProject(LIMIT 1)、总结走 findProjectsByKeyword(全部匹配),
   * 于是关键词命中多个无关项目时,标题写着 A、总结正文却是 B 的结论
   * (真实库实测:标题「嵌入式-智能飞镖感应设备-省赛」+ 正文「冰冰快答小助手」)。
   */
  it('keeps the digest and header on the same merged project set', async () => {
    db.exec(`CREATE TABLE project_digests (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, period_start INTEGER,
      period_end INTEGER, summary TEXT NOT NULL DEFAULT '', todos TEXT NOT NULL DEFAULT '[]',
      decisions TEXT NOT NULL DEFAULT '[]', model TEXT NOT NULL DEFAULT '', sessions_covered INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, device_id TEXT NOT NULL DEFAULT '',
      deleted INTEGER NOT NULL DEFAULT 0)`)
    // 两个名字都含「桌面」但毫不相关的项目;只有 B 有总结
    db.prepare(
      `INSERT INTO projects (id, path, name, updated_at, device_id) VALUES (2, 'H:/桌面/飞镖', '桌面-飞镖设备', 5, 'local')`
    ).run()
    db.prepare(
      `INSERT INTO projects (id, path, name, updated_at, device_id) VALUES (3, 'F:/桌面/数据库', '桌面-数据库课设', 9, 'local')`
    ).run()
    db.prepare(
      `INSERT INTO sessions (id, agent_type, external_id, project_id, started_at, title, content_hash, message_count, tool_call_count, updated_at, device_id)
       VALUES (20, 'codex', 'x2', 2, 100, '飞镖会话', 'hx2', 1, 0, 100, 'local')`
    ).run()
    db.prepare(
      `INSERT INTO sessions (id, agent_type, external_id, project_id, started_at, title, content_hash, message_count, tool_call_count, updated_at, device_id)
       VALUES (21, 'codex', 'x3', 3, 200, '数据库会话', 'hx3', 1, 0, 200, 'local')`
    ).run()
    db.prepare(
      `INSERT INTO project_digests (project_id, summary, todos, model, sessions_covered, created_at, updated_at)
       VALUES (3, '数据库课设的总结正文', '[]', 'llm:t', 1, 300, 300)`
    ).run()

    const ctx = await call('memory_get_context', { project: '桌面' })
    // 标题取合并集合里最近活跃的(项目 3 的 updated_at 更大)
    expect(ctx).toContain('## 项目: 桌面-数据库课设')
    // 总结必须是**同一批项目**里那份,不能串到别的项目
    expect(ctx).toContain('数据库课设的总结正文')
  })

  /**
   * 回归:脏的 digest 行不能让 memory_get_context 直接抛错。
   *
   * renderDigestBlock 曾经无保护地调 d.todos.filter / d.perSession.length,
   * 手工编辑或异版本写坏的 JSON(todos='{}'、perSession 缺 note)会变成
   * Tool error —— 而这是 agent 新会话第一个调用的工具。
   */
  it('does not throw when digest rows contain malformed JSON shapes', async () => {
    db.exec(`CREATE TABLE project_digests (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, period_start INTEGER,
      period_end INTEGER, summary TEXT NOT NULL DEFAULT '', per_session TEXT NOT NULL DEFAULT '[]',
      todos TEXT NOT NULL DEFAULT '[]', decisions TEXT NOT NULL DEFAULT '[]',
      model TEXT NOT NULL DEFAULT '', sessions_covered INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, device_id TEXT NOT NULL DEFAULT '',
      deleted INTEGER NOT NULL DEFAULT 0)`)
    db.prepare(
      `INSERT INTO project_digests (project_id, summary, per_session, todos, model, sessions_covered, created_at, updated_at)
       VALUES (1, '脏行总结', ?, '{}', 'llm:t', 1, 100, 100)`
    ).run(JSON.stringify([{ id: 10, title: '无 note 的条目' }]))

    const ctx = await call('memory_get_context', { project: 'MemorySQL' })
    expect(ctx).toContain('脏行总结') // 能显示多少显示多少
    expect(ctx).toContain('## 项目: MemorySQL')
  })

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

  /**
   * 默认总预算从 12 万字符收到 4 万:过去一次调用真能吐 12 万字符
   * (≈3-4 万 token),agent 一个"回读历史"就把上下文撑爆 —— 正是本项目
   * 要解决的问题本身。
   */
  it('caps total output at 40k by default and says how to narrow', async () => {
    const ins = db.prepare(
      `INSERT INTO session_messages (session_id, seq, role, content) VALUES (10, ?, 'assistant', ?)`
    )
    // 40 条 × 2000 字符 ≈ 80k,超过默认预算
    for (let i = 0; i < 40; i++) ins.run(10 + i, 'X'.repeat(2000))
    const out = await call('memory_get_session', { id: 10 })
    expect(out.length).toBeLessThan(45_000)
    expect(out).toContain('字符上限')
    expect(out).toContain('tail=N')
    // full=true 放宽到 8 万,但仍不是无上限
    const full = await call('memory_get_session', { id: 10, full: true })
    expect(full.length).toBeGreaterThan(out.length)
    expect(full.length).toBeLessThan(85_000)
  })

  /**
   * 回归:预算不够时保留的是**最新**的消息,不是最旧的。
   *
   * 之前正向遍历 + break,保留头部丢尾部 —— 而这条工具的存在意义正是
   * 「会话太长,看最近的」。实测真实会话 #260(7303 条)输出 39,203 字符里
   * 含 seq 0…120、不含最新一条,与文案完全相反。
   */
  it('keeps the newest messages when the budget forces truncation', async () => {
    const ins = db.prepare(
      `INSERT INTO session_messages (session_id, seq, role, content) VALUES (99, ?, 'assistant', ?)`
    )
    db.prepare(
      `INSERT INTO sessions (id, agent_type, external_id, started_at, title, content_hash, message_count, tool_call_count, updated_at, device_id)
       VALUES (99, 'codex', 'big', 1, '超长会话', 'hbig', 60, 0, 1, 'local')`
    ).run()
    for (let i = 0; i < 60; i += 1) ins.run(i, `MSG-${String(i).padStart(2, '0')}-${'X'.repeat(2000)}`)

    const out = await call('memory_get_session', { id: 99 })
    expect(out).toContain('字符上限')
    expect(out).toContain('保留了**最近**')
    // 最后一条必须在,最早几条应被丢掉
    expect(out).toContain('MSG-59-')
    expect(out).not.toContain('MSG-00-')
    // 保留的窗口是连续的最新一段,不是零散抽样
    expect(out).toContain('MSG-58-')
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
