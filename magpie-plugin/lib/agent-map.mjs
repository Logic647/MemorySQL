// magpie 的 agent 名字 → MemorySQL 的 agent_type。
//
// 两边的命名不同：magpie 显示 "Claude Code" / "Codex"，MemorySQL 的
// sessions.agent_type 是 claudecode / codex。未知名字返回 undefined，
// 让调用方省略 agent 参数 —— 传一个错误的值会把记忆过滤成空，比不传更糟。
const MAP = new Map(
  Object.entries({
    claude: 'claudecode',
    'claude code': 'claudecode',
    claude_code: 'claudecode',
    claudecode: 'claudecode',
    codex: 'codex',
    'openai codex': 'codex',
    zcode: 'zcode',
    opencode: 'opencode',
    'opencode ai': 'opencode',
    gemini: 'gemini',
    'gemini cli': 'gemini',
    qwen: 'qwencode',
    'qwen code': 'qwencode',
    qwencode: 'qwencode',
    kimi: 'kimicli',
    'kimi cli': 'kimicli',
    kimicli: 'kimicli',
    codebuddy: 'codebuddy',
    workbuddy: 'workbuddy',
    'workbuddy ai': 'workbuddy',
    qoder: 'qoder',
    dsh: 'dsh',
    'deepseek harness': 'dsh',
    hermes: 'hermes',
    'hermes agent': 'hermes',
    air: 'air-ide',
    'air ide': 'air-ide',
    'air (jetbrains ides)': 'air-ide',
    goose: 'goose',
    droid: 'droid',
    cline: 'cline',
    pi: 'pi',
    omp: 'omp',
    omo: 'omo',
    grok: 'grok',
    'grok build': 'grok',
    minimax: 'minimax',
    'minimax code': 'minimax',
    deveco: 'deveco',
    mimocode: 'mimocode',
    'mimo code': 'mimocode',
    copilot: 'copilot',
    'github copilot': 'copilot',
    cursor: 'cursor',
    'cursor cli': 'cursor'
  })
)

export function mapAgent(name) {
  if (typeof name !== 'string') return undefined
  const key = name
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
  if (!key) return undefined
  return MAP.get(key)
}

/** 未知 agent 也要能写入/捕获：把显示名收敛成 MemorySQL 接受的 id 形状。 */
export function agentTypeOf(name, fallback = 'magpie') {
  const mapped = mapAgent(name)
  if (mapped) return mapped
  const raw = typeof name === 'string' ? name.trim().toLowerCase() : ''
  const id = raw.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
  return id || fallback
}
