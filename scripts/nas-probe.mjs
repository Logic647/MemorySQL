/**
 * NAS 黑盒探针 —— 在常驻 NAS(Ubuntu)上看守闭源/开发机未装的 agent
 * ============================================================================
 * 背景:闭源 agent(qoder/codebuddy)无任何公开 changelog,开发机又没装,
 * 黑盒检查只能报 ⚪「仅黑盒」—— 等于无人看守。本脚本把它们(以及三家
 * 开发机未装的开源 CLI:qwencode/kimicli/gemini)装到 NAS 上,每天:
 *
 *     逐家探测版本 → 有更新就升级并跑一个最小会话(逼出新格式的数据)
 *   → 跑 upstream/check.ts 黑盒 → 新鲜度降级(见 nas-freshness.mjs)
 *   → 上报云端(source:'nas',与开发机探针按 agent 合并,互不覆盖)
 *
 * 两个与 scripts/upstream-probe.mjs(开发机)的关键区别:
 *   - 多了「升级 + 产生新会话」步骤。没有新会话,检查到的只是旧格式 ——
 *     agent 升级本身不会触发任何检测,格式变更只在该版本实际写数据时暴露
 *   - 本地报告写 NAS_REPORT_DIR(仓库外),保持 clone 干净,git pull 不因
 *     脏工作区失败
 *
 * 隐私铁律不变:只上传 verdict / 版本号 / mtime,不读也不传任何会话内容。
 *
 * 用法(NAS,Node ≥22.6):
 *   node scripts/nas-probe.mjs              # 完整流程,crontab 用这个
 *   node scripts/nas-probe.mjs --dry-run    # 不上报、不写报告,其余照跑
 *   node scripts/nas-probe.mjs --skip-update # 跳过升级/会话,只检查+上报(调试用)
 *   PROBE_ENDPOINT=https://watch.logic-yjb.top PROBE_TOKEN=xxx node scripts/nas-probe.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ledgerFingerprint } from '../tools/upstream-watch/fingerprint.mjs'
import { shouldRetryUpload, uploadBackoffMs } from '../tools/upstream-watch/retry.mjs'
import { applyFreshness, scanLatestMtime } from '../tools/upstream-watch/nas-freshness.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..')
const HOME = os.homedir()
const NAS_STATE_DIR = process.env.NAS_PROBE_STATE_DIR ?? path.join(HOME, '.memorysql-nas')
const NAS_STATE = path.join(NAS_STATE_DIR, 'versions.json')
const REPORTS = process.env.NAS_REPORT_DIR ?? path.join(HOME, 'memorysql-nas-reports')
const LEDGER = path.join(REPO, 'upstream', 'ledger.json')

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const skipUpdate = argv.includes('--skip-update')
const endpoint = process.env.PROBE_ENDPOINT ?? ''
const token = process.env.PROBE_TOKEN ?? ''

function log(...a) {
  console.log(`[nas-probe] ${a.join(' ')}`)
}

// 同 dev 探针:TS 检查器要 node ≥22.6(strip-types),提前给明确提示
{
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 22 || (major === 22 && minor < 6)) {
    console.error(
      `[nas-probe] 需要 Node ≥22.6(当前 ${process.versions.node})。` +
        `NAS 上用 NodeSource 装 Node 22 LTS(见 tools/upstream-watch/DEPLOY.md)。`
    )
    process.exit(2)
  }
}

/**
 * NAS 侧看守的 agent 配置。
 *
 * dataRoots 不在这里维护 —— 从台账(ledger.json)的 localRoots 读,单一真相源,
 * 台账改了路径这里自动跟上。本表只管「怎么升级、怎么问版本、怎么逼一个会话」。
 *
 * npm 包名/bin 名已按 2026-10-25 npm registry 实查校准:
 *   qoder   = @qoder-ai/qodercli(bin qoder;CN 变体 @qodercn-ai/qoderclicn/bin qodercn)
 *   codebuddy = @tencent-ai/codebuddy-code(bin codebuddy/cbc)
 *   qwen    = @qwen-code/qwen-code(bin qwen)
 *   gemini  = @google/gemini-cli(bin gemini)
 *   kimicli = @moonshot-ai/kimi-code(bin kimi;⚠ npm 上无 scope 的 `kimi-code` 是
 *             第三方抢注的 Groq 代理工具,别装错 —— 台账 upstream.repo 记的
 *             MoonshotAI/kimi-code 是 GitHub 仓库,npm 包名带 @moonshot-ai scope)
 * 各家 -p 非交互参数与数据落盘位置在**部署时实测校准**:会话失败看报告的
 * 「会话失败」节,先用 `--version` / `--help` 核对 CLI 参数再改本表。
 */
