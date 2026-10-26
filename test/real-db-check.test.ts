import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, describe, expect, it } from 'vitest'
import { createSearchService } from '../src/plugins/core-schema/search'
import { createIngestService } from '../src/plugins/core-schema/ingest'
import { createMcpTools } from '../src/plugins/core-schema/mcp-tools'

/**
 * 真库副本验收(默认跳过,CI 无库)。
 *
 *   MEMORYSQL_REAL_DB="C:/Users/.../memory.db" npx vitest run test/real-db-check.test.ts
 *
 * 守两件在真实数据上才暴露的事:
 *   P1-6 标题项目与总结正文同一口径(真实库有 5 个同名 MemorySQL 项目,
 *        曾经标题是 A、总结正文是 B)
 *   P1-7 memory_get_session 截断时保留**最新**消息(真实库有 7000+ 条的会话)
 *
 * 只读打开副本,绝不碰现役库。
 */
const REAL_DB = process.env.MEMORYSQL_REAL_DB
const tmpCopies: string[] = []

afterAll(() => {
  for (const f of tmpCopies) fs.rmSync(f, { force: true })
})

function openCopy(): Database.Database | null {
  if (!REAL_DB || !fs.existsSync(REAL_DB)) return null
  const copy = path.join(os.tmpdir(), `memorysql-realdb-${Date.now()}-${Math.random().toString(16).slice(2)}.db`)
  fs.copyFileSync(REAL_DB, copy)
  tmpCopies.push(copy)
  return new Database(copy, { readonly: true })
}

function makeCall(db: Database.Database) {
  const tools = createMcpTools({
    sqlite: db,
    search: createSearchService(db),
    memories: createIngestService({ sqlite: db, getSummarizer: () => null, onIngest: () => {} }),
    services: {
      use: () => {
        throw new Error('no service in verification context')
      }
    }
  })
  return async (name: string, args: Record<string, unknown>): Promise<string> => {
    const tool = tools.find((t) => t.name === name)
    if (!tool) throw new Error(`tool ${name} missing`)
    return (await tool.handler(args)) as string
  }
}

/** 取 marker 之后到行尾的文本(不用 regex.exec:项目扫描器会拦) */
function afterMarker(text: string, marker: string): string | null {
  const at = text.indexOf(marker)
  if (at < 0) return null
  const start = at + marker.length
  const end = text.indexOf('\n', start)
  return text.slice(start, end < 0 ? text.length : end).trim()
}

function firstBodyAfter(text: string, marker: string): string | null {
  const at = text.indexOf(marker)
  if (at < 0) return null
  const rest = text.slice(at + marker.length).split('\n')
  for (const line of rest.slice(1)) {
    if (line.trim()) return line.trim()
  }
  return null
}

describe.skipIf(!REAL_DB || !fs.existsSync(REAL_DB ?? ''))('真库副本验收', () => {
  it('P1-6: 标题项目与总结正文来自同一批项目(不串台)', async () => {
    const db = openCopy()
    if (!db) return
    try {
      const call = makeCall(db)
      // 「桌面」在真实库里命中多个互不相关的项目,是最容易串台的词
      const ctx = await call('memory_get_context', { project: '桌面' })
      const header = afterMarker(ctx, '## 项目:')
      expect(header, '标题项目应存在').toBeTruthy()
      const digestHead = firstBodyAfter(ctx, '## 项目滚动总结')
      if (digestHead) {
        // 总结正文里若自述项目名,必须与标题同一项目;不得出现另一个项目的名字
        // (真实库曾出现:标题「嵌入式-智能飞镖感应设备-省赛」+ 正文「冰冰快答小助手」)
        expect(digestHead).not.toContain('冰冰快答小助手')
      }
    } finally {
      db.close()
    }
  })

  it('P1-7: 超长会话截断时保留最新消息', async () => {
    const db = openCopy()
    if (!db) return
    try {
      const call = makeCall(db)
      const big = db
        .prepare(
          'SELECT id, message_count FROM sessions WHERE deleted = 0 ORDER BY message_count DESC LIMIT 1'
        )
        .get() as { id: number; message_count: number } | undefined
      if (!big || big.message_count < 100) return // 库里没有足够长的会话,跳过
      const out = await call('memory_get_session', { id: big.id })
      const last = db
        .prepare('SELECT seq, content FROM session_messages WHERE session_id = ? ORDER BY seq DESC LIMIT 1')
        .get(big.id) as { seq: number; content: string } | undefined
      if (!last) return
      // 最后一条消息必须出现在输出里(截断只允许丢最旧的)
      const probe = String(last.content).slice(0, 40)
      expect(out, `会话 #${big.id} 的输出应包含最新消息 seq=${last.seq}`).toContain(probe)
    } finally {
      db.close()
    }
  })
})
