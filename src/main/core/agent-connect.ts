import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AGENT_BY_ID } from '../../shared/upstream-agents'
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
  /**
   * 写后回读校验:返回 null 表示通过,否则返回给用户看的原因。
   *
   * 为什么必需 —— agent 侧的失败常常是**静默**的:OpenCode ≥2.0 会把缺 `type`
   * 的 mcp 条目判为 legacy 直接丢弃,只在自己日志里留一行 WARN,而连接向导却报告
   * 「已配置成功」。写完不回读,我们永远不知道自己写的东西有没有被接受。
   */
  verify?: (configPath: string, mcpUrl: string) => string | null
}

/** 极简 JSONPath 取值,支持 `$.a.b` 与 `a.b` 两种写法 */
function pickPath(root: unknown, jsonpath: string): unknown {
  const p = jsonpath.replace(/^\$\.?/, '')
  let node: unknown = root
  for (const key of p ? p.split('.') : []) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return node
}

/** 通用 JSON 回读校验,期望值全部来自契约台账(upstream/agents.ts) */
function verifyJsonEntry(
  configPath: string,
  jsonpath: string,
  requiredKeys: string[],
  valueHints: Record<string, string> = {}
): string | null {
  if (!fs.existsSync(configPath)) return `配置文件不存在:${configPath}`
  let root: unknown
  try {
    root = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
  } catch (e) {
    return `配置文件不是有效 JSON:${String(e)}`
  }
  const entry = pickPath(root, jsonpath)
  if (typeof entry !== 'object' || entry === null) {
    return `回读失败:配置里找不到 ${jsonpath}(该 agent 可能已改配置结构)`
  }
  const obj = entry as Record<string, unknown>
  const missing = requiredKeys.filter((k) => obj[k] === undefined || obj[k] === null)
  if (missing.length) {
    return `回读失败:${jsonpath} 缺少必需键 ${missing.join(', ')}(该 agent 可能因此忽略这条配置)`
  }
  const bad = Object.entries(valueHints).filter(([k, v]) => obj[k] !== v)
  if (bad.length) {
    return `回读失败:${bad.map(([k, v]) => `${k} 应为 ${v},实为 ${JSON.stringify(obj[k])}`).join('; ')}`
  }
  return null
}

/**
 * 给 JSON 类 connector 生成 verify —— 期望值取自契约台账,不多写一份。
 * URL 会被替换成 <url> 再返回,避免把本机端口/配置路径泄进面向用户的报错。
 * TOML(codex)/ YAML(hermes)不做 JSONPath 校验,故不给它们挂 verify。
 */
