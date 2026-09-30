import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AGENTS, DEFAULT_RISK_KEYWORDS } from '../src/shared/upstream-agents'
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

  /**
   * hermes 的身份陷阱 —— 2026-09-30 用户纠正过一次,别再犯第二次。
   *
   * 用户装的是中文线(外壳 Eynzof/Hermes-CN-Desktop + 内嵌核心 Eynzof/Hermes-CN-Core),
   * 但台账的 upstream 刻意指向英文上游 NousResearch/hermes-agent,因为分支只是镜像:
   * 它的 commit 全是「同步主分支」这类合并噪音、release 正文为空,盯它会漏掉
   * 上游每一次 schema 变更。变更在上游发生,分支只决定「什么时候轮到我」。
   *
   * 所以这里断言的是**理由必须留在台账里**,而不是断言某个仓库名 ——
   * 换仓库前请先确认新仓库的 release 有可用正文,否则白盒会退化成只看 commit。
   */
  it('hermes:盯的是上游而非用户实际运行的中文分支,且理由已记录', () => {
    const h = AGENTS.find((a) => a.id === 'hermes')!
    expect(h.upstream.repo).toBe('NousResearch/hermes-agent')
    const note = h.upstream.note ?? ''
    // 分支身份必须写在台账里,否则下一个人会以为用户装的就是英文上游
    expect(note, '未记录中文分支身份').toContain('Eynzof/Hermes-CN-Core')
    expect(note, '未记录版本对应关系').toMatch(/runtime-v[\d.]+-cn/)
    expect(note, '未说明为何盯上游').toMatch(/上游/)
  })

  it('hermes:mcp 只要求 url —— protocol/trust 在上游与中文分支都不存在', () => {
    const h = AGENTS.find((a) => a.id === 'hermes')!
    // 曾误写 ['url','protocol','trust'],那等于声明了一个不存在的契约,
    // 还会让写后回读校验去校验死键
    expect(h.mcp?.requiredKeys).toEqual(['url'])
  })
})

/**
 * 台账 JSON 中间层同步 —— 云端(Node 20,零依赖)读的是 upstream/ledger.json,
 * 不是 TS 源。这条断言防止两者悄悄脱节 —— 否则云端会拿着一份过期台账做评估,
 * 而本地一切正常,极难察觉。
 *
 * 重新生成:node --experimental-strip-types scripts/export-ledger.ts
 */
describe('台账 JSON 与 TS 源同步', () => {
  const ledgerPath = path.join(__dirname, '..', 'upstream', 'ledger.json')
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8')) as {
    version: number
    riskKeywords: string[]
    agents: typeof AGENTS
  }

  it('agent 列表一致', () => {
    expect(ledger.agents.map((a) => a.id).sort()).toEqual(AGENTS.map((a) => a.id).sort())
  })

  it('每条契约逐字段一致(不只是 id)', () => {
    for (const src of AGENTS) {
      const got = ledger.agents.find((a) => a.id === src.id)
      expect(got, `ledger.json 缺少 ${src.id}`).toBeDefined()
      expect(got, `${src.id} 内容与 TS 源不一致 —— 跑 export-ledger 重新生成`).toEqual(src)
    }
  })

  it('风险关键词一致', () => {
    expect(ledger.riskKeywords).toEqual(DEFAULT_RISK_KEYWORDS)
  })

  it('云端字段完整(评估器依赖这些)', () => {
    for (const a of ledger.agents) {
      expect(a.id, '缺 id').toBeTruthy()
      expect(a.name, `${a.id} 缺 name`).toBeTruthy()
      expect(['github', 'commit', 'npm', 'none'], `${a.id} 的 upstream.kind 非法`).toContain(
        a.upstream.kind
      )
      if (a.upstream.kind === 'github' || a.upstream.kind === 'commit') {
        expect(a.upstream.repo, `${a.id} 缺 repo`).toBeTruthy()
      }
      expect(['tracked', 'blackbox_only'], `${a.id} 的 monitor 非法`).toContain(a.monitor)
      expect(a.riskKeywords.length, `${a.id} 缺 riskKeywords`).toBeGreaterThan(0)
    }
  })
})
