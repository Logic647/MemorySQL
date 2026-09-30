/**
 * 影响评估 —— 规则优先,LLM 可选增强。
 *
 * 分工(重要):
 *   白盒(规则)  changelog 文本 → 关键词命中 → 风险分级。快、零成本、确定性,
 *               但只能「筛出需要重点看的」。
 *   黑盒(本机)  真实数据 schema 探测 → 唯一能给确定答案的手段。跑在开发机,
 *               不在云端(见 upstream/check.ts)。本模块**不做**黑盒判断。
 *   LLM         读懂隐晦措辞,给出人话结论。**永远可选**:没配 key / 调用失败 /
 *               超时,一律降级为纯规则结果,绝不阻塞看板(遵循项目铁律 3)。
 *
 * 风险分级:
 *   none     未命中任何信号
 *   low      命中弱信号
 *   medium   命中中信号,或 LLM 认为可能相关
 *   high     命中强信号(明确指向我们依赖的结构),或 LLM 判定有影响
 */

/**
 * 强信号词表 —— **刻意用短语而非单词**。
 *
 * 实测踩坑:早期版本用单词(table / column / rename / storage),结果
 * claude-code 的 "rename it"(UI 提示)与 "markdown table"(排版)、hermes 的
 * "two-column ticket modal"(UI 布局)全被判 high —— 4 家同时报红而无一与存储
 * 结构有关。告警泛滥等于没告警,所以单词级通用词一律降级,只有命中
 * 「结构变更短语」才升 high。
 */
const STRONG = [
  'schema change', 'schema migration', 'migrate schema', 'schema mismatch',
  'database schema', 'change schema', 'schema changed', 'schema update',
  'db migration', 'database migration', 'migration guide',
  'rename table', 'rename field', 'rename column', 'renamed the field',
  'drop column', 'drop table', 'add column', 'new column', 'column removed',
  'table renamed', 'new table',
  'config format', 'configuration format', 'config schema', 'configuration schema',
  'config key', 'configuration key', 'config option', 'breaking change',
  'storage format', 'session format', 'data format', 'file format', 'path change',
  'directory structure', 'file layout', 'no longer written',
  '迁移', '存储格式', '数据格式', '文件格式', '重命名', '路径变更', '配置项', '不再支持'
]

/** 中等信号:值得看一眼,不足以要求立刻适配 */
const MEDIUM = [
  'deprecat', 'removed', 'no longer', 'shuffle', 'moved', 'default changed',
  'schema', 'migrate', 'rename', 'table', 'column', 'storage', 'database', 'session file',
  'breaking', 'format', '路径', '格式'
]

const WEAK = ['fix', 'perf', 'style', 'typo', 'docs', 'test', 'chore']

/**
 * 否定模式 —— changelog 里**显式声明没有破坏性变更**的固定句式。
 *
 * 实测踩坑:qwen-code 用 Keep a Changelog 格式,每次发版都固定输出
 * 「## Breaking Changes / No known breaking changes」,于是每个版本都被判 high。
 * 这类「有标题无内容」的段落必须先被否定模式抵消,否则告警永远是红的。
 */
const NEGATION = [
  'no known breaking changes',
  'no breaking changes',
  'no breaking change',
  'without breaking changes',
  'backwards compatible',
  'backward compatible',
  'no migration required',
  '无需迁移',
  '无破坏性变更',
  '没有破坏性变更',
  '向后兼容',
  '保持兼容'
]

/** 命中否定句式时,应被抵消掉的强信号 */
const NEGATABLE = ['breaking change', 'breaking changes', 'migrate schema', 'schema migration']

/**
 * 纯规则评估:不依赖网络,确定性。
 *
 * 分级词表(STRONG/MEDIUM/WEAK)是**内置的**,直接扫 changelog 文本;
 * 台账的 riskKeywords 只用于「命中了哪些声明过的词」这一展示口径。
 * 两者刻意解耦 —— 若分级也依赖台账收录,台账一旦漏收某个强信号词,该词就永远
 * 升不了级(实测踩过:中文强信号「存储格式」不在台账里,导致 high 判不出来)。
 */
export function ruleEvaluate(changelog, agent) {
  const text = String(changelog ?? '')
  const lower = text.toLowerCase()
  const has = (k) => lower.includes(String(k).toLowerCase())

  const negated = NEGATION.filter(has)
  // 强信号先扫,再把「被显式否定的」剔掉
  const strongRaw = STRONG.filter(has)
  const strong = negated.length
    ? strongRaw.filter((k) => !NEGATABLE.some((n) => String(k).toLowerCase().includes(n)))
    : strongRaw
  const medium = MEDIUM.filter(has)
  const weak = WEAK.filter(has)
  const declared = (agent?.riskKeywords ?? []).filter(has)

  let risk = 'none'
  if (strong.length) risk = 'high'
  else if (medium.length) risk = 'medium'
  else if (weak.length) risk = 'low'

  // 展示用:台账声明过的词优先,再补上分级表里命中但台账没收的
  const hits = [...new Set([...declared, ...strong, ...medium])]

  return {
    risk,
    hits,
    strongHits: strong,
    negatedBy: negated,
    note:
      risk === 'none'
        ? '未命中风险信号'
        : `命中 ${hits.length} 个风险词${strong.length ? `(强:${strong.join(',')})` : ''}` +
          (negated.length ? ` —— 已按否定声明「${negated[0]}」抵消强信号` : '')
  }
}

