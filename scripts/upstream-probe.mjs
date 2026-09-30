/**
 * 本机黑盒探针 —— 把「确定答案」送上云端 + 落一份可 review 的 Markdown
 * ============================================================================
 * 为什么需要它:云端看板只有白盒(关键词粗筛),必然有误报;黑盒探测真实数据
 * 才有确定答案。但黑盒只能在**有 agent 数据的机器**上跑(通常是本机),
 * 而看板在云端。探针负责把两边接起来。
 *
 * 每次运行做三件事:
 *   1. 跑黑盒契约检查(通过 CLI 子进程,不 import —— 保持工具与生产代码解耦)
 *   2. 上报云端,让看板同时显示白盒 + 黑盒两栏
 *   3. 写一份 Markdown 报告到 docs/upstream-reports/,进 git 可 review
 *
 * 刻意**不**直接写 memories 表:那是应用的数据目录,CLI 直写有并发风险。
 * 结论落 memories 由 agent 在收工时用 memory_log_progress 做(见 DEVLOG)。
 *
 * 用法(Node ≥22):
 *   node --experimental-strip-types scripts/upstream-probe.mjs
 *   PROBE_ENDPOINT=https://watch.logic-yjb.top PROBE_TOKEN=xxx node ... --dry-run
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..')
const REPORTS = path.join(REPO, 'docs', 'upstream-reports')

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const endpoint = process.env.PROBE_ENDPOINT ?? ''
const token = process.env.PROBE_TOKEN ?? ''

function log(...a) {
  console.log(`[probe] ${a.join(' ')}`)
}

// 探针通过子进程跑 TS 检查器,需要 Node ≥22.6(strip-types)。
// 提前给明确提示,而不是让用户看一堆 ERR_UNKNOWN_FILE_EXTENSION 栈
const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 6)) {
  console.error(
    `[probe] 需要 Node ≥22.6(当前 ${process.versions.node})——` +
      `本机探针要执行 TypeScript 检查器。\n` +
      `        升级 Node 后重跑,或改在装有 agent 数据的机器上执行。`
  )
  process.exit(2)
}

/** 跑黑盒检查,拿 JSON。用子进程而非 import,避免工具与生产代码耦合 */
function runBlackbox() {
  const out = execFileSync(
    process.execPath,
    ['--experimental-strip-types', path.join(REPO, 'upstream', 'check.ts'), '--json'],
    { cwd: REPO, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }
  )
  return JSON.parse(out)
}

