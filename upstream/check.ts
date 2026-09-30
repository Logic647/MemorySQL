/**
 * 上游契约黑盒检查 —— 「上游有没有变,我的适配器还读得懂吗?」
 * ============================================================================
 * 判定口径(重要):
 *   🟢 schema 匹配      —— 上游存储结构仍与台账一致,捕获不受影响
 *   🔴 schema 漂移      —— 表/列对不上,捕获大概率已失效,需要适配 → 发版
 *   🟡 源不存在        —— 本机没装该 agent,无法验证(不是故障)
 *   ⚪ 仅黑盒          —— 闭源 agent,无 changelog 可盯,只能靠这里
 *
 * 设计取舍:SQLite 源探测 schema(快、稳、直击要害),不跑完整 parser;
 * JSONL 源则真的调生产 parser 解析样本。前者正是被 opencode 2.x 咬过的那类
 * 问题(no such table: session)—— schema 探测能在解析器崩之前就发现。
 *
 * 入口:
 *   - test/upstream-contract.test.ts  → CI 自动跑,漂移即红
 *   - npm run upstream:check          → 本地看彩色表格
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { AGENTS, type AgentContract } from '../src/shared/upstream-agents.ts'

/**
 * 注意 import 带 `.ts` 扩展名:这是为了同时满足两边 ——
 *   - vitest / vite:接受
 *   - node --experimental-strip-types(Node 22+):**要求**显式扩展名
 * 探针脚本(upstream-probe)要用 node 直接跑本模块,不能走 vitest。
 */

export type Verdict =
  | 'ok' /** schema 匹配 */
  | 'drift' /** 上游漂移 —— 需要适配发版 */
  /** 检查器自身故障(模块加载失败等)—— **不是**上游问题,别照着去适配 */
  | 'checker_error'
  | 'absent' /** 本机没装该 agent */
  | 'blackbox_only' /** 闭源,只能靠这里 */

export interface CheckResult {
  id: string
  name: string
  agentType: string
  monitor: string
  verdict: Verdict
  source: string
  detail: string
  tables?: string[]
  missingTables?: string[]
  missingColumns?: Record<string, string[]>
  upstream: string
  notes?: string
}

/**
 * 路径探测器 —— 复用生产代码里的探测链,台账不重复实现路径逻辑。
 * 新增 resolver 时在此登记,并在 agents.ts 里按名字引用。
 */
const RESOLVERS: Record<string, () => Promise<string | null>> = {
  // 安装位置随注册表/盘符变动:配置 → 注册表 → 各盘符根 → home
  hermes: async () => {
    const m = await import('../src/plugins/capture-hermes/index')
    const root = m.resolveHermesHome(undefined)
    if (!root) return null
    // profiles 根下可能是根级 state.db,或 profiles/<name>/state.db
    const rootDb = path.join(root, 'state.db')
    if (fs.existsSync(rootDb)) return rootDb
    const profilesDir = path.join(root, 'profiles')
    try {
      for (const e of fs.readdirSync(profilesDir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue
        const db = path.join(profilesDir, e.name, 'state.db')
        if (fs.existsSync(db)) return db
      }
    } catch {
      /* no profiles dir */
    }
    return null
  }
}

async function resolveRoot(contract: AgentContract): Promise<string | null> {
  for (const r of contract.localRoots) {
    if (typeof r !== 'string') {
      const fn = RESOLVERS[r.resolver]
      if (!fn) continue
      try {
        const hit = await fn()
        if (hit && fs.existsSync(hit)) return hit
      } catch {
        /* resolver 失败视为未找到 */
      }
      continue
    }
    const abs = path.isAbsolute(r) ? r : path.join(os.homedir(), r)
    if (fs.existsSync(abs)) return abs
  }
  return null
}

function tableNames(db: Database.Database): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>
  ).map((r) => r.name)
}

function columnsOf(db: Database.Database, table: string): string[] {
  try {
    return (db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as Array<{ name: string }>).map(
      (r) => r.name
    )
  } catch {
    return []
  }
}

function base(c: AgentContract, source: string): CheckResult {
  return {
    id: c.id,
    name: c.name,
    agentType: c.agentType,
    monitor: c.monitor,
    verdict: 'absent',
    source,
    detail: '',
    upstream: c.upstream.repo ?? c.upstream.kind
  }
}

