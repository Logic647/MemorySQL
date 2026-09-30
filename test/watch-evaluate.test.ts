import { describe, expect, it } from 'vitest'
import { evaluate, ruleEvaluate } from '../tools/upstream-watch/evaluate.mjs'

/**
 * 白盒规则评估器 —— 确定性部分,必须可离线测。
 * LLM 增强不在此测(依赖网络与 key,且按设计失败即降级)。
 */
const agent = {
  id: 'demo',
  name: 'Demo',
  monitor: 'tracked',
  upstream: { kind: 'github', repo: 'x/y' },
  riskKeywords: ['schema', 'migration', 'rename', 'config', 'fix', 'perf'],
  mcp: { file: 'a.json', jsonpath: '$.mcp.memorysql', requiredKeys: ['type', 'url'] }
}
const blackbox = { ...agent, id: 'bb', monitor: 'blackbox_only', upstream: { kind: 'none' } }

describe('ruleEvaluate(纯规则)', () => {
  it('命中强信号 → high', () => {
    const r = ruleEvaluate('feat: change database schema for sessions', agent)
    expect(r.risk).toBe('high')
    expect(r.strongHits.length).toBeGreaterThan(0)
  })

  it('只命中 fix/perf → low 或 none,绝不误报 high', () => {
    expect(ruleEvaluate('fix: typo in readme, perf tweak', agent).risk).not.toBe('high')
  })

  it('中文强信号同样识别', () => {
    expect(ruleEvaluate('修复会话存储格式变更导致的解析失败', agent).risk).toBe('high')
  })

  it('完全无关 → none', () => {
    expect(ruleEvaluate('update readme screenshot', agent).risk).toBe('none')
  })

  /**
   * 词边界回归 —— 2026-09-30 看真实 qwen-code changelog 时撞出来的。
   * 纯子串匹配会让 `table` 命中 `stable`,把无关提交记成结构变更。
   * 下面几句都是 qwen-code v0.24.7 的**原文**。
   */
  it('table 不得匹配进 stable(子串匹配的经典翻车)', () => {
    const real = '- refactor: anchor rewind mapping to stable prompt identity ([#9466](https://x/9466))'
    const r = ruleEvaluate(real, agent)
    expect(r.hits, `误报:${r.hits.join(',')}`).not.toContain('table')
  })

  it('独立成词的 table 仍要命中(词边界不能矫枉过正)', () => {
    const r = ruleEvaluate('refactor: align Flyway Runtime tables with the Broker schema', agent)
    expect(r.hits).toContain('table')
  })

  it('中文关键词不受词边界影响(JS 的词边界在 CJK 之间不成立,必须仍走子串)', () => {
    const r = ruleEvaluate('修复会话存储格式变更导致的解析失败', agent)
    expect(r.risk).toBe('high')
  })

  /**
   * 否定式回归 —— qwen-code 用 Keep a Changelog 模板,每版固定输出
   * 「## Breaking Changes / No known breaking changes」。旧实现**只过滤 STRONG,
   * 过滤不到 MEDIUM**,于是抵消掉 breaking 却留下一堆 schema/migration/table/rename,
   * 版本照样被判 medium —— 实测每版都中招,告警彻底失效。
   */
  it('空模板小节:否定式要同时抵消 MEDIUM,整节归 none', () => {
    const real = [
      '<!-- qwen-release-notes:v1 -->',
      '',
      '## Breaking Changes',
      '',
      'No known breaking changes.',
      '',
      '## Complete Change List',
      '',
      '### Features',
      '',
      '- feat(memory): extract structured scan and bounded retrieval'
    ].join('\n')
    const r = ruleEvaluate(real, agent)
    expect(r.negatedBy).toContain('no known breaking changes')
    expect(r.risk, `残留命中:${r.hits.join(',')}`).toBe('none')
  })

  it('否定式只管自己那一个小节,不能替别处实打实的 schema 变更背书', () => {
    const real = [
      '## Breaking Changes',
      '',
      'No known breaking changes.',
      '',
      '## Complete Change List',
      '',
      '- BREAKING: drop column `legacy` from the sessions table'
    ].join('\n')
    const r = ruleEvaluate(real, agent)
    // 模板小节的空声明被抵消;但另一小节里真的结构性变更必须照报
    expect(r.risk).not.toBe('none')
    expect(r.negatedBy).toContain('no known breaking changes')
  })

  it('没有否定式时行为不变', () => {
    const r = ruleEvaluate('BREAKING: drop column `legacy` from the sessions table', agent)
    expect(r.risk).toBe('high')
  })

  it('空/未定义 changelog 不炸', () => {
    expect(ruleEvaluate('', agent).risk).toBe('none')
    expect(ruleEvaluate(undefined, agent).risk).toBe('none')
  })

  /**
   * 误报回归 —— 以下均为**真实 changelog 原文**。早期用单词级关键词时全部误判 high:
   *   claude-code: "rename it"(UI 提示)、"markdown table"(排版)
   *   hermes:      "two-column ticket modal"(UI 布局)
   * 告警一旦泛滥等于没告警,这些必须停在 medium 以下。
   */
  it('UI 文案里的 rename/table 不得判 high', () => {
    const real =
      'Fixed a crash when a config file uses an unknown extension. ' +
      'If your project ships a custom table of widgets, rename it so the loader picks it up. ' +
      'Indentation now works when a reply uses it to indent text, such as row labels in a markdown table.'
    const r = ruleEvaluate(real, agent)
    expect(r.strongHits, `误报:命中强信号 ${r.strongHits.join(',')}`).toHaveLength(0)
    expect(r.risk).not.toBe('high')
  })

  it('UI 布局描述里的 two-column 不得判 high', () => {
    const real =
      'A kanban design pass with a two-column ticket modal and markdown task text; ' +
      'webhook deliveries mirror queued prompts in the CLI and TUI.'
    expect(ruleEvaluate(real, agent).risk).not.toBe('high')
  })

  /**
   * 否定句式回归 —— qwen-code 用 Keep a Changelog 格式,每个版本都固定输出
   * 「## Breaking Changes / No known breaking changes」。早期把这判成 high,
   * 结果该 agent 永远飘红,等于没有告警。
   */
  it('「No known breaking changes」不得判 high', () => {
    const real = '## Breaking Changes\n\nNo known breaking changes.\n\n## Features\n- feat: add a flag'
    const r = ruleEvaluate(real, agent)
    expect(r.strongHits, 'breaking change 未被否定句式抵消').toHaveLength(0)
    expect(r.risk).not.toBe('high')
    expect(r.negatedBy.length).toBeGreaterThan(0)
  })

  it('「backwards compatible」同样抵消', () => {
    expect(ruleEvaluate('This release is backwards compatible.', agent).risk).not.toBe('high')
  })

  it('真的写 breaking change 且无否定声明时仍判 high', () => {
    const real = '## Breaking Changes\n- breaking change: config format now requires type'
    expect(ruleEvaluate(real, agent).risk).toBe('high')
  })

  it('真正的结构变更短语仍须判 high', () => {
    expect(ruleEvaluate('feat: rename table sessions to session_v2', agent).risk).toBe('high')
    expect(ruleEvaluate('fix: drop column message_id from session table', agent).risk).toBe('high')
    expect(
      ruleEvaluate('BREAKING CHANGE: config format now requires type field', agent).risk
    ).toBe('high')
    expect(ruleEvaluate('chore: 迁移存储格式到新目录', agent).risk).toBe('high')
  })
})

