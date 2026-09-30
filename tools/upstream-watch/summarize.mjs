/**
 * 总体情况 —— 把 12 家 + 黑盒 + 逐条 LLM 结论,收成一句人话和一个动作清单。
 *
 * ── 最重要的一条设计约束:数字由代码算,叙述由 LLM 写 ──
 *
 * 最初的想法是"把结果丢给 LLM 让它总结",但那样必然出现 LLM 报出
 * "3 家高风险"而实际只有 2 家的情况 —— **一个会编数字的看板比没有看板更危险**,
 * 因为人会照着它行动。所以:
 *
 *   buildBrief()  纯函数,代码算出所有事实(计数、名单、判定)。可离线测,可信。
 *   summarize()   把 brief 当**唯一**事实来源喂给 LLM,只让它组织语言与排序动作。
 *
 * 摘要里的每个数字都能在 brief 里逐字找到,UI 也会把 brief 的原始计数一并显示在
 * 叙述上方 —— 一旦两者对不上,**用户能看见**,而不是被一段通顺的文字掩盖。
 *
 * 另:LLM 不可用时 brief 照常产出(它本身就有用),叙述为 null,前端显示"未启用/失败"。
 * 这一点很重要 —— 否则"没配 LLM"会退化成"整个面板空白",和静默失败没有区别。
 */
import { callLlmJson, llmConfigured } from './llm.mjs'

/** 白盒判定里值得立刻看一眼的等级 */
const ACTIONABLE = new Set(['high', 'medium'])

function verdictOf(probe, id) {
  return probe?.results?.find((x) => x.id === id) ?? null
}

/**
 * 纯函数:算出全部事实。**不联网、不读环境变量**,因此可完整单测。
 * @param results evaluate() 逐条结果(含 llm / llmError)
 * @param probe   本机探针上报的 { checkedAt, results: [{id, verdict, detail}] }
 * @param ledger  契约一致性 { state, server, probe } —— 见 fingerprint.mjs
 */
