// MemorySQL for magpie —— 把「跨 agent 会话档案 + 项目交接」接进 magpie：
//   • 默认内置 SQLite 存储：用户只装本插件就能用，不需要 MemorySQL 桌面应用
//   • backend=app：可选代理本机正在运行的 MemorySQL（完整捕获/LLM 总结）
//   • tool 钩子：10 个 memorysql_* 工具，所有接 magpie MCP 的 agent 可用
//   • hooks.mjs：网关上自动续接（首轮注入）+ 会话回写
//   • page/ + service.mjs：magpie 窗口里的 MemorySQL 页
//
// 包名故意用 tools-memorysql：magpie 的短名规则会剥掉 tools-，
// 工具名因此是 memorysql_get_context，而不是 memorysql_tools_get_context。
import { getBackend } from './lib/backend/index.mjs'
import { toolsFor } from './lib/tools.mjs'
import { startService } from './service.mjs'

export default {
  id: 'memorysql',
  server: async (_input, options = {}) => {
    const backend = getBackend(options)
    // 页面服务不阻塞插件加载；数据库/端点在第一次工具/钩子调用时打开
    startService(options, backend)
    return toolsFor(options, backend)
  }
}