describe('evaluate(汇总)', () => {
  it('闭源 agent → risk=unknown,明确说只能靠黑盒', () => {
    const r = evaluate(blackbox, { notes: '', version: null })
    expect(r.risk).toBe('unknown')
    expect(r.riskLabel).toBe('仅黑盒')
    expect(r.reason).toContain('黑盒')
  })

  /**
   * 手动粘贴入口必须真的生效 —— 闭源 agent 在看板上手动补 changelog 后要照常评估。
   * 曾经因为对 blackbox_only 直接短路,导致这个入口形同虚设(粘了 breaking change
   * 仍返回 unknown),已修。
   */
  it('闭源 agent 手动提供 changelog 后应正常评估', () => {
    const r = evaluate(blackbox, {
      notes: 'breaking change: 会话库从 session 迁移到 conversation 表',
      version: '手动提供'
    })
    expect(r.risk).toBe('high')
    expect(r.blackboxOnly).toBe(true)
    expect(r.reason).toContain('人工提供')
  })

  it('闭源 agent 手动提供无风险 changelog → low/none', () => {
    const r = evaluate(blackbox, { notes: 'fix: 修复界面显示问题', version: '手动提供' })
    expect(['low', 'none']).toContain(r.risk)
  })

  it('有 notes → 走规则', () => {
    const r = evaluate(agent, { notes: 'feat: migrate schema', version: 'v2' })
    expect(r.risk).toBe('high')
    expect(r.version).toBe('v2')
  })

  it('无 notes(抓取失败)→ unknown 且不假装评估过', () => {
    const r = evaluate(agent, { notes: '', error: '限流' })
    expect(r.risk).toBe('unknown')
    expect(r.riskLabel).toBe('无法评估')
    expect(r.reason).toContain('限流')
  })

  it('release 无正文退化 commit 时保留 fallback 标记', () => {
    const r = evaluate(agent, {
      notes: 'feat: schema tweak',
      fallbackUsed: true,
      fallbackReason: 'release 正文为空,改用 commit'
    })
    expect(r.fallbackUsed).toBe(true)
    expect(r.fallbackReason).toContain('commit')
  })
})
