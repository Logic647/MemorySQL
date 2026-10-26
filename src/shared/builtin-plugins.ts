/**
 * 内置插件 id 清单 —— 与 src/main/index.ts 的 BUILTIN_PLUGINS 数组保持一致。
 *
 * 为什么单独放 shared:渲染层(设置页插件分组)与单测(分组全覆盖断言)都要读
 * 这份清单,而主入口 import electron,测试环境加载不了。主入口在启动时会做
 * 一次运行时一致性核对(不一致只在日志里报,不阻断启动)。
 */
export const BUILTIN_PLUGIN_IDS = [
  'summarizer-llm',
  'summarizer-rules',
  'core-schema',
  'core-launcher',
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
  'import-chat',
  'mcp-server',
  'privacy-export',
  'sync-archive',
  'memory-core',
  'memory-dispatch',
  'sync-folder',
  'project-devlog',
  'project-digest',
  'semantic-search'
] as const
