/**
 * MemorySQL 上游适配契约台账
 * ============================================================================
 * 这是「上游监控 / 影响评估 / 黑盒契约测试 / 连接向导回读校验」的唯一真相源,
 * 一份数据四处复用:
 *   1. 文档     — 记录每家 agent 的上游、changelog 来源、我们依赖什么
 *   2. 监控     — 云端抓取器按 `upstream` 决定抓什么(第 2 期)
 *   3. 契约测试 — `upstream/check.ts` 按 schema 声明探测真实数据
 *   4. 连接校验 — `main/core/agent-connect.ts` 写完配置回读校验必需键
 *
 * 放在 src/shared 而非仓库根的 upstream/:因为产品代码(main 进程连接向导)也读它,
 * 必须进打包产物。纯数据、无 electron 依赖,main/renderer 皆可 import。
 *
 * 维护约定(见 docs/DEVLOG.md):
 *   - 改动任一 capture-* 适配器的存储布局、或任一连接器写入的 MCP 配置格式时,
 *     必须同步本文件,否则 test/upstream-contract.test.ts 会红
 */

/** 上游更新日志的获取方式 */
export type UpstreamKind =
  | 'github' /** GitHub Releases API */
  | 'commit' /** 无 release,只能看 commit */
  | 'npm' /** npm registry */
  | 'none' /** 闭源,无任何公开更新日志 —— 仅靠黑盒守 */

export type MonitorMode = 'tracked' | 'blackbox_only'

/** 本地源的形态 */
export type SourceKind =
  | 'sqlite' /** SQLite 权威库 —— 用 schema 探测漂移 */
  | 'jsonl' /** JSON Lines —— 用真实 parser 解析样本 */
  | 'json' /** 单个/多�� JSON 文件 */

export interface SqliteExpect {
  /** 期望存在的表(任一命中即可,用于支持多代布局) */
  tablesAnyOf: string[][]
  /** 表 → 必须存在的列 */
  requiredColumns: Record<string, string[]>
  /** 说明为何依赖这些(漂移时人看的上下文) */
  note?: string
}

export interface JsonlExpect {
  /** 会话日志文件匹配 */
  fileMatch: string
  /** 每行 JSON 必须具备的字段路径(点号路径);空数组 = 不校验 */
  requiredPaths: string[]
  /** 真实 parser 的注册名,黑盒检查据此调用(见 upstream/check.ts) */
  parser: string
  note?: string
}

export interface JsonExpect {
  /** 逐条解析的入口名(如 gemini 的 history) */
  entry: string
  note?: string
}

/** 源形态 —— discriminated union,kind 即判别式 */
export type SourceSpec =
  | { kind: 'sqlite'; sqlite: SqliteExpect }
  | { kind: 'jsonl'; jsonl: JsonlExpect }
  | { kind: 'json'; json: JsonExpect }

export interface McpExpect {
  /** 配置文件路径(相对 home) */
  file: string
  /** JSONPath,定位 memorysql 条目 */
  jsonpath: string
  /** 条目必须具备的键 —— 缺一个就意味着该 agent 会丢弃/拒绝这条配置 */
  requiredKeys: string[]
  /** 若有,必须是这个值(例如 opencode 2.x 要求 type=remote) */
  valueHints?: Record<string, string>
  note?: string
}

export interface AgentContract {
  id: string
  name: string
  /** 与 sessions.agent_type 对应 */
  agentType: string
  upstream: {
    kind: UpstreamKind
    repo?: string
    /** release 无正文 / 无 release 时的说明 */
    note?: string
  }
  monitor: MonitorMode
  /**
   * 本地源定位方式,二选一:
   *   - 字符串:静态路径(相对 home,或绝对)。按顺序取第一个存在的
   *   - { resolver }:路径由生产代码里的探测函数决定(安装位置随注册表/盘符变动的 agent)
   *
   * 优先用 resolver:探测逻辑留在代码里,台账不重复实现,避免台账腐化。
   */
  localRoots: Array<string | { resolver: string }>
  source: SourceSpec
  mcp: McpExpect | null
  /** changelog 命中这些词 → 白盒粗筛标为「需重点看」 */
  riskKeywords: string[]
  /** 本机是否装了该 agent(由黑盒脚本实测,不要手填) */
  installedOnThisMachine?: boolean
  notes?: string
}