function checkSqlite(c: AgentContract, dbPath: string): CheckResult {
  const b = base(c, dbPath)
  if (c.source.kind !== 'sqlite') return b
  const exp = c.source.sqlite

  // 只读打开;库可能正被该 agent 运行实例占用
  let db: Database.Database
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true })
  } catch (e) {
    return { ...b, verdict: 'drift', detail: `无法打开库(可能被占用): ${String(e).slice(0, 120)}` }
  }
  try {
    const present = tableNames(db)
    b.tables = present

    // tablesAnyOf:任一组合命中即视为布局识别成功(支持多代布局并存)
    const matched = exp.tablesAnyOf.find((g) => g.every((t) => present.includes(t)))
    if (!matched) {
      return {
        ...b,
        verdict: 'drift',
        missingTables: exp.tablesAnyOf.flat(),
        detail: `表结构对不上!期望任一组 ${JSON.stringify(exp.tablesAnyOf)},实际 ${present.join(',') || '(空)'}`
      }
    }

    // 列校验:只校验命中布局中声明了列的表
    const missingColumns: Record<string, string[]> = {}
    for (const [table, required] of Object.entries(exp.requiredColumns)) {
      if (!matched.includes(table)) continue
      const miss = required.filter((col) => !columnsOf(db, table).includes(col))
      if (miss.length) missingColumns[table] = miss
    }
    if (Object.keys(missingColumns).length > 0) {
      return {
        ...b,
        verdict: 'drift',
        missingColumns,
        detail: `表在但列变了:${Object.entries(missingColumns)
          .map(([t, ms]) => `${t} 缺 ${ms.join(',')}`)
          .join('; ')}`
      }
    }

    return { ...b, verdict: 'ok', detail: `布局 [${matched.join(',')}] 与列均匹配(共 ${present.length} 张表)` }
  } finally {
    db.close()
  }
}

function findFirst(root: string, ext: string, depth = 0): string | null {
  if (depth > 6) return null
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return null
  }
  for (const e of entries) {
    const p = path.join(root, e.name)
    if (e.isFile() && p.toLowerCase().endsWith(ext)) return p
    if (e.isDirectory()) {
      const hit = findFirst(p, ext, depth + 1)
      if (hit) return hit
    }
  }
  return null
}

async function checkJsonl(c: AgentContract, root: string): Promise<CheckResult> {
  const b = base(c, root)
  if (c.source.kind !== 'jsonl') return b
  const exp = c.source.jsonl
  const file = findFirst(root, '.jsonl')
  if (!file) return { ...b, detail: '源目录存在但没找到 .jsonl 文件' }

  // 动态载入生产 parser —— 不做二次实现,避免检查器与适配器行为分叉
  // import 一律带 .ts:node --experimental-strip-types 要求,vitest 也接受
  const parsers: Record<string, (fp: string, text: string) => Promise<unknown>> = {
    claude: async (fp, text) => {
      const m = await import('../src/plugins/capture-claudecode/claude-parser.ts')
      return m.parseClaudeJsonl(fp, text, c.agentType as never)
    },
    codex: async (fp, text) => {
      const m = await import('../src/plugins/capture-codex/codex-parser.ts')
      return m.parseCodexRollout(fp, text)
    },
    qwen: async (fp, text) => {
      const m = await import('../src/plugins/capture-qwencode/qwencode-parser.ts')
      return m.parseQwenJsonl(fp, text)
    },
    kimi: async (_fp, text) => {
      const m = await import('../src/plugins/capture-kimicli/kimicli-parser.ts')
      return m.parseKimiContext(text)
    },
    workbuddy: async (fp, text) => {
      const m = await import('../src/plugins/capture-workbuddy/workbuddy-parser.ts')
      return m.parseWorkbuddyJsonl(fp, text)
    },
    qoder: async (fp) => {
      const m = await import('../src/plugins/capture-qoder/index.ts')
      return m.parseQoderSession(fp)
    }
  }

  const load = parsers[exp.parser]
  if (!load) return { ...b, verdict: 'checker_error', detail: `未注册的 parser: ${exp.parser}` }

  try {
    const text = fs.readFileSync(file, 'utf-8')
    const parsed = await load(file, text)
    const got = Array.isArray(parsed) ? parsed.length : parsed ? 1 : 0
    if (got === 0) {
      return {
        ...b,
        verdict: 'drift',
        detail: `parser 解析 ${path.basename(file)} 得到 0 条 —— 格式可能已变`
      }
    }
    return { ...b, verdict: 'ok', detail: `解析 ${path.basename(file)} → ${got} 条` }
  } catch (e) {
    // 关键区分:**加载 parser 失败是「检查器自己坏了」,不是「上游漂移」**。
    // 两者混为一谈会产生危险的假阳性 —— 检查器的 bug 会伪装成上游问题,
    // 白白触发一次适配发版。
    const msg = e instanceof Error ? e.message : String(e)
    if (/Cannot find module|ERR_MODULE_NOT_FOUND|is not exported|SyntaxError/.test(msg)) {
      return {
        ...b,
        verdict: 'checker_error',
        detail: `检查器自身故障(非上游问题):${msg.slice(0, 140)}`
      }
    }
    return { ...b, verdict: 'drift', detail: `parser 抛错: ${msg.slice(0, 160)}` }
  }
}

