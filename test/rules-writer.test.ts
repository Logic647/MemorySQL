import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENTS, AGENT_BY_ID } from '../src/shared/upstream-agents'
import { buildRulesBlock, resolveRulesTargets, writeRules, MARKER_BEGIN, MARKER_END } from '../src/main/core/rules-writer'

/**
 * 「写入使用规则」第二层。目标路径全部来自台账 rules 字段 ——
 * 那上面的每一行都有证据(金丝雀/源码/官方文档),这里锁的是执行端行为。
 */

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-writer-'))
})

afterEach(() => {
  fs.rmSync(tmp, { force: true, recursive: true })
})

const rulesOf = (id: string) => AGENT_BY_ID.get(id)!.rules!

describe('台账 rules 覆盖(不许猜)', () => {
  it('每一家都有登记;null 只许闭源黑盒守的(机制未探明,不许猜)', () => {
    const missing = AGENTS.filter(
      (a) => !a.rules && !(a.upstream.kind === 'none' && a.monitor === 'blackbox_only')
    ).map((a) => a.id)
    expect(missing, `这些 agent 没登记 rules: ${missing.join(', ')}`).toEqual([])
    expect(AGENTS.length).toBe(24) // 2026-11-10:Magpie 补全 +10,再加 NAS 黑盒校准的 copilot
  })

  it('证据等级必须是白名单内的一个;canary/source/docs 的 project 或 user 至少有一个落点', () => {
    const legal = ['canary', 'source', 'docs', 'family', 'convention']
    for (const a of AGENTS) {
      if (!a.rules) continue // 闭源黑盒守(上一条已限定只许 upstream.kind==='none')
      expect(legal, `${a.id} 证据等级非法`).toContain(a.rules.evidence)
      if (a.rules.evidence !== 'family') {
        // family(workbuddy)是推断,允许只有 note;其余必须有实际落点或说明
        expect(
          a.rules!.project.length + (a.rules!.user?.length ?? 0) > 0 || a.id === 'hermes',
          `${a.id} 既没有落点也没有说明`
        ).toBe(true)
      }
    }
  })

  it('hermes 的落点必须说明是 SOUL.md 且交给 resolver(路径随安装位置变动,不能写死)', () => {
    const r = AGENT_BY_ID.get('hermes')!.rules!
    expect(r.evidence).toBe('source')
    expect(r.note).toContain('SOUL.md')
  })
})

describe('写入器', () => {
  it('新文件:创建并包含标记块与四条时机', () => {
    const projectDir = path.join(tmp, 'proj')
    fs.mkdirSync(projectDir)
    const r = writeRules('codebuddy', rulesOf('codebuddy'), { projectDir })
    expect(r.ok).toBe(true)
    const file = path.join(projectDir, 'CODEBUDDY.md')
    expect(r.written).toContain(file)
    const content = fs.readFileSync(file, 'utf-8')
    expect(content).toContain(MARKER_BEGIN)
    expect(content).toContain(MARKER_END)
    for (const t of ['memory_get_context', 'memory_search', 'memory_write', 'memory_log_progress']) {
      expect(content).toContain(t)
    }
  })

  it('幂等:写两次不产生重复块', () => {
    const projectDir = path.join(tmp, 'proj')
    fs.mkdirSync(projectDir)
    writeRules('codebuddy', rulesOf('codebuddy'), { projectDir })
    const r2 = writeRules('codebuddy', rulesOf('codebuddy'), { projectDir })
    const content = fs.readFileSync(path.join(projectDir, 'CODEBUDDY.md'), 'utf-8')
    expect(content.split(MARKER_BEGIN).length - 1).toBe(1)
    expect(r2.written.length + r2.skipped.length).toBeGreaterThan(0)
  })

  it('已有内容的文件:追加且保留原内容,并留 .bak 备份', () => {
    const projectDir = path.join(tmp, 'proj')
    fs.mkdirSync(projectDir)
    const file = path.join(projectDir, 'CODEBUDDY.md')
    fs.writeFileSync(file, '# 我的项目规则\n\n- 不要乱动我的目录结构\n', 'utf-8')
    writeRules('codebuddy', rulesOf('codebuddy'), { projectDir })
    const content = fs.readFileSync(file, 'utf-8')
    expect(content.startsWith('# 我的项目规则')).toBe(true)
    expect(content).toContain(MARKER_BEGIN)
    expect(fs.existsSync(file + '.bak-memorysql')).toBe(true)
  })

  it('标记不配对(有头无尾)时拒绝写入,不碰坏文件', () => {
    const projectDir = path.join(tmp, 'proj')
    fs.mkdirSync(projectDir)
    const file = path.join(projectDir, 'CODEBUDDY.md')
    fs.writeFileSync(file, `${MARKER_BEGIN}\n半截块\n`, 'utf-8')
    const r = writeRules('codebuddy', rulesOf('codebuddy'), { projectDir })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('标记')
    expect(fs.readFileSync(file, 'utf-8')).toBe(`${MARKER_BEGIN}\n半截块\n`)
  })

  it('qoder 是规则目录:写 <dir>/memorysql.md,不覆盖用户已有规则文件', () => {
    const projectDir = path.join(tmp, 'proj')
    fs.mkdirSync(path.join(projectDir, '.qoder', 'rules'), { recursive: true })
    fs.writeFileSync(
      path.join(projectDir, '.qoder', 'rules', 'my-own.md'),
      '# 用户自己的规则\n',
      'utf-8'
    )
    const r = writeRules('qoder', rulesOf('qoder'), { projectDir })
    expect(r.ok).toBe(true)
    expect(fs.readFileSync(path.join(projectDir, '.qoder', 'rules', 'memorysql.md'), 'utf-8')).toContain(
      MARKER_BEGIN
    )
    // 用户已有规则原样保留
    expect(
      fs.readFileSync(path.join(projectDir, '.qoder', 'rules', 'my-own.md'), 'utf-8')
    ).toBe('# 用户自己的规则\n')
  })

  it('用户级规则(codex)在未给项目目录时写 home 下的目标', () => {
    // 不真写 home:用 HOME 指向 tmp 的方式由 resolveRulesTargets 的调用方控制,
    // 这里直接验证解析结果的路径形状
    const t = resolveRulesTargets('codex', rulesOf('codex'), {})
    expect(t.error).toBeUndefined()
    // codex 的 user 落点在本机真实存在(~/.codex/AGENTS.md),解析必须指向它
    expect(t.user).not.toBeNull()
    expect(t.user!.file.replace(/\\/g, '/')).toContain('.codex/AGENTS.md')
  })

  it('只认项目级的 agent(qoder)不给目录时明确报错,而不是猜一个位置', () => {
    const t = resolveRulesTargets('qoder', rulesOf('qoder'), {})
    expect(t.error).toContain('项目根目录')
    expect(t.project).toBeNull()
  })

  it('workbuddy 按 CODEBUDDY.md 记(family 证据),不静默装作实测', () => {
    expect(rulesOf('workbuddy').evidence).toBe('family')
    expect(rulesOf('workbuddy').project).toEqual(['CODEBUDDY.md'])
  })
})

describe('块内容', () => {
  it('与 MCP instructions 同口径:四时机 + 预算', () => {
    const b = buildRulesBlock()
    for (const t of ['memory_get_context', 'memory_search', 'memory_write', 'memory_log_progress']) {
      expect(b).toContain(t)
    }
    expect(b).toContain('最多一次')
  })
})
