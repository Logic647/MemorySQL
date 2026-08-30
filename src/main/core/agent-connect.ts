import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'

/**
 * 连接向导:为检测到的 agent 一键写入 MemorySQL 的 MCP 配置。
 * 幂等(重复执行覆盖同一条目),写入前备份原文件为 *.bak-memorysql。
 * 已验证格式:Codex(TOML append)、ZCode(http)、Claude Code(http)、
 * OpenCode(http);Gemini/Cursor 走社区文档格式(stdio/http)。
 */

export interface AgentConnector {
  id: string
  label: string
  /** agent 本机安装痕迹(配置或数据目录存在) */
  detect: (home: string, appData?: string) => boolean
  configPath: (home: string, appData?: string) => string
  apply: (configPath: string, mcpUrl: string, bridgePath: string) => string
  snippet: (mcpUrl: string, bridgePath: string) => string
}

function mergeJson(
  configPath: string,
  mutate: (root: Record<string, unknown>) => void
): string {
  let root: Record<string, unknown> = {}
  if (fs.existsSync(configPath)) {
    fs.copyFileSync(configPath, `${configPath}.bak-memorysql`)
    try {
      root = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>
    } catch {
      throw new Error(`${configPath} 不是有效 JSON,请先手工修复`)
    }
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  mutate(root)
  fs.writeFileSync(configPath, JSON.stringify(root, null, 2), 'utf-8')
  return configPath
}

function setNested(root: Record<string, unknown>, keys: string[], value: unknown): void {
  let node = root
  for (const key of keys.slice(0, -1)) {
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = {}
    node = node[key] as Record<string, unknown>
  }
  node[keys[keys.length - 1]] = value
}

function upsertTomlBlock(configPath: string, block: string, header: string): string {
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  let content = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : ''
  const re = new RegExp(
    `\\[mcp_servers\\.${header}\\][\\s\\S]*?(?=\\n\\[|$)`
  )
  if (re.test(content)) {
    content = content.replace(re, block.trimEnd() + '\n')
  } else {
    content = content.replace(/\s*$/, '\n\n') + block.trimEnd() + '\n'
  }
  fs.writeFileSync(configPath, content, 'utf-8')
  return configPath
}

export function bridgeScriptPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'mcp-bridge.mjs')
    : path.join(app.getAppPath(), 'scripts', 'mcp-bridge.mjs')
}

export function mcpUrl(port: number): string {
  return `http://127.0.0.1:${port}/mcp`
}

const HTTP_ENTRY = (url: string) => ({ type: 'http', url })

export const AGENT_CONNECTORS: AgentConnector[] = [
  {
    id: 'codex',
    label: 'Codex CLI',
    detect: (home) => fs.existsSync(path.join(home, '.codex')),
    configPath: (home) => path.join(home, '.codex', 'config.toml'),
    apply: (configPath, _url, bridge) =>
      upsertTomlBlock(
        configPath,
        `[mcp_servers.memorysql]
command = "node"
args = ["${bridge.replace(/\\/g, '\\\\')}"]
startup_timeout_sec = 30`,
        'memorysql'
      ),
    snippet: (_url, bridge) =>
      `# ~/.codex/config.toml 追加:\n[mcp_servers.memorysql]\ncommand = "node"\nargs = ["${bridge.replace(/\\/g, '\\\\')}"]`
  },
  {
    id: 'zcode',
    label: 'ZCode',
    detect: (home) => fs.existsSync(path.join(home, '.zcode')),
    configPath: (home) => path.join(home, '.zcode', 'cli', 'config.json'),
    apply: (configPath, url) =>
      mergeJson(configPath, (root) => {
        setNested(root, ['mcp', 'servers', 'memorysql'], HTTP_ENTRY(url))
      }),
    snippet: (url) =>
      `// ~/.zcode/cli/config.json 的 mcp.servers 中加:\n"memorysql": { "type": "http", "url": "${url}" }`
  },
  {
    id: 'claudecode',
    label: 'Claude Code',
    detect: (home) => fs.existsSync(path.join(home, '.claude')),
    configPath: (home) => path.join(home, '.claude.json'),
    apply: (configPath, url) =>
      mergeJson(configPath, (root) => {
        setNested(root, ['mcpServers', 'memorysql'], HTTP_ENTRY(url))
      }),
    snippet: (url) =>
      `claude mcp add --transport http memorysql ${url}\n# 或 ~/.claude.json 的 mcpServers 中加:\n"memorysql": { "type": "http", "url": "${url}" }`
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    detect: (home) => fs.existsSync(path.join(home, '.gemini')),
    configPath: (home) => path.join(home, '.gemini', 'settings.json'),
    apply: (configPath, _url, bridge) =>
      mergeJson(configPath, (root) => {
        setNested(root, ['mcpServers', 'memorysql'], {
          command: 'node',
          args: [bridge]
        })
      }),
    snippet: (_url, bridge) =>
      `// ~/.gemini/settings.json 的 mcpServers 中加:\n"memorysql": { "command": "node", "args": ["${bridge.replace(/\\/g, '\\\\')}"] }`
  },
  {
    id: 'cursor',
    label: 'Cursor',
    detect: (home, appData) =>
      fs.existsSync(path.join(home, '.cursor')) ||
      (appData ? fs.existsSync(path.join(appData, 'Cursor')) : false),
    configPath: (home) => path.join(home, '.cursor', 'mcp.json'),
    apply: (configPath, url) =>
      mergeJson(configPath, (root) => {
        setNested(root, ['mcpServers', 'memorysql'], HTTP_ENTRY(url))
      }),
    snippet: (url) =>
      `// ~/.cursor/mcp.json:\n{\n  "mcpServers": {\n    "memorysql": { "url": "${url}" }\n  }\n}`
  },
  {
    id: 'opencode',
    label: 'OpenCode / Copilot CLI',
    detect: (home, localAppData) =>
      fs.existsSync(path.join(home, '.local', 'share', 'opencode')) ||
      (localAppData ? fs.existsSync(path.join(localAppData, 'opencode')) : false),
    configPath: (home) => path.join(home, '.config', 'opencode', 'opencode.json'),
    apply: (configPath, url) =>
      mergeJson(configPath, (root) => {
        setNested(root, ['mcp', 'memorysql'], { url, enabled: true })
      }),
    snippet: (url) =>
      `// ~/.config/opencode/opencode.json:\n{\n  "mcp": {\n    "memorysql": { "url": "${url}", "enabled": true }\n  }\n}`
  }
]

export interface AgentConnectResult {
  id: string
  label: string
  detected: boolean
  configured: boolean
  configPath: string | null
  snippet: string
}

export function connectAgent(
  agentId: string,
  port: number,
  appData?: string,
  localAppData?: string
): AgentConnectResult {
  const connector = AGENT_CONNECTORS.find((a) => a.id === agentId)
  const home = os.homedir()
  if (!connector) throw new Error(`不支持的 agent: ${agentId}`)
  const url = mcpUrl(port)
  const bridge = bridgeScriptPath()
  const detected = connector.detect(home, appData ?? localAppData)
  const snippet = connector.snippet(url, bridge)
  let configPath: string | null = null
  let configured = false
  if (detected) {
    configPath = connector.configPath(home, appData ?? localAppData)
    connector.apply(configPath, url, bridge)
    configured = true
  }
  return { id: connector.id, label: connector.label, detected, configured, configPath, snippet }
}

export function agentSnippet(
  agentId: string,
  port: number,
  appData?: string,
  localAppData?: string
): AgentConnectResult {
  return connectAgent(agentId, port, appData, localAppData)
}