/**
 * 汇总一次评估。changelog 为空(闭源或 release 无正文)时,如实标记为
 * 「无法评估」—— 绝不假装评估过。
 */
export function evaluate(agent, upstream) {
  const base = {
    agentId: agent.id,
    version: upstream?.version ?? null,
    publishedAt: upstream?.publishedAt ?? null,
    url: upstream?.url ?? null,
    notes: upstream?.notes ?? '',
    fetchError: upstream?.error ?? null,
    fallbackUsed: upstream?.fallbackUsed ?? false,
    fallbackReason: upstream?.fallbackReason ?? null
  }

  // 闭源且**没拿到** notes → 只能靠黑盒,此时不该假装能评估
  // (但若用户从看板手动粘贴了 changelog,就必须正常评估,否则手动入口形同虚设)
  const blackboxOnly = agent.monitor === 'blackbox_only' || agent.upstream?.kind === 'none'

  if (blackboxOnly && !base.notes) {
    return {
      ...base,
      risk: 'unknown',
      riskLabel: '仅黑盒',
      hits: [],
      llm: null,
      reason: '闭源 agent,无公开更新日志。只能靠本机黑盒契约测试发现漂移(npm run upstream:check);也可在看板手动粘贴 changelog'
    }
  }

  if (!base.notes) {
    return {
      ...base,
      risk: 'unknown',
      riskLabel: '无法评估',
      hits: [],
      llm: null,
      reason: base.fetchError ?? '未抓到 changelog 正文,无法做白盒评估'
    }
  }

  const rule = ruleEvaluate(base.notes, agent)
  return {
    ...base,
    risk: rule.risk,
    riskLabel: { none: '无信号', low: '低', medium: '中', high: '高' }[rule.risk],
    hits: rule.hits,
    // 手动给闭源 agent 补的 changelog:评估照做,但必须提醒它没有自动监控兜底
    reason: blackboxOnly
      ? `${rule.note}(changelog 由人工提供;该 agent 仍无自动监控,漂移只能靠黑盒发现)`
      : rule.note,
    blackboxOnly,
    llm: null
  }
}

/**
 * LLM 增强 —— 可选,失败静默降级。
 * 只有 base.risk 为 medium/high 才值得花 token;low/none 不问。
 */
export async function llmEnhance(result, agent) {
  if (!process.env.LLM_API_KEY) return result
  if (!['medium', 'high'].includes(result.risk)) return result
  if (!result.notes) return result

  const endpoint = process.env.LLM_BASE_URL ?? 'https://api.anthropic.com/v1/messages'
  const model = process.env.LLM_MODEL ?? 'claude-sonnet-4-5'
  const prompt = [
    '你在帮一个「AI agent 会话捕获器」判断上游发版是否影响其兼容性。',
    '',
    `上游 agent: ${agent.name} (${agent.id})`,
    `我们的适配器依赖:${summarizeDeps(agent)}`,
    '',
    '本次更新内容(节选):',
    result.notes.slice(0, 3000),
    '',
    '只回答 JSON,不要任何其他文字:',
    '{"affectsCapture":true|false,"affectsMcp":true|false,"severity":"none|low|medium|high","reason":"一句话中文说明"}'
  ].join('\n')

  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 20000)
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.LLM_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: ctl.signal
    })
    clearTimeout(timer)
    if (!res.ok) return { ...result, llmError: `LLM HTTP ${res.status}` }
    const data = await res.json()
    const text = data?.content?.[0]?.text ?? ''
    const m = text.match(/\{[\s\S]*\}/)
    if (!m) return { ...result, llmError: 'LLM 未返回 JSON' }
    const parsed = JSON.parse(m[0])
    // 规则优先级更高:LLM 只能在规则之上「加严」,不能把 high 降级
    const order = ['none', 'low', 'medium', 'high']
    const merged =
      order.indexOf(parsed.severity ?? 'none') > order.indexOf(result.risk)
        ? parsed.severity
        : result.risk
    return { ...result, risk: merged, llm: parsed }
  } catch (e) {
    return { ...result, llmError: `LLM 调用失败(已降级为规则结果): ${e?.message ?? e}` }
  }
}

function summarizeDeps(agent) {
  const parts = []
  if (agent.mcp) parts.push(`MCP 配置 ${agent.mcp.file} ${agent.mcp.jsonpath} 必需键[${(agent.mcp.requiredKeys ?? []).join(',')}]`)
  if (agent.source?.sqlite) parts.push(`SQLite 表[${(agent.source.sqlite.tablesAnyOf ?? []).flat().join(',')}]`)
  if (agent.source?.jsonl) parts.push(`JSONL ${agent.source.jsonl.fileMatch} parser=${agent.source.jsonl.parser}`)
  return parts.join('; ') || '未声明'
}