/** 高危信号词 —— 命中即需人工确认是否打到我们依赖的结构 */
export const DEFAULT_RISK_KEYWORDS = [
  'schema',
  'migration',
  'migrate',
  'table',
  'column',
  'rename',
  'breaking',
  'config format',
  'deprecat',
  'storage',
  'database',
  'session file',
  '迁移',
  '存储',
  '格式',
  '路径',
  '重命名'
]

export const AGENTS: AgentContract[] = [
  // ─────────────────────────── 开源:有公开 changelog ───────────────────────────
  {
    id: 'opencode',
    name: 'OpenCode',
    agentType: 'opencode',
    upstream: { kind: 'github', repo: 'anomalyco/opencode' },
    monitor: 'tracked',
    localRoots: ['.local/share/opencode/opencode.db'],
    source: {
      kind: 'sqlite',
      sqlite: {
        // opencode ≥2.0 把权威库从 session/message/part 迁到 session_v2 + session_message
        tablesAnyOf: [
          ['session_v2', 'session_message'], // v2 及以后
          ['session', 'message', 'part'] // legacy
        ],
        requiredColumns: {
          session_v2: ['id', 'directory', 'title', 'time_created', 'time_updated'],
          session: ['id', 'directory', 'title', 'time_created', 'time_updated']
        },
        note:
          'v2 迁移是真实发生过的事故:旧解析器遇到新库抛 "no such table: session"。' +
          '解析器已改为布局探测(legacy 优先 → session_v2 → 未知返回 []),见 _lib/agent-db-parser.ts'
      }
    },
    mcp: {
      file: '.config/opencode/opencode.json',
      jsonpath: '$.mcp.memorysql',
      requiredKeys: ['type', 'url'],
      valueHints: { type: 'remote' },
      note:
        'v2 起 type 必填;缺失会被 opencode 静默丢弃(日志: omitted enabled-only legacy MCP entry),' +
        '仅 WARN 无报错。已修 agent-connect.ts'
    },
    riskKeywords: DEFAULT_RISK_KEYWORDS
  },
  {
    id: 'claudecode',
    name: 'Claude Code / Claude Desktop',
    agentType: 'claudecode',
    upstream: { kind: 'github', repo: 'anthropics/claude-code' },
    monitor: 'tracked',
    // 主源 = 完整对话 JSONL。另有 Desktop 元数据源(local_*.json)与
    // history.jsonl(仅用户侧),两者格式不同,由 parseDesktopMeta / parseHistoryJsonl
    // 单独处理,故不入 localRoots(避免 jsonl 探测误判)
    localRoots: ['.claude/projects'],
    source: {
      kind: 'jsonl',
      jsonl: {
        fileMatch: '**/*.jsonl',
        requiredPaths: ['type', 'message'],
        parser: 'claude',
        note:
          '三源合并去重:①~/.claude/projects/**/*.jsonl 完整对话(主源) ' +
          '②%LOCALAPPDATA%/Claude-3p/claude-code-sessions/**/local_*.json 桌面版元数据(无对话正文) ' +
          '③~/.claude/history.jsonl 仅用户侧。桌面版 SDK 不落盘对话'
      }
    },
    mcp: {
      file: '.claude.json',
      jsonpath: '$.mcpServers.memorysql',
      requiredKeys: ['type', 'url'],
      valueHints: { type: 'http' },
      note: '现走 HTTP 直连(type=http);Antigravity 一路仍限 stdio,需 resources/mcp-bridge.mjs 桥'
    },
    riskKeywords: DEFAULT_RISK_KEYWORDS
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    agentType: 'codex',
    upstream: {
      kind: 'commit',
      repo: 'openai/codex',
      note: 'release 存在但正文全空,官方 CHANGELOG.md 明写"见 releases 页" → 需 commit 兜底'
    },
    monitor: 'tracked',
    localRoots: ['.codex/sessions'],
    source: {
      kind: 'jsonl',
      jsonl: {
        fileMatch: '**/rollout-*.jsonl',
        requiredPaths: ['timestamp'],
        parser: 'codex',
        note: 'capture-codex 是独立实现,未并入 capture-factory'
      }
    },
    mcp: {
      file: '.codex/config.toml',
      jsonpath: 'mcp_servers.memorysql',
      requiredKeys: ['command', 'args'],
      note: 'TOML 格式,非 JSON —— 黑盒校验需 TOML 解析'
    },
    riskKeywords: DEFAULT_RISK_KEYWORDS
  },
  {
    id: 'qwencode',
    name: 'Qwen Code',
    agentType: 'qwencode',
    upstream: { kind: 'github', repo: 'QwenLM/qwen-code' },
    monitor: 'tracked',
    localRoots: ['.qwen'],
    source: {
      kind: 'jsonl',
      jsonl: {
        fileMatch: '**/chats/*.jsonl',
        requiredPaths: [],
        parser: 'qwen',
        note: '本机未装,格式来自官方文档调研;真机如有出入需补 fixture 校准'
      }
    },
    mcp: {
      file: '.qwen/settings.json',
      jsonpath: '$.mcpServers.memorysql',
      requiredKeys: ['command', 'args'],
      note: 'Claude 兼容配置形态'
    },
    riskKeywords: DEFAULT_RISK_KEYWORDS
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    agentType: 'gemini',
    upstream: { kind: 'github', repo: 'google-gemini/gemini-cli' },
    monitor: 'tracked',
    localRoots: ['.gemini'],
    source: {
      kind: 'json',
      json: {
        entry: 'history',
        note: 'history 目录下的 JSON 文件,逐条 parseGeminiHistory'
      }
    },
    mcp: {
      file: '.gemini/settings.json',
      jsonpath: '$.mcpServers.memorysql',
      requiredKeys: ['command', 'args'],
      note:
        'Antigravity MCP 走 ~/.gemini/config/mcp_config.json,仅支持 stdio(serverUrl 标 SSE,与本项目 Streamable HTTP 不兼容),推荐 stdio 桥'
    },
    riskKeywords: DEFAULT_RISK_KEYWORDS
  },
  {
    id: 'hermes',
    name: 'Hermes Agent',
    agentType: 'hermes',
    upstream: { kind: 'github', repo: 'NousResearch/hermes-agent' },
    monitor: 'tracked',
    // 安装位置随注册表 / 盘符变动(home → 注册表 InstallLocation → 各盘符根),
    // 探测链已封装在 resolveHermesHome();台账不重复实现,直接引用
    localRoots: [{ resolver: 'hermes' }],
    source: {
      kind: 'sqlite',
      sqlite: {
        tablesAnyOf: [['sessions', 'messages']],
        requiredColumns: {
          sessions: ['id', 'source', 'display_name', 'model'],
          messages: ['id', 'session_id', 'role', 'content', 'tool_name', 'timestamp']
        },
        note:
          'state.db 布局在 0.7.0 变过(根级 vs profiles/<name>/),resolveHermesHome 有探测链;' +
          '解析逻辑内联在 capture-hermes/index.ts 的 scan 中,未导出为纯函数'
      }
    },
    mcp: {
      file: 'hermes-home/config.yaml',
      jsonpath: 'mcp_servers.memorysql',
      requiredKeys: ['url', 'protocol', 'trust'],
      valueHints: { protocol: 'stateless' },
      note: 'YAML 格式,非 JSON;改完需执行 /reload-mcp'
    },
    riskKeywords: DEFAULT_RISK_KEYWORDS
  },
  {
    id: 'kimicli',
    name: 'Kimi Code CLI',
    agentType: 'kimicli',
    upstream: {
      kind: 'npm',
      repo: 'MoonshotAI/kimi-code',
      note: '原记录的 MoonshotAI/Kimi-Dev 已归档失效,2026-09-30 修正;0 条 release → npm + commit'
    },
    monitor: 'tracked',
    localRoots: ['.kimi/sessions'],
    source: {
      kind: 'jsonl',
      jsonl: {
        fileMatch: '**/context.jsonl',
        requiredPaths: [],
        parser: 'kimi',
        note: 'context.jsonl 为消息,标题/cwd 来自同级 state'
      }
    },
    mcp: {
      file: '.kimi/mcp.json',
      jsonpath: '$.mcpServers.memorysql',
      requiredKeys: ['url']
    },
    riskKeywords: DEFAULT_RISK_KEYWORDS
  },
  {
    id: 'cursor',
    name: 'Cursor',
    agentType: 'cursor',
    upstream: {
      kind: 'commit',
      repo: 'getcursor/cursor',
      note: '0 条 release,更新走官网/论坛 → 只能靠 commit'
    },
    monitor: 'tracked',
    localRoots: ['AppData/Roaming/Cursor/User/workspaceStorage'],
    source: {
      kind: 'sqlite',
      sqlite: {
        tablesAnyOf: [['blobs', 'cursorDiskKV']],
        requiredColumns: {},
        note: '本机未装,parseCursorDb 的真实表结构待校准;此处为占位,首次真机验证后必须补全'
      }
    },
    mcp: {
      file: '.cursor/mcp.json',
      jsonpath: '$.mcpServers.memorysql',
      requiredKeys: ['type', 'url'],
      valueHints: { type: 'http' }
    },
    riskKeywords: DEFAULT_RISK_KEYWORDS
  },

  // ───────────────────── 闭源:无任何公开 changelog,仅黑盒守 ─────────────────────
  {
    id: 'qoder',
    name: 'Qoder / Qoder CN',
    agentType: 'qoder',
    upstream: { kind: 'none', note: '官方仓库 404,搜索仅得第三方 proxy —— 无公开更新日志' },
    monitor: 'blackbox_only',
    localRoots: ['.qoder/projects', '.qoder-cn/projects'],
    source: {
      kind: 'jsonl',
      jsonl: {
        fileMatch: '**/*.jsonl',
        requiredPaths: [],
        parser: 'qoder',
        note: 'Claude 兼容 JSONL;title/cwd 来自 projects/<slug>/<id>/state.json;env QODER_CONFIG_DIR / QODERCN_CONFIG_DIR 可覆盖根目录'
      }
    },
    mcp: {
      file: '.qoder/settings.json',
      jsonpath: '$.mcpServers.memorysql',
      requiredKeys: ['type', 'url'],
      valueHints: { type: 'http' }
    },
    riskKeywords: DEFAULT_RISK_KEYWORDS
  },
  {
    id: 'codebuddy',
    name: 'CodeBuddy',
    agentType: 'codebuddy',
    upstream: { kind: 'none', note: '官方仓库 404 —— 无公开更新日志' },
    monitor: 'blackbox_only',
    localRoots: ['.codebuddy/projects'],
    source: {
      kind: 'jsonl',
      jsonl: {
        fileMatch: '**/*.jsonl',
        requiredPaths: [],
        parser: 'claude',
        note: '复用 parseClaudeJsonl(Claude 兼容);本机未装,格式来自文档调研'
      }
    },
    mcp: {
      file: '.codebuddy/mcp.json',
      jsonpath: '$.mcpServers.memorysql',
      requiredKeys: ['type', 'url'],
      valueHints: { type: 'http' }
    },
    riskKeywords: DEFAULT_RISK_KEYWORDS
  },
  {
    id: 'workbuddy',
    name: 'WorkBuddy',
    agentType: 'workbuddy',
    upstream: { kind: 'none', note: '官方仓库 404 —— 无公开更新日志' },
    monitor: 'blackbox_only',
    localRoots: ['.workbuddy/projects'],
    source: {
      kind: 'jsonl',
      jsonl: {
        fileMatch: '**/*.jsonl',
        requiredPaths: [],
        parser: 'workbuddy',
        note: '另有 workbuddy.db 提供 title/cwd/created_at 元数据增强'
      }
    },
    mcp: {
      file: '.workbuddy/mcp.json',
      jsonpath: '$.mcpServers.memorysql',
      requiredKeys: ['url']
    },
    riskKeywords: DEFAULT_RISK_KEYWORDS
  },
  {
    id: 'zcode',
    name: 'ZCode',
    agentType: 'zcode',
    upstream: { kind: 'none', note: '智谱闭源桌面应用,无公开仓库/更新日志' },
    monitor: 'blackbox_only',
    localRoots: ['.zcode/cli/db/db.sqlite', '.zcode/cli/rollout'],
    source: {
      kind: 'sqlite',
      sqlite: {
        // 与 opencode 同源但仍停在 legacy 三表布局
        tablesAnyOf: [['session', 'message', 'part']],
        requiredColumns: {
          session: ['id', 'directory', 'title', 'time_created', 'time_updated']
        },
        note:
          '与 opencode 同源(共享 _lib/agent-db-parser.ts);rollout 目录仅剩 model-io 日志,作 watcher 信号不作权威源'
      }
    },
    mcp: {
      file: '.zcode/config.json',
      jsonpath: '$.mcp.servers.memorysql',
      requiredKeys: ['type', 'url'],
      valueHints: { type: 'http' }
    },
    riskKeywords: DEFAULT_RISK_KEYWORDS
  }
]

export const AGENT_BY_ID = new Map(AGENTS.map((a) => [a.id, a]))

/** 某条上游更新是否命中高危信号(白盒粗筛;最终判断仍需人) */
export function hitsRiskKeywords(changelog: string, contract: AgentContract): string[] {
  const lower = changelog.toLowerCase()
  return contract.riskKeywords.filter((k) => lower.includes(k.toLowerCase()))
}
