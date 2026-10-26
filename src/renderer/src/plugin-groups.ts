import { BUILTIN_PLUGIN_IDS } from '../../shared/builtin-plugins'

/**
 * 设置页「插件」分区的分组定义 —— 纯数据,单测断言与 BUILTIN_PLUGIN_IDS
 * 完全对齐(新增插件漏登记会红,见 test/plugin-groups.test.ts)。
 */
export interface PluginGroup {
  id: string
  label: string
  pluginIds: string[]
}

export const PLUGIN_GROUPS: PluginGroup[] = [
  { id: 'core', label: '核心数据', pluginIds: ['core-schema'] },
  { id: 'summarizer', label: '摘要引擎', pluginIds: ['summarizer-llm', 'summarizer-rules'] },
  {
    id: 'capture',
    label: '会话捕获',
    pluginIds: [
      'capture-codex',
      'capture-zcode',
      'capture-hermes',
      'capture-claudecode',
      'capture-qwencode',
      'capture-kimicli',
      'capture-codebuddy',
      'capture-workbuddy',
      'capture-qoder',
      'capture-gemini',
      'capture-cursor',
      'capture-opencode',
      'capture-dsh',
      'capture-watcher',
      'import-chat'
    ]
  },
  {
    id: 'memory',
    label: '项目与记忆',
    pluginIds: ['memory-core', 'memory-dispatch', 'project-devlog', 'project-digest']
  },
  { id: 'service', label: '检索与服务', pluginIds: ['semantic-search', 'mcp-server'] },
  { id: 'sync', label: '同步与备份', pluginIds: ['sync-archive', 'sync-folder', 'privacy-export'] },
  { id: 'system', label: '系统', pluginIds: ['core-launcher'] }
]

export const EXTERNAL_GROUP: PluginGroup = { id: 'external', label: '外部插件', pluginIds: [] }

export interface PluginListEntry {
  id: string
  name: string
  version: string
  enabled: boolean
  external: boolean
}

/**
 * 把插件列表装进分组:内置按 PLUGIN_GROUPS,外部插件单独一组,
 * 漏登记的内置插件兜底进「其他」组(单测保证这组恒为空,出现即漏配)。
 */
export function groupedPlugins(list: PluginListEntry[]): Array<{ group: PluginGroup; plugins: PluginListEntry[] }> {
  const grouped = PLUGIN_GROUPS.map((group) => ({
    group,
    plugins: list.filter((p) => !p.external && group.pluginIds.includes(p.id))
  }))
  const seen = new Set(PLUGIN_GROUPS.flatMap((g) => g.pluginIds))
  const rest = list.filter((p) => !p.external && !seen.has(p.id) && (BUILTIN_PLUGIN_IDS as readonly string[]).includes(p.id))
  if (rest.length > 0) grouped.push({ group: { id: 'other', label: '其他', pluginIds: rest.map((p) => p.id) }, plugins: rest })
  const ext = list.filter((p) => p.external)
  if (ext.length > 0) grouped.push({ group: EXTERNAL_GROUP, plugins: ext })
  return grouped.filter((g) => g.plugins.length > 0)
}
