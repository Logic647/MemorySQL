// 一个最小的 MemorySQL MCP 替身：/health + /mcp(tools/call)。
// 只实现本插件用到的部分，便于在 node --test 里跑，不需要 Electron。
import http from 'node:http'

function write(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/**
 * @param {Record<string, (args: object) => string | unknown>} handlers
 *        tool 名 → 返回值；抛错会变成 MCP 的 isError。
 */
export async function fakeMemorySQL(handlers = {}) {
  const calls = []
  let port = 0
  const server = http.createServer((req, res) => {
    // 模拟 MemorySQL 的 Host 校验：只接受 127.0.0.1:<实际端口>
    if (String(req.headers.host ?? '') !== `127.0.0.1:${port}`) {
      res.writeHead(403).end()
      return
    }
    if (req.method === 'GET' && req.url === '/health') {
      write(res, 200, {
        ok: true,
        server: 'memorysql-mcp',
        port,
        version: '0.7.8',
        tools: 11,
        stats: { sessions: 3, memories: 5, projects: 1 }
      })
      return
    }
    if (req.method !== 'POST' || req.url !== '/mcp') {
      res.writeHead(404).end()
      return
    }
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      let message
      try {
        message = JSON.parse(raw)
      } catch {
        write(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse' } })
        return
      }
      calls.push(message)
      const name = message.params?.name
      const handler = handlers[name]
      if (!handler) {
        write(res, 200, {
          jsonrpc: '2.0',
          id: message.id,
          result: { content: [{ type: 'text', text: `ok:${name}` }] }
        })
        return
      }
      try {
        const out = handler(message.params?.arguments ?? {})
        write(res, 200, {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out) }]
          }
        })
      } catch (err) {
        write(res, 200, {
          jsonrpc: '2.0',
          id: message.id,
          result: { content: [{ type: 'text', text: String(err?.message ?? err) }], isError: true }
        })
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
  return {
    port,
    calls,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  }
}
