import { describe, expect, it } from 'vitest'
import { Db } from '../src/main/core/db'
import { CORE_MIGRATIONS } from '../src/plugins/core-schema/migrations'
import { createMcpTools } from '../src/plugins/core-schema/mcp-tools'
import { createSearchService } from '../src/plugins/core-schema/search'
import type { McpToolDef } from '../src/main/core/plugin-host'

/**
 * 「最近 N 天」必须按**最后一次对话时间**截窄,不能按会话开始时间。
 *
 * 这是「最后一次对话时间」上线后最容易回退的一处:新列加上了,但旧的
 * since 过滤/排序都还在用 started_at —— 结果「开始很早但最近还在聊」的会话
 * 被 since 排除,正好和这次变更要解决的事情相反。
 */

const DAY = 86400

function setup(): { db: Db; tools: McpToolDef[] } {
  const store = new Db(':memory:')
  store.migrate('core-schema', CORE_MIGRATIONS)
  const search = createSearchService(store.sqlite)
  const tools = createMcpTools({
    sqlite: store.sqlite,
    search,
    // memories 服务在 since/排序用例里用不到,给个最小替身
    memories: {
      upsertMemory: () => ({ id: 0, changed: false }),
      addMemory: () => ({ id: 0 })
    },
    services: { use: <T>(): T => ({}) as T }
  })
  return { db: store, tools }
}

/** 造一条会话:startedAt 开始,lastMessageAt 最后一次对话 */
function addSession(
  store: Db,
  id: number,
  opts: { startedAt: number; lastMessageAt: number | null; title?: string }
): void {
  const last = opts.lastMessageAt ?? opts.startedAt
  store.sqlite
    .prepare(
      `INSERT INTO sessions (id, agent_type, external_id, started_at, ended_at, last_message_at,
                             title, content_hash, message_count, tool_call_count, updated_at, device_id)
       VALUES (?, 'zcode', ?, ?, ?, ?, ?, 'h', 1, 0, ?, 'local')`
    )
    .run(id, `s${id}`, opts.startedAt, last, last, opts.title ?? `会话 ${id}`, last * 1000)
}

const call = (tools: McpToolDef[], name: string, args: Record<string, unknown>): string => {
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error(`tool not found: ${name}`)
  return String(tool.handler(args))
}

describe('memory_list_sessions — since 按最后一次对话时间', () => {
  it('把「开始很早但最近还在聊」的会话算进最近 N 天', () => {
    const { db, tools } = setup()
    const now = Math.floor(Date.now() / 1000)
    // 3 周前开始、昨天还在聊
    addSession(db, 1, { startedAt: now - 21 * DAY, lastMessageAt: now - DAY })
    // 上周开始、上周就结束
    addSession(db, 2, { startedAt: now - 7 * DAY, lastMessageAt: now - 6 * DAY })

    const out = call(tools, 'memory_list_sessions', { since: 7 })
    expect(out).toContain('#1')
    expect(out).toContain('#2')
    db.close()
  })

  it('最近还在聊的会话排在只开了个头的会话前面', () => {
    const { db, tools } = setup()
    const now = Math.floor(Date.now() / 1000)
    // 上周开始、至今还在聊(比「今天开始今天结束」更活跃)
    addSession(db, 1, { startedAt: now - 7 * DAY, lastMessageAt: now - 3600 })
    // 今天开始、今天上午就结束了
    addSession(db, 2, { startedAt: now - 7200, lastMessageAt: now - 6000 })

    const out = call(tools, 'memory_list_sessions', {})
    expect(out.indexOf('#1')).toBeLessThan(out.indexOf('#2'))
    db.close()
  })
})

describe('memory_get_context — recentSessions 按最后一次对话时间', () => {
  it('「最近活跃会话」是最近还在聊的那条,不是最近开始的那条', () => {
    const { db, tools } = setup()
    const now = Math.floor(Date.now() / 1000)
    addSession(db, 1, { startedAt: now - 30 * DAY, lastMessageAt: now - 600, title: '老会话仍在续聊' })
    addSession(db, 2, { startedAt: now - 300, lastMessageAt: now - 240, title: '今天的新会话' })

    const out = call(tools, 'memory_get_context', {})
    // 更近活跃的（今天的新会话，240s 前）排在更早的（老会话仍在续聊，600s 前）前面
    expect(out.indexOf('今天的新会话')).toBeLessThan(out.indexOf('老会话仍在续聊'))
    db.close()
  })
})

describe('memory_search — since 按最后一次对话时间', () => {
  it('「开始很早但最近还在聊」的会话不被 since 排除', () => {
    const store = new Db(':memory:')
    store.migrate('core-schema', CORE_MIGRATIONS)
    const now = Math.floor(Date.now() / 1000)
    addSession(store, 1, { startedAt: now - 21 * DAY, lastMessageAt: now - DAY, title: '上周还在聊的老会话' })
    addSession(store, 2, { startedAt: now - 40 * DAY, lastMessageAt: now - 40 * DAY, title: '早已结束的老会话' })
    // 会话 FTS 由触发器同步(与 ingest 写 sessions_fts 的路径一致)
    store.sqlite
      .prepare(`INSERT INTO sessions_fts (rowid, title, summary) SELECT id, title, summary FROM sessions`)
      .run()
    const search = createSearchService(store.sqlite)

    const hits = search.searchAll('老会话', 20, { sinceSec: now - 7 * DAY })
    const ids = hits.filter((h) => h.kind === 'session').map((h) => h.id)
    expect(ids).toContain(1)
    expect(ids).not.toContain(2)
    store.close()
  })
})