const NAS_AGENTS = [
  {
    id: 'qoder',
    updateCmd: ['npm', 'install', '-g', '@qoder-ai/qodercli@latest'],
    versionCmd: ['qoder', '--version'],
    // -p = print 模式(Claude 系 CLI 惯例):跑一轮真会话写 JSONL,成功即退出
    sessionCmd: ['qoder', '-p', 'Reply with exactly: ok']
  },
  {
    id: 'codebuddy',
    updateCmd: ['npm', 'install', '-g', '@tencent-ai/codebuddy-code@latest'],
    versionCmd: ['codebuddy', '--version'],
    sessionCmd: ['codebuddy', '-p', 'Reply with exactly: ok']
  },
  {
    id: 'qwencode',
    updateCmd: ['npm', 'install', '-g', '@qwen-code/qwen-code@latest'],
    versionCmd: ['qwen', '--version'],
    sessionCmd: ['qwen', '-p', 'Reply with exactly: ok']
  },
  {
    id: 'gemini',
    updateCmd: ['npm', 'install', '-g', '@google/gemini-cli@latest'],
    versionCmd: ['gemini', '--version'],
    sessionCmd: ['gemini', '-p', 'Reply with exactly: ok']
  },
  {
    id: 'kimicli',
    updateCmd: ['npm', 'install', '-g', '@moonshot-ai/kimi-code@latest'],
    versionCmd: ['kimi', '--version'],
    sessionCmd: ['kimi', '-p', 'Reply with exactly: ok']
  }
]

