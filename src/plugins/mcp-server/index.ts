import http from 'node:http'
import type { MemorySQLPlugin } from '../../main/core/plugin-host'
import type { PluginContext } from '../../main/core/plugin-host'
import { handleRpc, parseRpcMessage, type JsonRpcRequest } from '../../main/core/mcp-protocol'

/**
 * Serves every tool registered through ctx.mcp over MCP Streamable HTTP
 * (stateless subset: POST /mcp with JSON responses) bound to 127.0.0.1.
 * CLI agents that only speak stdio use scripts/mcp-bridge.mjs as a shim.
 */

let server: http.Server | null = null
let running = false
let runtimeCtx: PluginContext | null = null

function currentPort(): number {
  return Number(runtimeCtx?.settings.get('port', 8642) ?? 8642)
}

function startServer(): void {
  if (!runtimeCtx) return
  const ctx = runtimeCtx
  const enabled = ctx.settings.get('enabled', true)
  if (!enabled) {
    ctx.log.info('disabled in settings, not starting')
    return
  }
  const port = currentPort()
  server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, server: 'memorysql-mcp' }))
      return
    }
    if (req.method !== 'POST' || req.url !== '/mcp') {
      res.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      void (async () => {
        const msg = parseRpcMessage(Buffer.concat(chunks).toString('utf-8'))
        if (!msg) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
          )
          return
        }
        const response = await handleRpc(msg as JsonRpcRequest, ctx.mcp.list())
        if (response === null) {
          res.writeHead(202).end()
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(response))
      })().catch((e) => {
        ctx.log.error('mcp request failed:', e)
        if (!res.headersSent) res.writeHead(500)
        res.end()
      })
    })
  })
  server.on('error', (e) => ctx.log.error(`MCP server error on port ${port}:`, e))
  // localhost only — the knowledge base is private, never expose it
  server.listen(port, '127.0.0.1', () => {
    running = true
    ctx.log.info(`MCP server on http://127.0.0.1:${port}/mcp (${ctx.mcp.list().length} tools)`)
  })
}

function stopServer(): void {
  if (server) {
    server.close()
    server = null
  }
  running = false
}

const plugin: MemorySQLPlugin = {
  manifest: {
    id: 'mcp-server',
    name: 'MCP Server',
    version: '0.1.0'
  },

  init(ctx) {
    runtimeCtx = ctx

    ctx.ipc.handle('status', () => ({
      enabled: ctx.settings.get('enabled', true),
      port: currentPort(),
      running,
      toolCount: ctx.mcp.list().length
    }))

    ctx.ipc.handle('restart', () => {
      stopServer()
      startServer()
      return { ok: true, running }
    })
  },

  start() {
    startServer()
  },

  stop() {
    stopServer()
    runtimeCtx = null
  }
}

export default plugin
