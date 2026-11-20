// MemorySQL for magpie —— 把本地 MemorySQL 知识库接进 magpie：
//   • tool 钩子：10 个 memorysql_* 工具，所有接 magpie MCP 的 agent 可用
//   • hooks.mjs：网关上自动续接（首轮注入）+ 可选会话回写
//   • page/ + service.mjs：magpie 窗口里的 MemorySQL 页
//
// 包名故意用 tools-memorysql：magpie 的短名规则会剥掉 tools-，
// 工具名因此是 memorysql_get_context，而不是 memorysql_memory_get_context。
import { toolsFor } from './lib/tools.mjs'
import { getEndpoint } from './lib/endpoint.mjs'
import { startService } from './service.mjs'

export default {
  id: 'memorysql',
  server: async (_input, options = {}) => {
    // 后台预热端点缓存 + 起页面服务；都不阻塞插件加载（MemorySQL 可能还没启动）
    void getEndpoint(options, { scan: true }).catch(() => {})
    startService(options)
    return toolsFor(options)
  }
}