function checkJson(c: AgentContract, root: string): CheckResult {
  return {
    ...base(c, root),
    verdict: 'ok',
    detail: 'JSON 源:逐条 parseGeminiHistory,不做 schema 探测'
  }
}

export async function checkOne(c: AgentContract): Promise<CheckResult> {
  const root = await resolveRoot(c)
  if (!root) {
    return {
      ...base(c, c.localRoots.map((r) => (typeof r === 'string' ? r : `<${r.resolver}>`)).join(' | ')),
      verdict: c.monitor === 'blackbox_only' ? 'blackbox_only' : 'absent',
      detail: '本机未检测到源(非故障)',
      notes: c.notes
    }
  }
  const r =
    c.source.kind === 'sqlite'
      ? checkSqlite(c, root)
      : c.source.kind === 'jsonl'
        ? await checkJsonl(c, root)
        : checkJson(c, root)
  return { ...r, notes: c.notes }
}

export async function runChecks(only?: string[]): Promise<CheckResult[]> {
  const targets = only?.length ? AGENTS.filter((a) => only.includes(a.id)) : AGENTS
  const out: CheckResult[] = []
  for (const c of targets) out.push(await checkOne(c))
  return out
}

const ICON: Record<Verdict, string> = {
  ok: '🟢',
  drift: '🔴',
  checker_error: '🟣',
  absent: '🟡',
  blackbox_only: '⚪'
}

export function render(results: CheckResult[]): string {
  const L: string[] = []
  L.push('', '=== 上游契约黑盒检查 ===', '')
  for (const r of results) {
    L.push(`${ICON[r.verdict]} ${r.id.padEnd(12)} ${r.name}  [${r.monitor}]`)
    L.push(`     源   : ${r.source}`)
    L.push(`     结果 : ${r.detail}`)
    if (r.missingTables?.length) L.push(`     缺表 : ${r.missingTables.join(', ')}`)
    if (r.missingColumns) {
      for (const [t, ms] of Object.entries(r.missingColumns)) L.push(`     缺列 : ${t} → ${ms.join(', ')}`)
    }
    if (r.notes) L.push(`     备注 : ${r.notes}`)
    L.push('')
  }
  const drift = results.filter((r) => r.verdict === 'drift')
  const broken = results.filter((r) => r.verdict === 'checker_error')
  const ok = results.filter((r) => r.verdict === 'ok')
  const skip = results.filter((r) => r.verdict === 'absent' || r.verdict === 'blackbox_only')
  L.push(
    `汇总: 🟢 ${ok.length} 正常 · 🔴 ${drift.length} 漂移 · 🟣 ${broken.length} 检查器故障 · 🟡⚪ ${skip.length} 未验证`
  )
  if (drift.length) {
    L.push('', `⚠ ${drift.length} 家疑似格式漂移,需适配后发版:`)
    for (const r of drift) L.push(`   - ${r.id}: ${r.detail}`)
  }
  if (broken.length) {
    L.push('', `🟣 检查器自身有 ${broken.length} 处故障(**这不是上游问题**,先修检查器):`)
    for (const r of broken) L.push(`   - ${r.id}: ${r.detail}`)
  }
  L.push('')
  return L.join('\n')
}

/**
 * CLI 入口(Node ≥22):`node --experimental-strip-types upstream/check.ts [agentId...]`
 * 加 --json 输出机器可读,供本机探针消费。
 * 保留这个入口而不是让探针走 vitest —— 探针是日常工具,不该依赖测试运行器。
 */
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() ?? '')
if (isMain) {
  const argv = process.argv.slice(2)
  const asJson = argv.includes('--json')
  const only = argv.filter((a) => !a.startsWith('--'))
  const results = await runChecks(only.length ? only : undefined)
  if (asJson) {
    console.log(JSON.stringify({ checkedAt: new Date().toISOString(), results }))
  } else {
    console.log(render(results))
  }
  // 退出码:drift=1 需处理;checker_error=2 是工具自身问题,要在 CI 里区分对待
  process.exit(results.some((r) => r.verdict === 'drift') ? 1 : results.some((r) => r.verdict === 'checker_error') ? 2 : 0)
}
