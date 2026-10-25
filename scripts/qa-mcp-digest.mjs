/**
 * 一次性验收脚本:MCP 握手 → 列工具 → 调 memory_get_project_digest /
 * memory_get_project_brief,验证 0.7.0 新链路(dev 或装机版,端口 8642)。
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:8642/mcp'
let id = 0
async function rpc(method, params) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params })
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const ct = res.headers.get('content-type') ?? ''
  const raw = ct.includes('event-stream') ? (await res.text()).split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).pop() : await res.text()
  return raw ? JSON.parse(raw) : null
}
const init = await rpc('initialize', {
  protocolVersion: '2025-03-26',
  capabilities: {},
  clientInfo: { name: 'qa-digest', version: '0.0.0' }
})
console.log('initialized:', init.result.serverInfo.name, init.result.serverInfo.version)
await rpc('notifications/initialized', {})
const tools = await rpc('tools/list', {})
const names = tools.result.tools.map((t) => t.name)
console.log(`tools (${names.length}):`, names.join(', '))
const digest = await rpc('tools/call', { name: 'memory_get_project_digest', arguments: {} })
console.log('\n=== memory_get_project_digest ===')
console.log(String(digest.result.content?.[0]?.text ?? JSON.stringify(digest)).slice(0, 1200))
const brief = await rpc('tools/call', { name: 'memory_get_project_brief', arguments: {} })
const text = String(brief.result.content?.[0]?.text ?? '')
console.log('\n=== memory_get_project_brief(前 40 行) ===')
console.log(text.split('\n').slice(0, 40).join('\n'))
console.log('\nbrief 含滚动总结段:', text.includes('项目滚动总结'))