function runStep(cmd, timeoutMs) {
  try {
    const out = execFileSync(cmd[0], cmd.slice(1), {
      encoding: 'utf-8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return { ok: true, out }
  } catch (e) {
    // 超时/非零退出/命令不存在都到这;只留第一行,报告里够定位即可
    return { ok: false, out: String(e?.message ?? e).split('\n')[0].slice(0, 200) }
  }
}

function firstLine(s) {
  return String(s ?? '').split('\n')[0].trim().slice(0, 80)
}

function loadNasState() {
  try {
    return JSON.parse(fs.readFileSync(NAS_STATE, 'utf-8'))
  } catch {
    return { versions: {}, lastRunAt: null, lastError: null }
  }
}

function saveNasState(st) {
  fs.mkdirSync(NAS_STATE_DIR, { recursive: true })
  const tmp = `${NAS_STATE}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2), 'utf-8')
  fs.renameSync(tmp, NAS_STATE)
}

/** 台账 → 每 agent 的数据根。被赞助的 agent 必须在台账里,否则跳过并记录 */
function dataRootsFromLedger() {
  const raw = JSON.parse(fs.readFileSync(LEDGER, 'utf-8'))
  const byId = new Map((raw.agents ?? []).map((a) => [a.id, a]))
  const roots = {}
  for (const a of NAS_AGENTS) {
    const entry = byId.get(a.id)
    if (!entry) {
      log(`⚠ 台账里没有 ${a.id},跳过(台账与 NAS_AGENTS 失同步?)`)
      continue
    }
    roots[a.id] = (entry.localRoots ?? []).filter((r) => typeof r === 'string')
  }
  return roots
}

/**
 * 步骤一:逐家「探测版本 → 升级 → 逼会话」。
 * 版本没变就不跑会话(省额度、省时间);版本变了才跑 —— 新会话的目的就是
 * 让新版本写下它的格式。单家任何失败都不中断其他家,失败进 sponsored[id] 的
 * error 字段,由 applyFreshness 把对应的 🟢 降级成 🟠(宁可黄也不假绿)。
 */
function updateAndSession(ledgerRoots, nasState) {
  const sponsored = {}
  for (const a of NAS_AGENTS) {
    if (!ledgerRoots[a.id]) continue
    const fact = { version: null, updatedAt: null, dataAt: null, versionError: null, sessionError: null }
    sponsored[a.id] = fact

    const v1 = runStep(a.versionCmd, 20_000)
    let version = v1.ok ? firstLine(v1.out) : null
    const prev = nasState.versions?.[a.id]

    if (skipUpdate) {
      // 调试路径:沿用持久化的版本元数据,不升级不跑会话
      fact.version = version ?? prev?.version ?? null
      fact.updatedAt = prev?.updatedAt ?? null
      fact.dataAt = scanLatestMtime(ledgerRoots[a.id], HOME)
      continue
    }

    // 版本探测失败不直接放弃:可能 CLI 坏了/被卸了,试着装回来
    if (!v1.ok) {
      const fix = runStep(a.updateCmd, 300_000)
      const v2 = runStep(a.versionCmd, 20_000)
      if (v2.ok) {
        version = firstLine(v2.out)
        log(`${a.id}: 版本探测失败后重装恢复 → ${version}`)
      } else {
        fact.versionError = v1.out
        log(`⚠ ${a.id}: 版本探测失败(${v1.out}),重装也未恢复(${fix.out})`)
        fact.dataAt = scanLatestMtime(ledgerRoots[a.id], HOME)
        continue
      }
    }

    const changed = !prev || (version && version !== prev.version)
    if (changed) {
      const upd = runStep(a.updateCmd, 300_000)
      if (!upd.ok) {
        fact.versionError = `升级失败: ${upd.out}`
        log(`⚠ ${a.id}: 升级失败(${upd.out})`)
        fact.dataAt = scanLatestMtime(ledgerRoots[a.id], HOME)
        continue
      }
      const v2 = runStep(a.versionCmd, 20_000)
      fact.version = v2.ok ? firstLine(v2.out) : version
      fact.updatedAt = new Date().toISOString()
      log(`${a.id}: ${prev?.version ?? '(首次)'} → ${fact.version},跑最小会话逼新格式…`)
      const sess = runStep(a.sessionCmd, 180_000)
      if (!sess.ok) {
        fact.sessionError = sess.out
        log(`⚠ ${a.id}: 最小会话失败(${sess.out})—— 若是登录过期,需人工重新登录`)
      }
    } else {
      fact.version = version
      fact.updatedAt = prev.updatedAt ?? null
      log(`${a.id}: 版本未变(${version}),跳过升级与会话`)
    }
    fact.dataAt = scanLatestMtime(ledgerRoots[a.id], HOME)
  }
  return sponsored
}

/** 跑黑盒检查,拿 JSON。子进程而非 import,与 dev 探针同款(工具与生产代码解耦) */
function runBlackbox() {
  const out = execFileSync(
    process.execPath,
    ['--experimental-strip-types', path.join(REPO, 'upstream', 'check.ts'), '--json'],
    { cwd: REPO, encoding: 'utf-8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  return JSON.parse(out)
}

/** Markdown 报告。写仓库外(NAS_REPORT_DIR),别弄脏 clone 的 git pull */
function renderReport(data, sponsored, downgraded) {
  const now = new Date()
  const day = now.toISOString().slice(0, 10)
  const L = []
  L.push(`# NAS 上游黑盒报告 · ${day}`)
  L.push('')
  L.push(`> 由 \`scripts/nas-probe.mjs\` 自动生成,勿手改。NAS 侧看守:闭源 + 开发机未装的 CLI。`)
  L.push(`> 判定:🟢 匹配 · 🔴 漂移 · 🟣 检查器故障 · 🟠 数据过期(不作为验证结论) · 🟡 未装`)
  L.push('')
  const results = data.results
  const drift = results.filter((r) => r.verdict === 'drift')
  const broken = results.filter((r) => r.verdict === 'checker_error')
  const stale = results.filter((r) => r.verdict === 'stale')
  const ok = results.filter((r) => r.verdict === 'ok')
  L.push(
    `**结论**:🟢 ${ok.length} · 🔴 ${drift.length} 漂移 · 🟣 ${broken.length} 检查器故障 · ` +
      `🟠 ${stale.length} 数据过期`
  )
  L.push('')
  if (downgraded.length) {
    L.push(`## 🟠 本轮降级(数据早于当前版本,别当已验证)`)
    L.push('')
    for (const id of downgraded) {
      const r = results.find((x) => x.id === id)
      L.push(`- **${id}**: ${r?.detail ?? ''}`)
    }
    L.push('')
  }
  if (drift.length) {
    L.push(`## ⚠ 需要适配发版`)
    L.push('')
    for (const r of drift) {
      L.push(`### ${r.id} (${r.name})`)
      L.push('')
      L.push(`- 结论:**上游格式漂移,现有适配器已读不懂**`)
      L.push(`- 源:\`${r.source}\``)
      L.push(`- 详情:${r.detail}`)
      L.push('')
    }
  }
  L.push(`## 全量明细`)
  L.push('')
  L.push(`| agent | 判定 | 版本 | 数据截至 | 详情 |`)
  L.push(`|---|---|---|---|---|`)
  const ICON = { ok: '🟢', drift: '🔴', checker_error: '🟣', absent: '🟡', blackbox_only: '⚪', stale: '🟠' }
  for (const r of results) {
    const s = sponsored[r.id]
    const detail = String(r.detail).replace(/\|/g, '\\|').slice(0, 100)
    L.push(
      `| ${r.id} | ${ICON[r.verdict] ?? r.verdict} ${r.verdict} | ${s?.version ?? '—'} | ` +
        `${r.dataAt ? String(r.dataAt).slice(0, 10) : '—'} | ${detail} |`
    )
  }
  L.push('')
  const sessFail = Object.entries(sponsored).filter(([, s]) => s.sessionError)
  if (sessFail.length) {
    L.push(`## ⚠ 会话失败(多半是登录过期,需人工 SSH 上 NAS 重登)`)
    L.push('')
    for (const [id, s] of sessFail) L.push(`- **${id}**: ${s.sessionError}`)
    L.push('')
  }
  L.push(`---`)
  L.push(`生成时间:${now.toLocaleString('zh-CN')} · 主机:${os.hostname()}`)
  return { day, text: L.join('\n') }
}

async function report(data) {
  if (!endpoint) {
    log('未设 PROBE_ENDPOINT,跳过云端上报')
    return
  }
  const url = /\/api\/probe\/?$/.test(endpoint)
    ? endpoint
    : endpoint.replace(/\/+$/, '') + '/api/probe'
  try {
    let hash = null
    try {
      hash = ledgerFingerprint(JSON.parse(fs.readFileSync(LEDGER, 'utf-8')))
    } catch (e) {
      log(`读不到台账,契约指纹留空: ${e?.message ?? e}`)
    }
    // source:'nas' —— 云端按 agent 合并两源(dev/nas),谁也不能整体覆盖谁
    const payload = { ...data, ledgerHash: hash, source: 'nas' }

    // 同 dev 探针:链路抖动按「重试是正常路径」处理
    const MAX_ATTEMPTS = 4
    let res = null
    let lastErr = null
    let lastWhy = ''
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {})
          },
          body: JSON.stringify(payload)
        })
        lastErr = null
      } catch (e) {
        res = null
        lastErr = e?.message ?? String(e)
      }
      const verdict = shouldRetryUpload(res?.status)
      lastWhy = verdict.why
      if (!verdict.retry) break
      if (attempt === MAX_ATTEMPTS) break
      const wait = uploadBackoffMs(attempt)
      log(`上报第 ${attempt} 次失败(${res ? `HTTP ${res.status}` : lastErr}),${wait / 1000}s 后重试`)
      await new Promise((r) => setTimeout(r, wait))
    }

    if (!res) {
      log(`云端上报失败(不影响本地报告):${lastErr}`)
      return
    }
    if (!res.ok) {
      log(`云端上报失败 HTTP ${res.status}(${url}) —— ${lastWhy}`)
      return
    }
    const ack = await res.json().catch(() => null)
    if (!ack || ack.ok !== true) {
      log(`云端未确认接收:响应不是预期 JSON(${url})`)
      return
    }
    log(`云端上报成功(source=${ack.source ?? 'nas'},已接收 ${ack.accepted} 条)`)
  } catch (e) {
    log(`云端上报失败(不影响本地报告):${e?.message ?? e}`)
  }
}

