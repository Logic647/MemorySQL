import { describe, expect, it } from 'vitest'
import { AGENTS } from '../upstream/agents'
import { render, runChecks } from '../upstream/check'

/**
 * 上游契约黑盒检查
 * ============================================================================
 * 目的:上游 agent 改格式时立刻变红,而不是等用户报障才发现捕获已失效。
 *
 * 这类事故本项目已真实发生过:
 *   - opencode 2.x 把权威库从 session/message/part 迁到 session_v2+session_message,
 *     旧解析器抛 "no such table: session"
 *   - 换机后 hermes/codex 配置路径失效
 *
 * 重要语义(别误读 CI 的绿灯):
 *   漂移检测需要**本机真实数据**。CI runner 上没有任何 agent 目录,该项会全部
 *   判为 absent 而空跑 —— CI 真正守住的是「台账自洽性」,不是真实漂移。
 *   真实漂移要在开发机跑 `npm run upstream:check`(或未来的本机探针定时上报)。
 */
const isCI = !!process.env.CI

describe('上游契约黑盒', () => {
  it('本机可验证的源均无 schema 漂移', async () => {
    const results = await runChecks()
    const drift = results.filter((r) => r.verdict === 'drift')
    const verified = results.filter((r) => r.verdict === 'ok')
    console.log(render(results))

    if (verified.length === 0) {
      // 没有任何可验证源 —— 明确说出来,而不是让"全 absent"看起来像"全通过"
      console.warn(
        `[上游契约] 本机未检测到任何 agent 数据源,漂移检查空跑。` +
          (isCI ? '(CI 环境属预期)' : '请确认本机是否装有已适配的 agent')
      )
    }

    expect(
      drift.map((d) => `${d.id}: ${d.detail}`),
      `检测到 ${drift.length} 家上游格式漂移,需适配后发版`
    ).toEqual([])
  })
})

describe('台账自洽性(防台账腐化)', () => {
  it('id 唯一', () => {
    const ids = AGENTS.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('agentType 与 capture 插件一一对应', () => {
    // 与 settings 里的 CAPTURE_AGENTS 口径一致:每个 agent 都要有捕获能力
    for (const a of AGENTS) {
      expect(a.agentType, `${a.id} 缺 agentType`).toBeTruthy()
    }
  })

  it('tracked 模式必须有上游来源,blackbox_only 必须无', () => {
    for (const a of AGENTS) {
      if (a.monitor === 'tracked') {
        expect(['github', 'commit', 'npm'], `${a.id} 标为 tracked 却无可用上游来源`).toContain(
          a.upstream.kind
        )
      } else {
        expect(a.upstream.kind, `${a.id} 标为 blackbox_only 却有上游来源`).toBe('none')
      }
    }
  })

  it('sqlite 源必须声明表期望,否则探测无意义', () => {
    for (const a of AGENTS) {
      if (a.source.kind === 'sqlite') {
        expect(a.source.sqlite.tablesAnyOf.length, `${a.id} 未声明 tablesAnyOf`).toBeGreaterThan(0)
        // 每组内的表应当描述"同一代布局",字段声明必须落在某一组内
        const all = a.source.sqlite.tablesAnyOf.flat()
        for (const t of Object.keys(a.source.sqlite.requiredColumns)) {
          expect(all, `${a.id} 的 requiredColumns 引用了不在 tablesAnyOf 中的表 ${t}`).toContain(t)
        }
      }
    }
  })

  it('jsonl 源必须声明 parser 名', () => {
    const known = ['claude', 'codex', 'qwen', 'kimi', 'workbuddy', 'qoder']
    for (const a of AGENTS) {
      if (a.source.kind === 'jsonl') {
        expect(known, `${a.id} 的 parser 未在 check.ts 注册`).toContain(a.source.jsonl.parser)
      }
    }
  })

  it('mcp 依赖必须声明必需键(缺键 = 被 agent 静默丢弃)', () => {
    for (const a of AGENTS) {
      if (a.mcp) {
        expect(a.mcp.requiredKeys.length, `${a.id} 的 mcp 未声明 requiredKeys`).toBeGreaterThan(0)
        for (const k of Object.keys(a.mcp.valueHints ?? {})) {
          expect(
            a.mcp.requiredKeys,
            `${a.id} 的 valueHints 指向了非必需键 ${k}`
          ).toContain(k)
        }
      }
    }
  })

  it('风险关键词非空(白盒粗筛依赖它)', () => {
    for (const a of AGENTS) {
      expect(a.riskKeywords.length, `${a.id} 未声明 riskKeywords`).toBeGreaterThan(0)
    }
  })
})
