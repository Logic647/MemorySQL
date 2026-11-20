// 可选后端：代理一台正在运行的 MemorySQL 应用（127.0.0.1 的 MCP）。
// 适合已经有 MemorySQL 桌面应用、想要完整会话捕获/LLM 项目总结的用户。
import { callTool, getEndpoint } from '../endpoint.mjs'

export function createAppBackend(options = {}) {
  return {
    kind: 'app',
    async call(name, args = {}, { timeoutMs = 30_000, signal } = {}) {
      return callTool(name, args, options, { timeoutMs, signal })
    },
    async status() {
      const endpoint = await getEndpoint(options, { scan: true })
      if (!endpoint) {
        return {
          ok: false,
          backend: 'app',
          error: 'MemorySQL 应用未运行（127.0.0.1 上找不到 /health）'
        }
      }
      let stats = endpoint.stats
      try {
        stats = JSON.parse(await callTool('memory_stats', {}, options, { timeoutMs: 4000 }))
      } catch {
        /* 旧版 MemorySQL 没有 memory_stats：用 /health 的 stats */
      }
      return {
        ok: true,
        backend: 'app',
        version: endpoint.version,
        port: endpoint.port,
        tools: endpoint.tools,
        stats
      }
    },
    close() {}
  }
}