export function buildBrief(results, probe, ledger = { state: 'unknown', server: null, probe: null }) {
  const R = results ?? []

  const whitebox = { high: 0, medium: 0, lowOrNone: 0, unknown: 0 }
  for (const r of R) {
    if (r.risk === 'high') whitebox.high++
    else if (r.risk === 'medium') whitebox.medium++
    else if (r.risk === 'unknown') whitebox.unknown++
    else whitebox.lowOrNone++
  }

  const llm = { hit: 0, clear: 0, error: 0, notInvoked: 0 }
  for (const r of R) {
    if (r.llm) {
      if (r.llm.affectsCapture || r.llm.affectsMcp) llm.hit++
      else llm.clear++
    } else if (r.llmError) llm.error++
    else llm.notInvoked++
  }

  const blackbox = { reported: Boolean(probe?.checkedAt), checkedAt: probe?.checkedAt ?? null, drift: 0, checkerError: 0, ok: 0, absent: 0, blackboxOnly: 0 }
  for (const p of probe?.results ?? []) {
    if (p.verdict === 'drift') blackbox.drift++
    else if (p.verdict === 'checker_error') blackbox.checkerError++
    else if (p.verdict === 'absent' || p.verdict === 'blackbox_only') blackbox.absent++
    else if (p.verdict === 'ok') blackbox.ok++
    if (p.verdict === 'blackbox_only') blackbox.blackboxOnly++
  }

  /**
   * 需要处理的名单 = 白盒高/中 ∪ 黑盒漂移 ∪ LLM 判有影响。
   * 三个信号取并集而不是取最大 —— 它们各自能发现对方发现不了的问题
   * (黑盒能抓白盒关键词匹配不到的格式变化,白盒能抓到本机没装的 agent)。
   */
  const attention = []
  for (const r of R) {
    const p = verdictOf(probe, r.agentId)
    const reasons = []
    if (ACTIONABLE.has(r.risk)) reasons.push(`白盒${r.risk === 'high' ? '高' : '中'}风险`)
    if (p?.verdict === 'drift') reasons.push('黑盒确认漂移')
    if (p?.verdict === 'checker_error') reasons.push('黑盒检查器故障')
    if (r.llm?.affectsCapture) reasons.push('LLM 判捕获受影响')
    if (r.llm?.affectsMcp) reasons.push('LLM 判 MCP 受影响')
    if (!reasons.length) continue
    attention.push({
      id: r.agentId,
      version: r.version ?? null,
      risk: r.risk,
      reasons,
      // LLM 的理由一并带上,但标明它是 LLM 说的
      llmReason: r.llm?.reason ?? null,
      blackboxDetail: p?.detail ?? null
    })
  }
  // 严重的排前面;同档按 id 稳定排序,免得每次刷新顺序乱跳
  const rank = { high: 0, medium: 1, low: 2, none: 3, unknown: 4 }
  attention.sort((a, b) => (rank[a.risk] ?? 9) - (rank[b.risk] ?? 9) || a.id.localeCompare(b.id))

  /**
   * 闭源那 4 家必须单独拎出来说:它们没有 changelog,白盒对它们**完全无效**,
   * 黑盒是唯一防线。混在总数里会让人以为"还有 8 家在监控",这是危险的错觉。
   */
  const closedSource = R.filter((r) => r.blackboxOnly || r.risk === 'unknown').map((r) => {
    const p = verdictOf(probe, r.agentId)
    return {
      id: r.agentId,
      blackbox: p?.verdict ?? 'unreported',
      detail: p?.detail ?? '本机探针未上报该 agent'
    }
  })

  /**
   * 真正的抓取失败 —— **必须排除闭源 agent**。
   * 闭源那 4 家的 fetchError 恒为「闭源,无公开更新日志」,那是**预期状态**不是故障;
   * 混进来会显示成红色「抓取失败 4 家」,而且紧挨着「黑盒尚未上报」自相矛盾。
   * 它们由 closedSource 单独呈现,不进这里。
   */
  const fetchErrors = R.filter((r) => r.fetchError && !r.blackboxOnly && r.risk !== 'unknown')
    .map((r) => ({ id: r.agentId, error: r.fetchError }))

  return {
    total: R.length,
    whitebox,
    llm,
    blackbox,
    ledger,
    attention,
    closedSource,
    fetchErrors
  }
}

/** 把 brief 渲染成 prompt 里的纯文本事实段。LLM 只能看到这些,不能自己推。 */
function renderBrief(brief) {
  const L = []
  L.push(`已适配 agent 总数:${brief.total}`)
  L.push(
    `白盒(changelog 关键词)判定:高 ${brief.whitebox.high} · 中 ${brief.whitebox.medium} · ` +
      `无信号 ${brief.whitebox.lowOrNone} · 无法评估 ${brief.whitebox.unknown}`
  )
  L.push(
    `LLM 逐条判定:判有影响 ${brief.llm.hit} · 判无影响 ${brief.llm.clear} · ` +
      `调用失败 ${brief.llm.error} · 未调用(规则判低风险,按设计跳过) ${brief.llm.notInvoked}`
  )
  L.push(
    brief.blackbox.reported
      ? `黑盒(本机真实数据探测,上报于 ${brief.blackbox.checkedAt}):漂移 ${brief.blackbox.drift} · 匹配 ${brief.blackbox.ok} · 本机未装/仅黑盒 ${brief.blackbox.absent} · 检查器故障 ${brief.blackbox.checkerError}`
      : '黑盒:本机探针**尚未上报** —— 闭源那几家的漂移目前无人看守'
  )
  if (brief.ledger?.state === 'mismatch') {
    L.push('')
    L.push(
      `!! 契约不一致:白盒用 ${brief.ledger.server},黑盒用 ${brief.ledger.probe} ——` +
        '两栏是用**不同的适配契约**算出来的,下面的"漂移"结论不可比,' +
        '先同步台账再判断是否需要适配'
    )
  } else if (brief.ledger?.state === 'unknown') {
    L.push('')
    L.push('契约指纹:有一侧未提供(旧版探针不带上报),无法校验白盒与黑盒是否同源')
  }
  if (brief.attention.length) {
    L.push('')
    L.push('需要处理(下列理由已由系统判定,非你推断):')
    for (const a of brief.attention) {
      L.push(`  - ${a.id}${a.version ? ` (${a.version})` : ''}:${a.reasons.join('、')}`)
    }
  } else {
    L.push('')
    L.push('需要处理:无 —— 12 家均无高/中风险,无黑盒漂移,LLM 未判出影响。')
  }
  if (brief.closedSource.length) {
    L.push('')
    L.push('闭源/无法白盒评估的 agent(它们没有公开 changelog,黑盒是唯一防线):')
    for (const c of brief.closedSource) L.push(`  - ${c.id}:黑盒 ${c.blackbox}`)
  }
  if (brief.fetchErrors.length) {
    L.push('')
    L.push('抓取失败(可能是限流或源变更,别把它当成"没更新"):')
    for (const f of brief.fetchErrors) L.push(`  - ${f.id}: ${f.error}`)
  }
  return L.join('\n')
}