/** 生成 Markdown 报告(进 git,供 review 与追溯) */
function renderReport(data) {
  const now = new Date()
  const day = now.toISOString().slice(0, 10)
  const L = []
  L.push(`# 上游契约黑盒报告 · ${day}`)
  L.push('')
  L.push(`> 由 \`scripts/upstream-probe.mjs\` 自动生成,勿手改。`)
  L.push(`> 判定:🟢 匹配 · 🔴 上游漂移(需适配发版) · 🟣 检查器自身故障 · 🟡 本机未装 · ⚪ 闭源仅黑盒`)
  L.push('')

  const drift = data.results.filter((r) => r.verdict === 'drift')
  const broken = data.results.filter((r) => r.verdict === 'checker_error')
  const ok = data.results.filter((r) => r.verdict === 'ok')
  const skip = data.results.filter((r) => r.verdict === 'absent' || r.verdict === 'blackbox_only')

  L.push(`**结论**:🟢 ${ok.length} 正常 · 🔴 ${drift.length} 漂移 · 🟣 ${broken.length} 检查器故障 · 🟡⚪ ${skip.length} 未验证`)
  L.push('')

  if (drift.length) {
    L.push('## ⚠ 需要适配发版')
    L.push('')
    for (const r of drift) {
      L.push(`### ${r.id} (${r.name})`)
      L.push('')
      L.push(`- 结论:**上游格式漂移,现有适配器已读不懂**`)
      L.push(`- 源:\`${r.source}\``)
      L.push(`- 详情:${r.detail}`)
      if (r.missingTables?.length) L.push(`- 缺失表:${r.missingTables.join(', ')}`)
      if (r.missingColumns) {
        for (const [t, ms] of Object.entries(r.missingColumns)) L.push(`- \`${t}\` 缺失列:${ms.join(', ')}`)
      }
      L.push('')
      L.push('**处理**:更新 `src/shared/upstream-agents.ts` 台账 → 改对应 `capture-*` 适配器 → `npm test` → 发版')
      L.push('')
    }
  }
  if (broken.length) {
    L.push('## 🟣 检查器自身故障(**不是上游问题**)')
    L.push('')
    L.push('以下失败源自检查工具本身(模块加载/导入错误),**不要照着去适配上游**。')
    L.push('')
    for (const r of broken) L.push(`- **${r.id}**: ${r.detail}`)
    L.push('')
  }

  L.push('## 全量明细')
  L.push('')
  L.push('| agent | 监控 | 判定 | 源 | 详情 |')
  L.push('|---|---|---|---|---|')
  const ICON = { ok: '🟢', drift: '🔴', checker_error: '🟣', absent: '🟡', blackbox_only: '⚪' }
  for (const r of data.results) {
    const detail = String(r.detail).replace(/\|/g, '\\|').slice(0, 120)
    L.push(`| ${r.id} | ${r.monitor} | ${ICON[r.verdict]} ${r.verdict} | \`${r.source}\` | ${detail} |`)
  }
  L.push('')
  L.push('---')
  L.push('')
  L.push(`生成时间:${now.toLocaleString('zh-CN')}`)
  L.push('')
  return { day, text: L.join('\n') }
}

async function report(blackbox) {
  if (!endpoint) {
    log('未设 PROBE_ENDPOINT,跳过云端上报')
    return
  }
  // 端点补全:用户通常只给站点根地址,这里补上 /api/probe。
  // 踩过的坑:曾直接 POST 根路径,而服务端的 `/` 分支不检查 method、照常返回
  // index.html + 200,探针据此报「上报成功」而数据根本没进去 —— 假成功最坏,
  // 因为它会让人以为黑盒结果已经在云端上了。
  const url = /\/api\/probe\/?$/.test(endpoint)
    ? endpoint
    : endpoint.replace(/\/+$/, '') + '/api/probe'

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify(blackbox)
    })
    if (!res.ok) {
      log(`云端上报失败 HTTP ${res.status}(${url})`)
      return
    }
    // 必须校验响应体 —— 只看 status 会被「返回 HTML 但状态 200」骗过去
    const ack = await res.json().catch(() => null)
    if (!ack || ack.ok !== true) {
      log(`云端未确认接收:响应不是预期 JSON(${url})`)
      return
    }
    log(`云端上报成功:已接收 ${ack.accepted} 条`)
  } catch (e) {
    log(`云端上报失败(不影响本地报告):${e?.message ?? e}`)
  }
}

const blackbox = runBlackbox()
const { day, text } = renderReport(blackbox)

const file = path.join(REPORTS, `${day}.md`)
if (dryRun) {
  console.log('\n--- (dry-run,未写盘) ---')
  console.log(text)
} else {
  fs.mkdirSync(REPORTS, { recursive: true })
  fs.writeFileSync(file, text, 'utf-8')
  log(`报告已写入 ${path.relative(REPO, file)}`)
}

if (!dryRun) await report(blackbox)

const drift = blackbox.results.filter((r) => r.verdict === 'drift')
const broken = blackbox.results.filter((r) => r.verdict === 'checker_error')
log(
  `完成:🔴 ${drift.length} 漂移 · 🟣 ${broken.length} 检查器故障` +
    (drift.length ? ` —— 见报告,需适配发版` : '')
)
process.exit(drift.length ? 1 : 0)
