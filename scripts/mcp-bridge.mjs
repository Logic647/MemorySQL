#!/usr/bin/env node
/**
 * MemorySQL MCP stdio bridge.
 *
 * Some agent CLIs (Codex 等) only support stdio MCP servers. This shim is
 * spawned by the agent, forwards JSON-RPC over stdin to the MemorySQL app's
 * local MCP HTTP endpoint, and writes responses back to stdout.
 *
 * Config (Codex ~/.codex/config.toml 示例):
 *   [mcp_servers.memorysql]
 *   command = "node"
 *   args = ["F:/桌面/MemorySQL/scripts/mcp-bridge.mjs"]
 *   env = { MEMORYSQL_MCP_PORT = "8642" }
 *
 * The MemorySQL desktop app must be running.
 */
import http from 'node:http'
import readline from 'node:readline'

const port = Number(process.env.MEMORYSQL_MCP_PORT || 8642)
const endpoint = `http://127.0.0.1:${port}/mcp`

function post(body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      endpoint,
      { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' } },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          if (res.statusCode === 202) return resolve(null)
          const text = Buffer.concat(chunks).toString('utf-8')
          try {
            resolve(JSON.parse(text))
          } catch {
            reject(new Error(`invalid response: ${text.slice(0, 200)}`))
          }
        })
      }
    )
    req.on('error', reject)
    req.end(body)
  })
}

const rl = readline.createInterface({ input: process.stdin })
process.stdout.write(`[memorysql-bridge] -> ${endpoint}\n`)

rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  post(trimmed)
    .then((resp) => {
      if (resp !== null) process.stdout.write(JSON.stringify(resp) + '\n')
    })
    .catch((err) => {
      // reply with a JSON-RPC error so the client sees a clean failure
      let id = null
      try {
        id = JSON.parse(trimmed)?.id ?? null
      } catch {}
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message: `bridge: cannot reach MemorySQL at ${endpoint} — is the app running? (${err.message})` }
        }) + '\n'
      )
    })
})
rl.on('close', () => process.exit(0))