function ledgerVerify(agentId: string): AgentConnector['verify'] {
  const c = AGENT_BY_ID.get(agentId)
  if (!c?.mcp) return undefined
  const { jsonpath, requiredKeys, valueHints } = c.mcp
  return (configPath: string, mcpUrl: string): string | null => {
    const err = verifyJsonEntry(configPath, jsonpath, requiredKeys, valueHints)
    return err ? err.split(mcpUrl).join('<url>') : null
  }
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

/** Locate the ACTIVE Hermes profile config.yaml: the CN Desktop install
 * default first, then the profile whose config was touched most recently. */
function hermesProfileConfig(): string | null {
  const roots = [
    'D:\\Hermes Agent CN Desktop\\data\\hermes-home',
    path.join(os.homedir(), 'hermes-home')
  ]
  const direct: string[] = []
  for (const root of roots) {
    direct.push(path.join(root, 'profiles', 'daily', 'config.yaml'), path.join(root, 'config.yaml'))
  }
  for (const c of direct) {
    if (fs.existsSync(c)) return c
  }
  for (const root of roots) {
    const profilesDir = path.join(root, 'profiles')
    let best: { p: string; m: number } | null = null
    try {
      for (const e of fs.readdirSync(profilesDir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue
        const p = path.join(profilesDir, e.name, 'config.yaml')
        if (fs.existsSync(p)) {
          const m = fs.statSync(p).mtimeMs
          if (!best || m > best.m) best = { p, m }
        }
      }
    } catch {
      /* no profiles dir */
    }
    if (best) return best.p
  }
  return null
}

const HTTP_ENTRY = (url: string) => ({ type: 'http', url })

/**
 * Hermes Agent(NousResearch/hermes-agent,含 CN Desktop 打包版):
 * config.yaml 顶层 `mcp_servers:`,支持 Streamable HTTP `url:`。
 * YAML 无解析依赖的文本手术:文件里已有 mcp_servers 时把条目插到其下,
 * 否则整块追加到文件末尾;写前备份,幂等(重跑替换同一子块)。
 */
function upsertHermesYaml(configPath: string, mcpUrl: string): string {
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  let content = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : ''
  fs.copyFileSync(configPath, `${configPath}.bak-memorysql`)
  const block = [
    '  memorysql:',
    `    url: "${mcpUrl}"`,
    '    protocol: "stateless"',
    '    trust: "untrusted"'
  ].join('\n')
  if (/^  memorysql:\s*$/m.test(content)) {
    // replace our previous sub-block (from its header to the next 2-space sibling)
    content = content.replace(/^  memorysql:\n(?:    .*\n?)+/m, block + '\n')
  } else if (/^mcp_servers:\s*$/m.test(content)) {
    content = content.replace(/^mcp_servers:\s*$/m, 'mcp_servers:\n' + block)
  } else {
    content = content.replace(/\s*$/, '\n\n') + 'mcp_servers:\n' + block + '\n'
  }
  fs.writeFileSync(configPath, content, 'utf-8')
  return configPath
}

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
      `// ~/.zcode/cli/config.json 的 mcp.servers 中加:\n"memorysql": { "type": "http", "url": "${url}" }`,
    verify: ledgerVerify('zcode')
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
      `claude mcp add --transport http memorysql ${url}\n# 或 ~/.claude.json 的 mcpServers 中加:\n"memorysql": { "type": "http", "url": "${url}" }`,
    verify: ledgerVerify('claudecode')
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
      `// ~/.gemini/settings.json 的 mcpServers 中加:\n"memorysql": { "command": "node", "args": ["${bridge.replace(/\\/g, '\\\\')}"] }`,
    verify: ledgerVerify('gemini')
  },
  {
    id: 'qwencode',
    label: 'Qwen Code',
    detect: (home) => fs.existsSync(path.join(home, '.qwen')),
    configPath: (home) => path.join(home, '.qwen', 'settings.json'),
    apply: (configPath, _url, bridge) =>
      mergeJson(configPath, (root) => {
        setNested(root, ['mcpServers', 'memorysql'], {
          command: 'node',
          args: [bridge]
        })
      }),
    snippet: (_url, bridge) =>
      `// ~/.qwen/settings.json 的 mcpServers 中加:\n"memorysql": { "command": "node", "args": ["${bridge.replace(/\\/g, '\\\\')}"] }`,
    verify: ledgerVerify('qwencode')
  },
  {
    id: 'kimicli',
    label: 'Kimi CLI',
    detect: (home) => fs.existsSync(path.join(home, '.kimi')),
    configPath: (home) => path.join(home, '.kimi', 'mcp.json'),
    apply: (configPath, url) =>
      mergeJson(configPath, (root) => {
        setNested(root, ['mcpServers', 'memorysql'], { url })
      }),
    snippet: (url) =>
      `kimi mcp add --transport http memorysql ${url}\n// 或 ~/.kimi/mcp.json:\n{\n  "mcpServers": {\n    "memorysql": { "url": "${url}" }\n  }\n}`,
    verify: ledgerVerify('kimicli')
  },
  {
    id: 'codebuddy',
    label: 'CodeBuddy Code',
    detect: (home) => fs.existsSync(path.join(home, '.codebuddy')),
    configPath: (home) => path.join(home, '.codebuddy', 'mcp.json'),
    apply: (configPath, url) =>
      mergeJson(configPath, (root) => {
        setNested(root, ['mcpServers', 'memorysql'], HTTP_ENTRY(url))
      }),
    snippet: (url) =>
      `// ~/.codebuddy/mcp.json:\n{\n  "mcpServers": {\n    "memorysql": { "type": "http", "url": "${url}" }\n  }\n}`,
    verify: ledgerVerify('codebuddy')
  },
  {
    id: 'workbuddy',
    label: 'WorkBuddy',
    detect: (home) => fs.existsSync(path.join(home, '.workbuddy')),
    configPath: (home) => path.join(home, '.workbuddy', 'mcp.json'),
    apply: (configPath, url) =>
      mergeJson(configPath, (root) => {
        setNested(root, ['mcpServers', 'memorysql'], { url, disabled: false })
      }),
    snippet: (url) =>
      `// ~/.workbuddy/mcp.json:\n{\n  "mcpServers": {\n    "memorysql": { "url": "${url}", "disabled": false }\n  }\n}`,
    verify: ledgerVerify('workbuddy')
  },
  {
    id: 'qoder',
    label: 'Qoder CLI / CN',
    detect: (home) =>
      fs.existsSync(path.join(home, '.qoder')) || fs.existsSync(path.join(home, '.qoder-cn')),
    configPath: (home) => {
      const g = path.join(home, '.qoder')
      const base = fs.existsSync(g) ? g : path.join(home, '.qoder-cn')
      return path.join(base, 'settings.json')
    },
    apply: (configPath, url) =>
      mergeJson(configPath, (root) => {
        setNested(root, ['mcpServers', 'memorysql'], HTTP_ENTRY(url))
      }),
    snippet: (url) =>
      `qoder mcp add --transport http memorysql ${url}\n// 或 settings.json 的 mcpServers 中加:\n{\n  "mcpServers": {\n    "memorysql": { "type": "http", "url": "${url}" }\n  }\n}`,
    verify: ledgerVerify('qoder')
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
      `// ~/.cursor/mcp.json:\n{\n  "mcpServers": {\n    "memorysql": { "url": "${url}" }\n  }\n}`,
    verify: ledgerVerify('cursor')
  },
  {
    id: 'opencode',
    label: 'OpenCode / Copilot CLI',
    detect: (home, localAppData) =>
      fs.existsSync(path.join(home, '.local', 'share', 'opencode')) ||
      (localAppData ? fs.existsSync(path.join(localAppData, 'opencode')) : false),
    configPath: (home) => path.join(home, '.config', 'opencode', 'opencode.json'),
    // `type` is required since OpenCode v2: without it the entry is silently
    // dropped by config normalization ("omitted enabled-only legacy MCP entry"),
    // so the server never connects and the failure is invisible to the user.
    apply: (configPath, url) =>
      mergeJson(configPath, (root) => {
        setNested(root, ['mcp', 'memorysql'], { type: 'remote', url, enabled: true })
      }),
    snippet: (url) =>
      `// ~/.config/opencode/opencode.json:\n{\n  "mcp": {\n    "memorysql": { "type": "remote", "url": "${url}", "enabled": true }\n  }\n}\n\n// v2 起 type 必填;缺失会被 opencode 静默丢弃(日志: omitted enabled-only legacy MCP entry)`,
    verify: ledgerVerify('opencode')
  },
  {
    id: 'hermes',
    label: 'Hermes Agent (CN Desktop)',
    detect: (_home, _appData) => hermesProfileConfig() !== null,
    configPath: () => hermesProfileConfig() ?? '',
    apply: (_configPath, url) => {
      const cfg = hermesProfileConfig()
      if (!cfg) throw new Error('未找到 Hermes 配置(config.yaml)')
      return upsertHermesYaml(cfg, url)
    },
    snippet: (url) =>
      `# Hermes profile 的 config.yaml 追加:\nmcp_servers:\n  memorysql:\n    url: "${url}"\n    protocol: "stateless"\n    trust: "untrusted"\n\n# 修改后在 Hermes 里执行 /reload-mcp 热加载`
  }
]

export interface AgentConnectResult {
  id: string
  label: string
  detected: boolean
  /** 配置已写入**且回读校验通过。校验不过时为 false,原因见 verifyError */
  configured: boolean
  configPath: string | null
  snippet: string
  /** 写后回读失败的原因(成功时为 null)——不填这个,用户就只能对着「已配置」干瞪眼 */
  verifyError: string | null
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
  let verifyError: string | null = null
  if (detected) {
    configPath = connector.configPath(home, appData ?? localAppData)
    connector.apply(configPath, url, bridge)
    // 写完必须回读:agent 侧可能静默丢弃我们写的配置(见 AgentConnector.verify)
    verifyError = connector.verify ? connector.verify(configPath, url) : null
    configured = verifyError === null
  }
  return {
    id: connector.id,
    label: connector.label,
    detected,
    configured,
    configPath,
    snippet,
    verifyError
  }
}

export function agentSnippet(
  agentId: string,
  port: number,
  appData?: string,
  localAppData?: string
): AgentConnectResult {
  return connectAgent(agentId, port, appData, localAppData)
}
