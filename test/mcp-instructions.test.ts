import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { CORE_MIGRATIONS } from '../src/plugins/core-schema/migrations'
import { createSearchService } from '../src/plugins/core-schema/search'
import { createIngestService } from '../src/plugins/core-schema/ingest'
import { createMcpTools } from '../src/plugins/core-schema/mcp-tools'
import { handleRpc } from '../src/main/core/mcp-protocol'
import { MEMORYSQL_INSTRUCTIONS, WHEN_PREFIX } from '../src/shared/mcp-instructions'

/**
 * 「让 agent 主动调用」靠的是协议层的三件事,这里逐条锁住:
 *  1. initialize 必须带 instructions(客户端可以把它塞进系统提示)
 *  2. 每个工具的 description 必须以【何时调用】开头(模型照着描述决定要不要调)
 *  3. 新增工具不许退回「只介绍这是什么」——用出现次数兜底
 */

const ROOT = path.resolve(import.meta.dirname, '..')

let db: Database.Database
let tools: ReturnType<typeof createMcpTools>

beforeAll(() => {
  db = new Database(':memory:')
  for (const m of CORE_MIGRATIONS) db.exec(m.up)
  tools = createMcpTools({
    sqlite: db,
    search: createSearchService(db),
    memories: createIngestService({ sqlite: db, getSummarizer: () => null, onIngest: () => {} }),
    services: { use: (name: string): never => { throw new Error(`no service ${name}`) } }
  })
})

describe('MCP 协议层:主动调用的引导', () => {
  it('initialize 带 instructions,且写清了调用时机与预算', async () => {
    const res = (await handleRpc(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      [],
      { name: 'memorysql', version: '0.0.0' },
      MEMORYSQL_INSTRUCTIONS
    )) as { result: Record<string, unknown> }
    expect(typeof res.result.instructions).toBe('string')
    const text = String(res.result.instructions)
    // 四个时机 + 预算约束都要在,否则模型只知道"有这个工具"
    for (const kw of ['memory_get_context', 'memory_search', 'memory_write', 'memory_log_progress']) {
      expect(text).toContain(kw)
    }
    expect(text).toMatch(/最多调一次/)
  })

  it('不传 instructions 时字段不出现(保持向后兼容)', async () => {
    const res = (await handleRpc(
      { jsonrpc: '2.0', id: 2, method: 'initialize' },
      [],
      { name: 'memorysql', version: '0.0.0' }
    )) as { result: Record<string, unknown> }
    expect('instructions' in res.result).toBe(false)
  })

  it('每个 memory_* 工具的描述都以【何时调用】开头', () => {
    expect(tools.length).toBeGreaterThan(6)
    const bad = tools.filter((t) => !t.description.startsWith(WHEN_PREFIX)).map((t) => t.name)
    expect(bad, `这些工具的描述没写明何时调用: ${bad.join(', ')}`).toEqual([])
  })

  it('新增 memory_* 工具时不会漏掉触发说明(按源码计数)', () => {
    const files = ['src/plugins/core-schema/mcp-tools.ts', 'src/plugins/project-digest/index.ts']
    for (const rel of files) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8')
      const declared = (src.match(/name:\s*'memory_[a-z0-9_]+'/g) ?? []).length
      const prefixed = (src.match(/【何时调用】/g) ?? []).length
      expect(prefixed, `${rel}: 声明了 ${declared} 个 memory_* 工具,但只有 ${prefixed} 个带【何时调用】`).toBe(declared)
    }
  })
})
