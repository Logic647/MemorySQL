import { describe, expect, it } from 'vitest'
import { handleRpc, parseRpcMessage, type McpToolLike } from '../src/main/core/mcp-protocol'

const tools: McpToolLike[] = [
  {
    name: 'memory_search',
    description: 'search',
    inputSchema: { type: 'object' },
    handler: (args) => `results for ${String(args.query)}`
  },
  {
    name: 'boom',
    description: 'throws',
    inputSchema: { type: 'object' },
    handler: () => {
      throw new Error('kaboom')
    }
  }
]

describe('mcp protocol', () => {
  it('initialize returns protocol version and tool capability', async () => {
    const res = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, tools)
    const result = (res as { result: Record<string, unknown> }).result
    expect(result.protocolVersion).toBe('2025-06-18')
    expect(result.serverInfo).toMatchObject({ name: 'memorysql' })
  })

  it('tools/list exposes names and schemas only', async () => {
    const res = (await handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, tools)) as {
      result: { tools: Array<Record<string, unknown>> }
    }
    expect(res.result.tools).toHaveLength(2)
    expect(res.result.tools[0]).toMatchObject({ name: 'memory_search' })
    expect(res.result.tools[0]).not.toHaveProperty('handler')
  })

  it('tools/call returns text content and serializes object results', async () => {
    const res = (await handleRpc(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory_search', arguments: { query: '远程' } } },
      tools
    )) as { result: { content: Array<{ type: string; text: string }>; isError?: boolean } }
    expect(res.result.isError).toBeUndefined()
    expect(res.result.content[0].text).toBe('results for 远程')
  })

  it('tool exceptions become isError results, not protocol errors', async () => {
    const res = (await handleRpc(
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'boom', arguments: {} } },
      tools
    )) as { result: { isError: boolean; content: Array<{ text: string }> } }
    expect(res.result.isError).toBe(true)
    expect(res.result.content[0].text).toContain('kaboom')
  })

  it('unknown tools are protocol errors; unknown methods are -32601', async () => {
    const badTool = (await handleRpc(
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope' } },
      tools
    )) as { error: { code: number } }
    expect(badTool.error.code).toBe(-32602)

    const badMethod = (await handleRpc({ jsonrpc: '2.0', id: 6, method: 'x/y' }, tools)) as {
      error: { code: number }
    }
    expect(badMethod.error.code).toBe(-32601)
  })

  it('notifications produce null responses', async () => {
    expect(await handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, tools)).toBeNull()
  })

  it('parseRpcMessage rejects malformed input', () => {
    expect(parseRpcMessage('not json')).toBeNull()
    expect(parseRpcMessage('{"id":1}')).toBeNull()
    expect(parseRpcMessage('{"id":1,"method":"tools/list"}')?.method).toBe('tools/list')
  })
})
