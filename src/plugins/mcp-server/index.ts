import http from 'node:http'
import { app } from 'electron'
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
let effectivePort = 0
let portNote: string | null = null

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
  const requested = currentPort()
  let attempts = 0
  let port = requested
  portNote = null

  const listen = (): void => {
    server = http.createServer((req, res) => {
      // DNS-rebinding / cross-origin hardening: browsers always send Origin on
      // cross-site POSTs; MCP clients send neither. Anything unexpected → 403.
      const hostHeader = String(req.headers.host ?? '')
      if (!hostHeader.startsWith(`127.0.0.1:${port}`) && !hostHeader.startsWith(`localhost:${port}`)) {
        res.writeHead(403).end()
        return
      }
      const origin = req.headers.origin
      if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
        res.writeHead(403).end()
        return
      }
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, server: 'memorysql-mcp', port }))
        return
      }
      if (req.method !== 'POST' || req.url !== '/mcp') {
        res.writeHead(404).end()
        return
      }
      const chunks: Buffer[] = []
      let bytes = 0
      let tooLarge = false
      req.on('data', (c: Buffer) => {
        bytes += c.length
        if (bytes > 10 * 1024 * 1024) {
          tooLarge = true
          res.writeHead(413).end()
          req.destroy()
          return
        }
        if (!tooLarge) chunks.push(c)
      })
      req.on('error', () => {
        /* client aborted mid-request — nothing to answer */
      })
      res.on('error', () => {
        /* socket closed before response finished */
      })
      req.on('end', () => {
        if (tooLarge || res.writableEnded) return
        void (async () => {
          const msg = parseRpcMessage(Buffer.concat(chunks).toString('utf-8'))
          if (!msg) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(
              JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
            )
            return
          }
          const response = await handleRpc(msg as JsonRpcRequest, ctx.mcp.list(), {
            name: 'memorysql',
            version: app.getVersion()
          })
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
    server.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE' && attempts < 10) {
        attempts++
        portNote = `端口 ${port} 被占用,已自动改用 ${port + 1}(可在设置中固定)`
        ctx.log.warn(portNote)
        port += 1
        server?.close()
        listen()
        return
      }
      ctx.log.error(`MCP server error on port ${port}:`, e)
    })
    // localhost only — the knowledge base is private, never expose it
    server.listen(port, '127.0.0.1', () => {
      running = true
      effectivePort = port
      // conflict bump is runtime-only — the user's configured port stays put
      ctx.log.info(`MCP server on http://127.0.0.1:${port}/mcp (${ctx.mcp.list().length} tools)`)
    })
  }

  listen()
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
      port: effectivePort || currentPort(),
      requestedPort: currentPort(),
      running,
      toolCount: ctx.mcp.list().length,
      portNote
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
