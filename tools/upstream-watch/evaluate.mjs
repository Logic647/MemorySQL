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
import { callLlmJson, llmConfigured } from './llm.mjs'

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

/**
 * 命中否定句式时,应被抵消掉的信号。
 *
 * **必须包含裸词 `breaking`** —— 分级表里 MEDIUM 收的是 `breaking`,
 * 而这里若只写 `breaking change`,`k.includes(n)` 会因裸词更短而判不出来,
 * 抵消不掉(实测 qwen-code 每版都被这个残留词判成 medium)。
 */
const NEGATABLE = ['breaking', 'breaking change', 'breaking changes', 'migrate schema', 'schema migration']

/**
 * 关键词匹配器。
 *
 * **纯 ASCII 词必须按词边界匹配,不能子串包含** —— 实测踩过:
 * qwen-code 的 "anchor rewind mapping to s**table** prompt identity" 里
 * `table` 匹配进了 `stable`,把一条无关的提交记成了结构变更命中。
 * 中文词没有词边界概念(JS 的 `\b` 基于 \w,在 CJK 之间不成立),故 CJK 词仍走子串。
 */
const ASCII_KEYWORD = /^[\x20-\x7e]+$/
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const matcherCache = new Map()
function matcher(keyword) {
  const k = String(keyword)
  if (!matcherCache.has(k)) {
    if (ASCII_KEYWORD.test(k)) {
      // **只锁左边界,右侧一律放行。**
      //   左边界挡住子串误报:`table` 不会命中 s●table●。
      //   右侧不能锁,否则 camelCase 标识符全废:实测 gemini 的
      //   `formatTruncatedToolOutput` 里的 `format` 会连不上 —— 而
      //   "格式相关"本来就是有效信号,JS/TS 仓库的 changelog 里这类词极常见。
      //   复数(s/es)由后缀选项自然覆盖,不需要额外边界。
      const re = new RegExp(`(?<![a-z0-9])${escapeRe(k.toLowerCase())}(?:s|es)?`)
      matcherCache.set(k, (t) => re.test(t))
    } else {
      matcherCache.set(k, (t) => t.includes(k.toLowerCase()))
    }
  }
  return matcherCache.get(k)
}

/**
 * 把 changelog 按 markdown 标题切成小节。
 *
 * 用于**限定否定句式的作用域**:qwen-code 每次发版都输出
 * 「## Breaking Changes / No known breaking changes」这个**空模板小节**。
 * 若否定式全文档生效,等于替整个 release 背书"没有任何破坏性变更",
 * 反而会掩盖别处真的 schema 变更;若完全不生效,模板标题本身又永远把版本判成
 * medium/high。所以:否定式只抵消**同一小节内**的命中 —— 模板小节被抵消,
 * 其它小节里实打实的变更照旧报警。
 */
function sections(text) {
  const out = []
  const lines = text.split('\n')
  let cur = { heading: null, body: '' }
  for (const line of lines) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      out.push(cur)
      cur = { heading: h[2].trim().toLowerCase(), body: '' }
    } else {
      cur.body += line + '\n'
    }
  }
  out.push(cur)
  return out
}

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
  const hasWord = (k) => matcher(k)(lower)

  const negated = NEGATION.filter(hasWord)
  // 找出每个否定句式所在的小节 —— 抵消只在该小节内生效
  const secs = sections(text)
  const negatedSections = new Set()
  for (const s of secs) {
    const low = s.body.toLowerCase()
    if (NEGATION.some((n) => matcher(n)(low))) negatedSections.add(s)
  }
  /**
   * 某命中词是否被否定抵消:必须与否定句式**同处一个小节**。
   * 同一小节 → 抵消(这就是空模板的情形);不同小节 → 保留。
   *
   * 小节内容 = **标题行 + 正文**。标题必须算进去:qwen-code 的模板里
   * `## Breaking Changes` 本身就是 markdown 标题,`breaking change` 这个
   * 强信号出现在 heading 上而不是 body 里 —— 只看 body 会抵消不掉(实测踩过)。
   */
  const killed = (k) => {
    if (!negated.length) return false
    if (!NEGATABLE.some((n) => String(k).toLowerCase().includes(n))) return false
    return secs.some((s) => {
      if (!negatedSections.has(s)) return false
      return matcher(k)(((s.heading ?? '') + '\n' + s.body).toLowerCase())
    })
  }

  const strongRaw = STRONG.filter(hasWord)
  const strong = strongRaw.filter((k) => !killed(k))
  // MEDIUM 也必须过否定过滤 —— 旧实现只过滤 STRONG,于是
  // 「No known breaking changes」抵消掉了 breaking,却留下一堆
  // schema/migration/table/rename,版本照样被判 medium(实测 qwen-code 每版都中招)
  const mediumRaw = MEDIUM.filter(hasWord)
  const medium = mediumRaw.filter((k) => !killed(k))
  const weak = WEAK.filter(hasWord)
  // 台账声明的词同样要过否定过滤 —— 否则 hits 里会出现「已抵消的 breaking」,
  // 展示上自相矛盾(等级对了但命中词表骗人)。实测 qwen-code 就是这样:
  // neg 里明明有 no known breaking changes,hits 里却还挂着 breaking。
  const declared = (agent?.riskKeywords ?? []).filter((k) => hasWord(k) && !killed(k))

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
          (negated.length ? ` —— 同小节内的「${negated[0]}」已抵消 ${strongRaw.length - strong.length + mediumRaw.length - medium.length} 个信号` : '')
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
 *
 * provider 差异(认证头 / token 字段名)已收敛到 llm.mjs,这里只管 prompt 与合并规则。
 */
export async function llmEnhance(result, agent) {
  if (!llmConfigured()) return result
  if (!['medium', 'high'].includes(result.risk)) return result
  if (!result.notes) return result

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

  // 300 太小:实测 MiMo 光 reasoning_tokens 就要 136(推理模型,reasoning 计入
  // completion 预算),留给正文的不到 170,claudecode 这种 21KB changelog 的条目
  // 就会被截断 → JSON 解析失败。宁可多花一点 token,也不要间歇性失败。
  const res = await callLlmJson(prompt, { maxTokens: 800 })
  if (!res.ok) return { ...result, llmError: res.error }

  const parsed = res.data
  if (typeof parsed !== 'object' || parsed === null) {
    return { ...result, llmError: 'LLM 返回的 JSON 不是对象' }
  }
  // 规则优先级更高:LLM 只能在规则之上「加严」,不能把 high 降级
  const order = ['none', 'low', 'medium', 'high']
  const merged =
    order.indexOf(parsed.severity ?? 'none') > order.indexOf(result.risk)
      ? parsed.severity
      : result.risk
  return { ...result, risk: merged, llm: parsed }
}

function summarizeDeps(agent) {
  const parts = []
  if (agent.mcp) parts.push(`MCP 配置 ${agent.mcp.file} ${agent.mcp.jsonpath} 必需键[${(agent.mcp.requiredKeys ?? []).join(',')}]`)
  if (agent.source?.sqlite) parts.push(`SQLite 表[${(agent.source.sqlite.tablesAnyOf ?? []).flat().join(',')}]`)
  if (agent.source?.jsonl) parts.push(`JSONL ${agent.source.jsonl.fileMatch} parser=${agent.source.jsonl.parser}`)
  return parts.join('; ') || '未声明'
}
