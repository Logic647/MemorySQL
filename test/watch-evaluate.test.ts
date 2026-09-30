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
