/**
 * Minimal MCP (Model Context Protocol) JSON-RPC 2.0 protocol handling —
 * pure functions over request objects so the protocol is unit-testable
 * without HTTP. Implements the stateless subset of Streamable HTTP:
 * initialize / tools/list / tools/call / ping, notifications accepted
 * without response.
 */
export interface McpToolLike {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown
}

export const MCP_PROTOCOL_VERSION = '2025-06-18'
/**
 * Fallback identity for tests. Production (mcp-server plugin) injects the
 * real app version from app.getVersion() so package.json stays the single
 * source of truth — a hardcoded version here drifted from releases before.
 */
export const SERVER_INFO = { name: 'memorysql', version: '0.0.0' }

export interface JsonRpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

function ok(id: JsonRpcRequest['id'], result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, result }
}

function err(id: JsonRpcRequest['id'], code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, data } }
}

function textResult(text: string): unknown {
  return { content: [{ type: 'text', text }] }
}

/**
 * Handle one JSON-RPC request. Returns a response object for requests,
 * null for notifications. Unknown/throwing tool calls become tool errors
 * (isError: true) rather than protocol errors, per MCP convention.
 */
export async function handleRpc(
  req: JsonRpcRequest,
  tools: McpToolLike[],
  serverInfo: { name: string; version: string } = SERVER_INFO
): Promise<JsonRpcResponse | null> {
  const method = req.method ?? ''
  const isNotification = req.id === undefined || req.id === null

  switch (method) {
    case 'initialize':
      if (isNotification) return null
      return ok(req.id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo
      })
    case 'notifications/initialized':
      return null
    case 'ping':
      return isNotification ? null : ok(req.id, {})
    case 'tools/list':
      if (isNotification) return null
      return ok(req.id, {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema
        }))
      })
    case 'tools/call': {
      if (isNotification) return null
      const name = String(req.params?.name ?? '')
      const tool = tools.find((t) => t.name === name)
      if (!tool) {
        return err(req.id, -32602, `Unknown tool: ${name}`)
      }
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>
      try {
        const result = await tool.handler(args)
        return ok(req.id, textResult(typeof result === 'string' ? result : JSON.stringify(result, null, 2)))
      } catch (e) {
        return ok(req.id, {
          content: [{ type: 'text', text: `Tool error: ${String(e)}` }],
          isError: true
        })
      }
    }
    default:
      if (method.startsWith('notifications/')) return null
      return isNotification ? null : err(req.id, -32601, `Method not found: ${method}`)
  }
}

/** Safely parse a JSON-RPC message; returns null on malformed input. */
export function parseRpcMessage(raw: string): JsonRpcRequest | null {
  try {
    const parsed = JSON.parse(raw) as JsonRpcRequest
    if (parsed && typeof parsed === 'object' && typeof parsed.method === 'string') return parsed
    return null
  } catch {
    return null
  }
}
