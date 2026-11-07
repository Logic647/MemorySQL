import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RuleFileExpect } from '../../shared/upstream-agents'

/**
 * 「写入使用规则」的执行端:往 agent 认的规则文件里追加一段**带标记**的工作协议。
 *
 * 设计约束(每条都有事故背景):
 *  - 幂等:重复写不产生重复块 —— 用 memorysql:begin/end 标记,已存在则原位更新
 *  - 可逆:整块删除即可还原;写入前留 .bak 备份
 *  - 不碰坏文件:标记不配对(有 begin 没 end)时拒绝写入,让用户手工处理
 *  - 路径不猜:候选从台账来(rules-probe 金丝雀/源码/官方文档),见 upstream-agents.ts
 */

export const MARKER_BEGIN = '<!-- memorysql:begin (v1) -->'
export const MARKER_END = '<!-- memorysql:end -->'

/** 写进规则文件的工作协议本体。措辞与 MCP instructions 同源(调用时机 + 预算)。 */
export function buildRulesBlock(): string {
  return [
    MARKER_BEGIN,
    '## 与 MemorySQL 协作(MCP)',
    '',
    '- **开工前**:`memory_get_context({ project: "<仓库目录名>" })` 一次,恢复画像/记忆/最近会话/上一棒摘要(每个会话最多一次)',
    '- **回答"上次怎么做的 / 为什么这样定 / 踩过什么坑"前**:先 `memory_search`,不要凭印象',
    '- **拍了架构决策 / 发现用户偏好 / 确认事实**:立刻 `memory_write` 一条(一条只写一件事)',
    '- **收工或换 agent 接手前**:`memory_log_progress` 汇报做了什么/下一步/卡在哪',
    '- 只写你确信的结论;不确定的先向用户确认。这些是本机数据,不要复述给外部服务',
    MARKER_END
  ].join('\n')
}

export interface RulesTarget {
  /** 将写入的绝对路径 */
  file: string
  /** 已存在的目标(追加)还是新建 */
  existed: boolean
}

export interface ResolvedRules {
  agentId: string
  /** 项目级将写入的文件(null = 该家没有项目级规则 / 未给项目目录) */
  project: RulesTarget | null
  /** 用户级将写入的文件 */
  user: RulesTarget | null
  evidence: RuleFileExpect['evidence']
  note?: string
  error?: string
}

function pickExisting(candidates: string[], base: string): string | null {
  for (const rel of candidates) {
    const abs = path.isAbsolute(rel) ? rel : path.join(base, rel)
    try {
      if (fs.existsSync(abs)) return abs
    } catch {
      /* ignore */
    }
  }
  // 都不存在:新建第一个
  const first = candidates[0]
  return first ? (path.isAbsolute(first) ? first : path.join(base, first)) : null
}

/**
 * 解析某家 agent 的规则写入目标。
 * 规则目录型(qoder 的 `.qoder/rules/`)写 <目录>/memorysql.md,不覆盖用户已有规则。
 */
export function resolveRulesTargets(
  agentId: string,
  rules: RuleFileExpect,
  opts: { projectDir?: string }
): ResolvedRules {
  const base: ResolvedRules = { agentId, project: null, user: null, evidence: rules.evidence, note: rules.note }
  let softError: string | undefined

  if (rules.project.length > 0) {
    if (!opts.projectDir) {
      // 不急着报错:codex 这类同时有用户级落点的,不给目录也该把用户级写了
      softError = '该 agent 认项目级规则文件,需要提供项目根目录'
    } else if (!fs.existsSync(opts.projectDir)) {
      softError = `项目目录不存在: ${opts.projectDir}`
    } else {
      const cand = rules.project[0]
      const file = cand.endsWith('/')
        ? path.join(opts.projectDir, cand, 'memorysql.md')
        : pickExisting(rules.project, opts.projectDir) ?? path.join(opts.projectDir, cand)
      base.project = { file, existed: fs.existsSync(file) }
    }
  }

  if ((rules.user?.length ?? 0) > 0) {
    const home = os.homedir()
    const file = pickExisting(rules.user ?? [], home)
    if (file) base.user = { file, existed: fs.existsSync(file) }
  }

  if (!base.project && !base.user) {
    base.error = softError ?? '该 agent 没有可写的规则文件位置'
  }
  return base
}

export interface RulesWriteOutcome {
  ok: boolean
  /** 实际写入的文件(可能多个:项目级 + 用户级) */
  written: string[]
  skipped: string[]
  backups: string[]
  error?: string
}

/** 在单个文件里落块(幂等);返回 null 表示无需改动 */
function upsertBlock(file: string, block: string, makeBackup: boolean): 'written' | 'unchanged' | 'corrupt' {
  let content = ''
  let existed = false
  try {
    content = fs.readFileSync(file, 'utf-8')
    existed = true
  } catch {
    /* 新文件 */
  }

  const begin = content.indexOf(MARKER_BEGIN)
  const end = content.indexOf(MARKER_END)
  if (begin >= 0 && end < 0) return 'corrupt' // 有头没尾:让用户手工处理,别把文件写坏

  const next = (() => {
    if (begin >= 0) {
      const endAt = end + MARKER_END.length
      return content.slice(0, begin) + block + content.slice(endAt)
    }
    // 追加到末尾;文件以标题结尾时留一个空行,别把别人的标题粘在我们的块上
    const sep = existed && content.trim().length > 0 ? '\n\n' : ''
    return content + sep + block + '\n'
  })()

  if (existed && next === content) return 'unchanged'

  if (existed && makeBackup) {
    const backup = `${file}.bak-memorysql`
    try {
      fs.copyFileSync(file, backup)
    } catch {
      /* 备份失败不阻塞写入(文件内容已在内存里,写入是原子的足够程度) */
    }
  }

  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, next, 'utf-8')
  return existed ? 'written' : 'written'
}

/** 解析 + 写入。project/user 两个目标都写(各自独立,一个失败不影响另一个)。 */
export function writeRules(
  agentId: string,
  rules: RuleFileExpect,
  opts: { projectDir?: string; makeBackup?: boolean }
): RulesWriteOutcome {
  const target = resolveRulesTargets(agentId, rules, opts)
  if (target.error && !target.project && !target.user) {
    return { ok: false, written: [], skipped: [], backups: [], error: target.error }
  }

  const block = buildRulesBlock()
  const outcome: RulesWriteOutcome = { ok: true, written: [], skipped: [], backups: [] }

  for (const t of [target.project, target.user]) {
    if (!t) continue
    const r = upsertBlock(t.file, block, opts.makeBackup !== false)
    if (r === 'corrupt') {
      outcome.ok = false
      outcome.error = `${t.file} 里有没配对的 memorysql 标记,请手工处理后重试`
      continue
    }
    if (r === 'unchanged') outcome.skipped.push(t.file)
    else outcome.written.push(t.file)
  }
  if (outcome.written.length === 0 && outcome.skipped.length === 0 && !outcome.error) {
    outcome.ok = false
    outcome.error = target.error ?? '没有可写的目标'
  }
  return outcome
}