const PROMPT = [
  '你在给一个开发者的「AI agent 上游监控看板」写总体情况。',
  '',
  '下面是由程序**已经算好的事实**。你的任务只有一个:把这些事实组织成人能一眼看懂的中文,并给出下一步动作。',
  '',
  '硬性要求:',
  '1. **只能引用上面出现过的数字和 agent 名**。绝对不要自己计算、不要推测、不要补充任何未列出的信息。',
  '2. 不要重复罗列全部 agent,只讲值得注意的。',
  '3. 如果事实里没有任何需要处理的问题,就直说"本周无风险",不要硬造紧迫感。',
  '4. 如果黑盒尚未上报或闭源 agent 无人看守,要点出来 —— 这是当前最大的盲区。',
  '5. actions 是给人做的事,每条要具体到"做什么"(例如"本机跑 npm run upstream:check 确认"),不要写"持续关注"这种空话。',
  '',
  '只回答 JSON,不要任何其他文字:',
  '{"headline":"一句话总体判断(40字内)","actions":["具体动作1","具体动作2"],"blindspot":"当前最大的盲区,一句话;没有就写空字符串"}'
].join('\n')

/**
 * 生成总体情况。
 * @returns {Promise<{brief, headline, actions, blindspot, error, generatedAt, llmInvoked}>}
 *          **永不抛异常**。brief 无论 LLM 成功与否都会产出。
 */
export async function summarize(results, probe, ledger) {
  const brief = buildBrief(results, probe, ledger)
  const base = {
    brief,
    headline: null,
    actions: [],
    blindspot: null,
    error: null,
    generatedAt: null,
    llmInvoked: false
  }

  if (!llmConfigured()) {
    return { ...base, error: '未配置 LLM_API_KEY —— 以下全部为程序统计,未经 LLM 解读' }
  }
  if (!results?.length) {
    return { ...base, error: '尚无抓取结果' }
  }

  // 同 llmEnhance:推理型 provider 的 reasoning 计入 completion 预算,600 偏紧,
  // 会被截断成半个 JSON。宁可多花 token。
  const res = await callLlmJson(`${PROMPT}\n\n---\n事实:\n${renderBrief(brief)}`, { maxTokens: 1200 })
  if (!res.ok) return { ...base, error: res.error, llmInvoked: true }

  const d = res.data
  if (typeof d !== 'object' || d === null) {
    return { ...base, error: 'LLM 返回的 JSON 不是对象', llmInvoked: true }
  }
  return {
    ...base,
    llmInvoked: true,
    generatedAt: new Date().toISOString(),
    headline: typeof d.headline === 'string' ? d.headline.slice(0, 200) : null,
    // 只接受字符串数组,LLM 常把数组写成对象/字符串,这里收窄并限长
    actions: Array.isArray(d.actions)
      ? d.actions.filter((a) => typeof a === 'string' && a.trim()).slice(0, 5).map((a) => a.trim().slice(0, 200))
      : [],
    blindspot: typeof d.blindspot === 'string' ? d.blindspot.slice(0, 200) : null
  }
}