// ── 主流程 ───────────────────────────────────────────────────────────────────

// 台账/检查器跟随 main:NAS 的契约判定必须与看板服务端同源,否则指纹校验
// 会报「契约不一致」。失败不致命 —— 用本地版本继续,报告里可见。
{
  const pull = runStep(['git', '-C', REPO, 'pull', '--ff-only'], 120_000)
  log(pull.ok ? `git pull: ${firstLine(pull.out) || '已是最新'}` : `⚠ git pull 失败(${pull.out}),用本地版本继续`)
}

const nasState = loadNasState()
const ledgerRoots = dataRootsFromLedger()
const sponsored = updateAndSession(ledgerRoots, nasState)
nasState.versions = Object.fromEntries(
  Object.entries(sponsored).map(([id, s]) => [id, { version: s.version, updatedAt: s.updatedAt }])
)
nasState.lastRunAt = new Date().toISOString()

const blackbox = runBlackbox()
const { results, downgraded } = applyFreshness(blackbox.results, sponsored)
const data = { ...blackbox, results }

if (!dryRun) saveNasState({ ...nasState, lastError: null })

const rep = renderReport(data, sponsored, downgraded)
if (dryRun) {
  console.log('\n--- (dry-run,未写盘未上报) ---')
  console.log(rep.text)
} else {
  fs.mkdirSync(REPORTS, { recursive: true })
  const file = path.join(REPORTS, `${rep.day}.md`)
  fs.writeFileSync(file, rep.text, 'utf-8')
  log(`报告已写入 ${file}`)
  await report(data)
}

const drift = results.filter((r) => r.verdict === 'drift')
const stale = results.filter((r) => r.verdict === 'stale')
log(
  `完成:🔴 ${drift.length} 漂移 · 🟠 ${stale.length} 数据过期` +
    (drift.length ? ` —— 需适配发版` : '') +
    (stale.length ? ` —— 过期家需人工检查登录态` : '')
)
process.exit(drift.length ? 1 : 0)
