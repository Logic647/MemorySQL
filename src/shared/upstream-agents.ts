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
  | 'json' /** 单个/多个 JSON 文件 */

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
  /**
   * 黑盒检查器发现样本时匹配的文件后缀(含压缩后缀),默认只找 `*.jsonl`。
   * DSH 默认 `.jsonl.zstd`,需显式声明,否则 findFirst 会漏判成 absent。
   */
  fileSuffixes?: string[]
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
  /**
   * 该 agent 认哪个「使用规则」文件(连接向导按它写工作协议)。
   * null = 未知/没有机制,**不许猜** —— 每一行的证据(rules-probe 金丝雀 /
   * 开源源码 / 官方文档 / 资源翻查 / 同族推断)见 DEVLOG 2026-11-07。
   */
  rules: RuleFileExpect | null
  /** changelog 命中这些词 → 白盒粗筛标为「需重点看」 */
  riskKeywords: string[]
  /** 本机是否装了该 agent(由黑盒脚本实测,不要手填) */
  installedOnThisMachine?: boolean
  notes?: string
}

/** 一次「写入使用规则」要碰的文件清单 + 证据等级 */
export interface RuleFileExpect {
  /**
   * 项目级候选(相对项目根,按序取第一个存在的;都不存在时新建第一个)。
   * qoder 这类「规则目录」用目录路径表示:写入 <目录>/memorysql.md。
   */
  project: string[]
  /** 用户级(相对 home 展开,对所有项目生效);按序取第一个存在的,都不存在时新建第一个 */
  user?: string[]
  /**
   * 证据等级:
   *  - canary     rules-probe.mjs 金丝雀实测(行为直接给出)
   *  - source     开源仓库源码核对
   *  - docs       官方文档明确写了
   *  - family     用户确认与某家同族(推断,装上后应金丝雀复核)
   *  - convention 跨工具通行约定(未被金丝雀复核过)
   */
  evidence: 'canary' | 'source' | 'docs' | 'family' | 'convention'
  note?: string
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
    rules: { project: ['AGENTS.md'], user: ['.config/opencode/AGENTS.md'], evidence: 'convention', note: 'opencode 系通行约定' },
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
    rules: { project: ['CLAUDE.md'], user: ['.claude/CLAUDE.md'], evidence: 'convention' },
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
    rules: { project: ['AGENTS.md'], user: ['.codex/AGENTS.md'], evidence: 'convention', note: '本机 ~/.codex/AGENTS.md 实际存在' },
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
    rules: { project: ['QWEN.md'], evidence: 'convention', note: '继承 gemini-cli 的上下文文件约定;NAS auth 配好后可金丝雀复核' },
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
        note:
          '遍历 ~/.gemini 下的 JSON 文件(会话可能在 history/ 或 tmp/<proj>/chats/),最多 8 个样本逐条 ' +
          'parseGeminiHistory。2026-11-06 前检查器对 json 源无条件判绿(等于没查):现在有会话且能解析=绿;' +
          '顶层有 messages/history 却解析出 0 条=漂移;只有 oauth_creds/settings 之类=未验证(黄)。' +
          '判据只看磁盘数据,与是否登录无关'
      }
    },
    mcp: {
      file: '.gemini/settings.json',
      jsonpath: '$.mcpServers.memorysql',
      requiredKeys: ['command', 'args'],
      note:
        'Antigravity MCP 走 ~/.gemini/config/mcp_config.json,仅支持 stdio(serverUrl 标 SSE,与本项目 Streamable HTTP 不兼容),推荐 stdio 桥'
    },
    rules: { project: ['GEMINI.md'], evidence: 'convention', note: 'gemini-cli 通行约定;NAS 未配 auth,金丝雀待跑' },
    riskKeywords: DEFAULT_RISK_KEYWORDS
  },
  {
    id: 'hermes',
    name: 'Hermes Agent(CN 桌面版)',
    agentType: 'hermes',
    /**
     * ⚠️ 这里盯的是**英文上游**,但用户实际装的是中文分支 —— 刻意如此,理由见 note。
     *
     * 装的是:Eynzof/Hermes-CN-Desktop(Tauri+Rust 外壳)内嵌 Eynzof/Hermes-CN-Core
     * (Hermes Agent 的中文社区分支,Python 侧仍是 hermes_cli)。
     * 曾经把 upstream 错记成本仓库,导致整个 hermes 的 changelog 监控盯的是
     * 另一个产品(2026-09-30 由用户纠正后重新核实)。
     */
    upstream: {
      kind: 'github',
      repo: 'NousResearch/hermes-agent',
      note:
        '**盯英文上游,尽管用户装的是中文分支** —— 刻意如此。分支只是上游的镜像:' +
        '它的 commit 几乎全是「同步主分支到 dev-fix」这类合并噪音,release 正文为空,' +
        '盯它会漏掉上游的每一次 schema 变更。变更发生在上游,分支只决定「什么时候轮到我」。' +
        '版本对应关系:分支 tag `runtime-v<上游版本>-cn.<序号>`,例如 ' +
        '`runtime-v0.21.0-cn.18` ↔ 上游 0.21.0(上游 tag v2026.8.31)。' +
        '2026-09-30 实测:用户安装在 0.21.0,上游已到 0.21.5 —— **落后 5 个 patch**,' +
        '这些变更尚未进入本机,但迟早会。真正的安装身份:外壳 Eynzof/Hermes-CN-Desktop' +
        '(release 正文是 43 字符的 nightly 模板,自述 prototype,同样不适合当 changelog)' +
        '+ 内嵌核心 Eynzof/Hermes-CN-Core。'
    },
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
          '解析逻辑内联在 capture-hermes/index.ts 的 scan 中,未导出为纯函数。' +
          '**本机未装该 agent 的原生 hermes,故此表长期黑盒未验证** —— ' +
          'capture-hermes 读的是 CN 桌面版内嵌核心写出的库,格式变更先在英文上游发生'
      }
    },
    mcp: {
      file: 'hermes-home/config.yaml',
      jsonpath: 'mcp_servers.memorysql',
      // 只认 url —— 2026-09-30 同时核对**英文上游**与**用户实际运行的中文分支**,
      // 两者结论一致:
      //   hermes_cli/mcp_config.py 判定传输的方式是 `if "url" in cfg` → HTTP;
      //   `stateless` 在两个仓库全仓 0 次;`trust` 只用于 skills 的
      //   trusted_project_dirs;`protocol` 只用于 bot_mode_protocol / ws ping /
      //   delegation wire protocol(注意:代码里叫 transport 的那个变量只是
      //   **显示用**的局部变量,不是配置键;桌面版 API 的 McpServer 类型里
      //   确有 transport 字段,但那层由 Python 侧从 url/command 推导)。
      // 以前写 requiredKeys:['url','protocol','trust'] 等于**对外声明了一个
      // 不存在的契约**,还会让写后回读校验去校验死键。
      requiredKeys: ['url'],
      valueHints: {},
      note:
        'YAML 格式,非 JSON;改完需执行 /reload-mcp。' +
        '连接器仍会写 protocol/trust 两键仅为兼容老版本(上游忽略它们,' +
        'mcp_security.validate_mcp_server_entry 不拒绝未知键,故无害);' +
        '认证走 auth: oauth 或 headers'
    },
    rules: { project: [], user: [], evidence: 'source', note: '不认 AGENTS.md/CLAUDE.md(bundled-runtime 全文无此字符串);规则=hermes-home/SOUL.md,路径随安装位置变动,由 hermes resolver 解析后拼接' },
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
    rules: { project: ['AGENTS.md', '.kimi-code/AGENTS.md'], user: ['.kimi-code/AGENTS.md', '.agents/AGENTS.md'], evidence: 'docs', note: '官方文档 docs/en/customization/agents.md:项目 AGENTS.md 注入系统提示;~/.agents/AGENTS.md 是跨工具通用位置' },
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
    rules: { project: ['.cursor/rules/memorysql.md', '.cursorrules'], evidence: 'convention', note: '公开文档;装上后应金丝雀复核' },
    riskKeywords: DEFAULT_RISK_KEYWORDS
  },

  // ───────────────────── 闭源:无任何公开 changelog,仅黑盒守 ─────────────────────
  // (不写家数:每有一家开源就要改一次注释,迟早会忘 —— 同 note 不进指纹一个道理)
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
    rules: { project: ['.qoder/rules/'], evidence: 'canary', note: '金丝雀实测(2026-11-07):11 候选里只有 .qoder/rules/canary.md 的暗号出现在回复首行;AGENTS.md 不认' },
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
        note:
          '复用 parseClaudeJsonl(Claude 兼容);2026-10-25 NAS 真机校准:CodeBuddy ≥2.x 实际写 ' +
          'type=message + 顶层 role/content + content 块 input_text/output_text + 毫秒 epoch 时间戳' +
          '(非 .message 壳),parser 已按真机样本校准并锁 fixture;未登录也会写会话文件(登录错误作为 assistant 消息落盘)'
      }
    },
    mcp: {
      file: '.codebuddy/mcp.json',
      jsonpath: '$.mcpServers.memorysql',
      requiredKeys: ['type', 'url'],
      valueHints: { type: 'http' }
    },
    rules: { project: ['CODEBUDDY.md'], evidence: 'canary', note: '金丝雀实测(2026-11-07):回复首行即暗号,AGENTS.md 不认,对照组干净' },
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
    rules: { project: ['CODEBUDDY.md'], evidence: 'family', note: '用户确认与 codebuddy 同族(同厂同引擎);装上后应金丝雀复核' },
    riskKeywords: DEFAULT_RISK_KEYWORDS
  },
  {
    id: 'zcode',
    name: 'ZCode',
    agentType: 'zcode',
    upstream: { kind: 'github', repo: 'zai-org/ZCode' },
    monitor: 'tracked',
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
          '2026-10 已按上游源码逐条核对(不再是黑盒推测):' +
          'db 路径 = apps/zcode-cli/packages/adapters/src/storage/session-store/paths.ts 的 getDefaultSessionDbPath();' +
          '表结构 = 同目录 migrations.ts 里 0001_base_session_store 的建表 SQL' +
          '(session/message/part 三表均在,上面 5 个必需列逐个核对通过)。' +
          '与 opencode 同源(共享 _lib/agent-db-parser.ts);rollout 目录仅剩 model-io 日志,作 watcher 信号不作权威源'
      }
    },
    mcp: {
      file: '.zcode/config.json',
      jsonpath: '$.mcp.servers.memorysql',
      // 必填,依据上游 adapters/src/config/schema.ts:
      //   mcpServerSchema = z.discriminatedUnion("type", [stdio, http, sse])
      // `type` 是**判别式**,缺它整条 server 会被 strict 校验丢弃且不报错 ——
      // 与 opencode ≥2.0 那个 bug 同一类,连接器必须写 `type: 'http'`。
      // http 分支 = z.object({ type: z.literal("http"), url: z.string().min(1) }).strict()
      // 外层是 mcpSchema = z.object({ servers: z.record(z.string(), ...) }),故 jsonpath 是 $.mcp.servers.*
      requiredKeys: ['type', 'url'],
      valueHints: { type: 'http' }
    },
    rules: { project: ['AGENTS.md'], evidence: 'convention', note: '本会话即在读项目级 AGENTS.md' },
    riskKeywords: DEFAULT_RISK_KEYWORDS
  },
  {
    id: 'dsh',
    name: 'DeepSeek Harness',
    agentType: 'dsh',
    upstream: { kind: 'github', repo: 'deepseek-ai/deepseek-harness' },
    monitor: 'tracked',
    // 默认 ~/.dsh/sessions,DSH_HOME 可覆盖。会话根下是按 cwd 归组的
    // `--<normalized-cwd>--/` 目录,里面是 `<encoded-id>/session.vN.jsonl[.zstd]`。
    // 用 resolver 而非静态路径:home 位置随 DSH_HOME 变,探测链在插件里。
    localRoots: [{ resolver: 'dsh' }],
    source: {
      kind: 'jsonl',
      jsonl: {
        fileMatch: 'session*.jsonl',
        requiredPaths: [],
        parser: 'dsh',
        fileSuffixes: ['.jsonl', '.jsonl.zstd'],
        note:
          '2026-10-26 按上游源码逐条核实(deepseek-ai/deepseek-harness @ master):' +
          '会话根 = dshHomePath("sessions")(dsh-home-paths → ~/.dsh,sessions),' +
          '每会话一个 append-only JSONL 日志,默认 zstd(拼接的独立 checksum 帧,' +
          'Node zstdDecompressSync 一次解);文件命名 session.jsonl(v0)/session.vN.jsonl,' +
          '压缩加 .zstd;当前 SESSION_FORMAT_VERSION=4。首行=session 头(id/createdAt ms/cwd/delegationDepth),' +
          '事件行=type+data(user/message 靠 data.source.kind==="user" 区分真人提示与注入上下文;' +
          'assistant/message.content 块 text=正文/tool-call=工具调用;session/title→标题)。' +
          '事件行含 seq/time(released v2 codec 的 EVENT_REQUIRED = type/seq/time/data,v4 委托它解码),' +
          'time 是毫秒 epoch → 用作每条消息的 ts,并取最大值作 endedAt;' +
          '历史代数与新代数**并存**于同一会话目录,运行时规则是选最高 vN,采集侧必须同口径(否则同一会话被多代数覆盖)。'
      }
    },
    mcp: {
      file: '.dsh/cordis.patch.yml',
      jsonpath: '$.mcp.entry',
      requiredKeys: ['serverName', 'transport', 'url'],
      valueHints: { transport: 'streamable-http' },
      note:
        'YAML 格式,非 JSON —— 连接器做文本手术(见 agent-connect.ts upsertDshPatch)。' +
        'dsh 的 MCP 配置是 `~/.dsh/cordis.patch.yml` 里的一个 insert 条目:' +
        '`- id: memorysql / name: @deepseek-ai/dsh-mcp-client / config:{serverName,transport,url}`,' +
        'transport 取 `streamable-http`(连本机 HTTP MCP;stdio 走 mcp-bridge 亦可,但 HTTP 更简)。' +
        '台账号/文件形如 YAML,不做 JSONPath 回读校验,故 jsonpath 用占位说明'
    },
    rules: { project: ['AGENTS.md', 'CLAUDE.md'], user: ['.dsh/AGENTS.md', '.dsh/CLAUDE.md'], evidence: 'source', note: 'packages/context/agent-instructions: 候选写死为 AGENTS.md/CLAUDE.md(+.local 覆盖层),从 cwd 逐级向上' },
    riskKeywords: DEFAULT_RISK_KEYWORDS
  },

  // ───────────── 2026-11-10 批:Magpie(60+ agent 网关)名单补全 ─────────────
  // 调研底稿:docs/magpie-agents-survey.md(magpie 源码 internal/sessions 逐家实证 +
  // 各上游仓库源码核对)。开源走 source 证据;闭源为 magpie 实证格式 + 黑盒待校准。
  {
    id: 'goose',
    name: 'Goose',
    agentType: 'goose',
    upstream: {
      kind: 'github',
      repo: 'aaif-goose/goose',
      note: '原 block/goose 已迁移重定向到 aaif-goose/goose(2026-11 实测,Apache-2.0)'
    },
    monitor: 'tracked',
    localRoots: [
      'AppData/Roaming/Block/goose/sessions', // Windows(etcetera AppStrategy: %APPDATA%\Block\goose)
      '.local/share/goose/sessions', // Linux(XDG data)
      'Library/Application Support/Block/goose/sessions' // macOS
    ],
    source: {
      kind: 'sqlite',
      sqlite: {
        tablesAnyOf: [['sessions', 'messages']],
        requiredColumns: {
          sessions: ['id', 'name', 'working_dir', 'created_at', 'updated_at'],
          messages: ['session_id', 'role', 'content_json', 'created_timestamp']
        },
        note:
          'sessions.db(schema_version 迁移链,≥10)。sessions.session_type ' +
          "'user'|'scheduled'|'subagent'|'hidden'|'terminal'|'gateway'|'acp'(snake_case);" +
          'messages.created_timestamp 为秒;content_json 是 MessageContentBlock camelCase 块数组' +
          "(tag=type:text/toolRequest/toolResponse/thinking…)。2026-11 按源码核对(session_manager.rs)"
      }
    },
    mcp: {
      file: '.config/goose/config.yaml',
      jsonpath: 'extensions.memorysql',
      // yaml,不做 JSONPath 回读校验 —— 形状:extensions.<id>:{enabled,type:streamable_http,name,uri}
      requiredKeys: ['type', 'name', 'uri'],
      valueHints: { type: 'streamable_http' },
      note:
        'YAML 格式;键是 uri 不是 url(ExtensionConfig::StreamableHttp 的 serde 字段),' +
        'Windows 在 %APPDATA%\\Block\\goose\\config\\config.yaml。台账 file 只作展示'
    },
    rules: { project: ['.goosehints', 'AGENTS.md'], evidence: 'source', note: 'hints/load_hints.rs: 默认上下文文件 = .goosehints + AGENTS.md(CONTEXT_FILE_NAMES 参数可改);都不存在时新建 .goosehints' },
    riskKeywords: DEFAULT_RISK_KEYWORDS
  },
  {
    id: 'droid',
    name: 'Droid(Factory)',
    agentType: 'droid',
    upstream: { kind: 'none', note: 'Factory 闭源(curl 脚本安装),无公开更新日志 —— 黑盒守' },
    monitor: 'blackbox_only',
    localRoots: ['.factory/sessions'],
    source: {
      kind: 'jsonl',
      jsonl: {
        fileMatch: '**/*.jsonl',
        requiredPaths: [],
        parser: 'droid',
        note:
          '根级 <id>.jsonl(老)/ <cwd-slug>/<id>.jsonl(新)两代并存;首行 session_start' +
          '{id,title,cwd,lastCwd,parent,forkedAtMessageId,callingSessionId},之后 message 事件' +
          '(content 为字符串或 Anthropic 块)。格式按 magpie 实证解析还原,装好后黑盒校准'
      }
    },
    mcp: null,
    rules: { project: ['AGENTS.md'], evidence: 'docs', note: 'Factory 官方文档写明 droid 读项目 AGENTS.md;装好后可金丝雀复核' },
    riskKeywords: DEFAULT_RISK_KEYWORDS
  },
  {
    id: 'cline',
    name: 'Cline CLI',
    agentType: 'cline',
    upstream: { kind: 'github', repo: 'cline/cline' },
    monitor: 'tracked',
    localRoots: ['.cline/data/sessions'],
    source: {
      kind: 'json',
      json: {
        entry: 'messages',
        note:
          '~/.cline/data/sessions/<id>/<id>.json(manifest)+ <id>.messages.json(消息;' +
          '同目录 <agentId>.messages.json 为子代理)。CLINE_SESSION_DATA_DIR/CLINE_DATA_DIR/' +
          'CLINE_DIR 可逐级覆盖根。格式按 magpie 实证解析还原 + 上游类型定义核对'
      }
    },
    mcp: {
      file: '.cline/data/cline_mcp_settings.json',
      jsonpath: '$.mcpServers.memorysql',
      requiredKeys: ['type', 'url'],
      valueHints: { type: 'streamableHttp' },
      note: 'McpTransport 联合类型:stdio|sse|streamableHttp,remote 用 {type:"streamableHttp", url}'
    },
    rules: { project: ['.clinerules', 'AGENTS.md'], evidence: 'source', note: 'storage 常量表 clineRules=".clinerules";AGENTS.md 为通用约定兜底' },
    riskKeywords: DEFAULT_RISK_KEYWORDS
  },
  {
    id: 'pi',
    name: 'Pi',
    agentType: 'pi',
    upstream: {
      kind: 'github',
      repo: 'earendil-works/pi',
      note: '原 badlogic/pi-mono 已迁移(MIT);121k stars'
    },
    monitor: 'tracked',
    localRoots: ['.pi/agent/sessions'],
    source: {
      kind: 'jsonl',
      jsonl: {
        fileMatch: '**/*.jsonl',
        requiredPaths: [],
        parser: 'pi',
        note:
          'sessions/<cwd-slug>/<time>_<id>.jsonl,一行一个 entry:session 头(id/cwd/parentSession)/' +
          'session_info/title_change/model_change/usage/message(role+content 块,text|toolCall)。' +
          'fork 的拷贝段按「早于 header 时间戳」跳过。格式按 magpie 实证解析还原'
      }
    },
    mcp: {
      file: '.pi/agent/mcp.json',
      jsonpath: '$.mcpServers.memorysql',
      requiredKeys: ['url'],
      note: 'extensions/mcp/config.ts:mcp.json 的 mcpServers 形状,remote 即 {url};项目级 <project>/.pi/mcp.json 只做 enabled 覆盖'
    },
    rules: { project: ['AGENTS.md'], evidence: 'source', note: '上游仓库自带 AGENTS.md 且按其约定加载' },
    riskKeywords: DEFAULT_RISK_KEYWORDS
  },
  {
    id: 'omp',
    name: 'omp(oh-my-pi)',
    agentType: 'omp',
    upstream: { kind: 'github', repo: 'canopicjars/omp', note: 'Pi 的 fork;仓库地址待黑盒复核(magpie 接线记录 alias oh-my-pi)' },
    monitor: 'tracked',
    localRoots: ['.omp/agent/sessions'],
    source: {
      kind: 'jsonl',
      jsonl: {
        fileMatch: '**/*.jsonl',
        requiredPaths: [],
        parser: 'pi',
        note:
          '~/.omp/agent/sessions 形状同 Pi(title 行/title_change/model_usage 是增量差异);' +
          '子代理在与文件同名的 artifacts 目录 <time>_<id>/<agentId>.jsonl。' +
          'profiles:<~/.omp>/profiles/<name>/agent;$XDG_DATA_HOME/omp/sessions 也扫'
      }
    },
    mcp: {
      file: '.omp/agent/mcp.json',
      jsonpath: '$.mcpServers.memorysql',
      requiredKeys: ['url'],
      note: 'omp 是 Pi fork,按 Pi 系 mcp.json 形状(family 证据);装好后黑盒复核'
    },
    rules: { project: ['AGENTS.md'], evidence: 'family', note: 'Pi fork,沿用 Pi 的 AGENTS.md 约定;装好后金丝雀复核' },
    riskKeywords: DEFAULT_RISK_KEYWORDS
  },
  {
    id: 'omo',
    name: 'OmO',
    agentType: 'omo',
    upstream: { kind: 'github', repo: 'code-yeongyu/oh-my-openagent', note: '引擎 senpi 是 pi 的 fork' },
    monitor: 'tracked',
    localRoots: ['.omo/agent/sessions', '.senpi/agent/sessions'],
    source: {
      kind: 'jsonl',
      jsonl: {
        fileMatch: '**/*.jsonl',
        requiredPaths: [],
        parser: 'pi',
        note:
          '~/.omo/agent(OMO_CODING_AGENT_DIR/.senpi fallback)下按 pi 系惯例 sessions/*.jsonl;' +
          '格式按 pi 形状解析(family 证据,装好后黑盒复核)'
      }
    },
    mcp: {
      file: '.omo/agent/mcp.json',
      jsonpath: '$.mcpServers.memorysql',
      requiredKeys: ['url'],
      note: '上游 setup 文档确认 ~/.omo/agent/mcp.json;形状按 Pi 系推断,装好后复核'
    },
    rules: { project: ['AGENTS.md'], evidence: 'family', note: 'pi 系引擎沿用 AGENTS.md 约定;装好后金丝雀复核' },
    riskKeywords: DEFAULT_RISK_KEYWORDS
  },
  {
    id: 'grok',
    name: 'Grok Build',
    agentType: 'grok',
    upstream: {
      kind: 'github',
      repo: 'xai-org/grok-build',
      note: '开源 Apache-2.0(2026-07 开源,约 84.5 万行 Rust);官方 changelog 三处独立确认 ~/.grok/sessions'
    },
    monitor: 'tracked',
    localRoots: ['.grok/sessions'],
    source: {
      kind: 'jsonl',
      jsonl: {
        fileMatch: '**/updates.jsonl',
        requiredPaths: [],
        parser: 'grok',
        note:
          'sessions/<urlencode(cwd)>/<id>/:summary.json(info.id/cwd,created_at,generated_title,' +
          'parent_session_id,session_kind)+ updates.jsonl(timestamp 秒;user_message/' +
          'agent_message/tool_call 事件)。GROK_HOME 可覆盖根。格式按 magpie 实证解析还原'
      }
    },
    mcp: null, // MCP 在 ~/.grok/config.toml(changelog v0.2.113 佐证);TOML 表名黑盒确认后补连接器
    rules: { project: ['AGENTS.md'], evidence: 'docs', note: 'xAI 文档写明读 AGENTS.md;装好后可金丝雀复核' },
    riskKeywords: DEFAULT_RISK_KEYWORDS
  },
  {
    id: 'minimax',
    name: 'MiniMax Code',
    agentType: 'minimax',
    upstream: {
      kind: 'github',
      repo: 'MiniMax-AI/minimax-code',
      note: 'CLI 开源 MIT(bin mcode,npm @minimax-ai/code);桌面 app 闭源不管。npm @minimax-ai/code'
    },
    monitor: 'tracked',
    localRoots: ['.minimax/v2/sessions'],
    source: {
      kind: 'jsonl',
      jsonl: {
        fileMatch: '**/messages.jsonl',
        requiredPaths: [],
        parser: 'minimax',
        note:
          'v2/sessions/<yyyy>/<mm>/<dd>/<hh-mm-ss-ms>-session_<base64(id)>/messages.jsonl,' +
          '一行一条 {message_id, message:{role,model,usage,timestamp(毫秒),content}};' +
          '会话 id = -session_ 后的 base64。格式按 magpie 对 @minimax-ai/code 0.6.8 的实证解析还原'
      }
    },
    mcp: null, // ~/.minimax/mcp.json 的形态只有第三方工具背书,黑盒确认后补连接器
    rules: {
      project: ['AGENTS.md'],
      evidence: 'source',
      note: 'CLI 运行时 vendor 了 pi-mono(仓库 third_party/),规则机制随 pi;' +
        '仓库自身就用 AGENTS.md + .agents/skills。装好后金丝雀复核'
    },
    riskKeywords: DEFAULT_RISK_KEYWORDS
  },
  {
    id: 'deveco',
    name: 'DevEco Code',
    agentType: 'deveco',
    upstream: {
      kind: 'commit',
      repo: 'CarSmallGuo/deveco-code',
      note:
        '华为 HarmonyOS 开发 agent,**基于华为 BitFun + OpenCode 构建**(HDC 2026 发布;' +
        'npm 分发 @deveco/deveco-code,repo 为社区镜像)—— 盯 opencode 上游的 schema 变更即可覆盖它;' +
        '会话存储官方文档未写,需黑盒探测'
    },
    monitor: 'tracked',
    localRoots: ['.local/share/deveco', 'AppData/Local/deveco'],
    source: {
      kind: 'sqlite',
      sqlite: {
        tablesAnyOf: [
          ['session_v2', 'session_message'],
          ['session', 'message', 'part']
        ],
        requiredColumns: {
          session_v2: ['id', 'directory', 'title', 'time_created', 'time_updated'],
          session: ['id', 'directory', 'title', 'time_created', 'time_updated']
        },
        note:
          'opencode 系 fork,库文件名未黑盒确认(deveco.db?)—— 适配器在数据根下逐 *.db ' +
          '探测布局,对不上返回 []。证据级 family;装好后黑盒校准库名'
      }
    },
    mcp: {
      file: '.config/deveco/deveco.jsonc',
      jsonpath: '$.mcp.memorysql',
      requiredKeys: ['type', 'url'],
      valueHints: { type: 'remote' },
      note: 'opencode 形状(v2 起 type 必填);华为官方文档写明 .deveco/deveco.jsonc(项目级)/~/.config/deveco/deveco.jsonc,JSONC 含注释时连接器会拒写并提示手工'
    },
    rules: { project: ['AGENTS.md'], evidence: 'family', note: 'opencode 系 fork 沿用 AGENTS.md 约定;装好后金丝雀复核' },
    riskKeywords: DEFAULT_RISK_KEYWORDS
  },
  {
    id: 'mimocode',
    name: 'MiMo Code',
    agentType: 'mimocode',
    upstream: {
      kind: 'github',
      repo: 'XiaomiMiMo/MiMo-Code',
      note: '开源 MIT,OpenCode 的 fork(2026-11-10 核实);Windows 数据全落 %LOCALAPPDATA%\mimocode'
    },
    monitor: 'tracked',
    // 2026-11-10 真机校准(本机实装):库在 ~/.local/share/mimocode/mimocode.db,
    // 133MB / 222 会话 / 73 个 parent_id 子代理 / time_archived 列在 —— opencode
    // legacy 三表布局,agent-db-parser 原样适用(副本上 222/222 解析通过)
    localRoots: ['.local/share/mimocode/mimocode.db', 'AppData/Local/mimocode/mimocode.db'],
    source: {
      kind: 'sqlite',
      sqlite: {
        tablesAnyOf: [
          ['session_v2', 'session_message'],
          ['session', 'message', 'part']
        ],
        requiredColumns: {
          session_v2: ['id', 'directory', 'title', 'time_created', 'time_updated'],
          session: ['id', 'directory', 'title', 'time_created', 'time_updated']
        },
        note:
          'opencode legacy 三表布局(2026-11-10 真机副本校准):session 带 parent_id' +
          '(73/222 是子代理)与 time_archived,和 opencode 同语义;message.data ' +
          '{role,agent,time.created,model},part.data {type:text|tool,...}'
      }
    },
    mcp: {
      file: '.config/mimocode/mimocode.jsonc',
      jsonpath: '$.mcp.memorysql',
      requiredKeys: ['type', 'url'],
      valueHints: { type: 'remote' },
      note: 'opencode 形状;上游 README 写明 .mimocode/mimocode.jsonc(项目级)/全局 ~/.config/mimocode/mimocode.jsonc,JSONC 含注释时连接器会拒写并提示手工'
    },
    rules: { project: ['AGENTS.md'], evidence: 'source', note: 'OpenCode fork 沿用 AGENTS.md 约定(上游开源可查);装好后金丝雀复核' },
    riskKeywords: DEFAULT_RISK_KEYWORDS
  }
]

export const AGENT_BY_ID = new Map(AGENTS.map((a) => [a.id, a]))

/** 某条上游更新是否命中高危信号(白盒粗筛;最终判断仍需人) */
export function hitsRiskKeywords(changelog: string, contract: AgentContract): string[] {
  const lower = changelog.toLowerCase()
  return contract.riskKeywords.filter((k) => lower.includes(k.toLowerCase()))
}
