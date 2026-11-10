#!/usr/bin/env node
/**
 * NAS 闭源 agent 发现器(黑盒)。
 * ============================================================================
 * 目的:闭源 agent 没有公开 changelog、也没有可信的文档格式说明,**唯一的真相是它
 * 自己写出来的文件**。本脚本在 NAS 上做四件事:
 *
 *   1. 装(若 bin 不存在或 --install)
 *   2. 探版本 + 抓 --help 前若干行(记录非交互参数)
 *   3. 依次尝试若干「非交互跑一轮」的命令形态,直到某一个产出新文件
 *   4. **diff $HOME**:对比跑会话前后新增/修改的文件 → 这就是它的会话落盘位置
 *
 * 与 nas-probe.mjs 的分工:
 *   - nas-probe:对**已有适配器**的 agent 做版本漂移看守(台账驱动,上报云端)
 *   - nas-discover:对**尚未适配**的闭源 agent 做格式发现,产出报告给人看
 *
 * 用法(NAS 上):
 *   node scripts/nas-discover.mjs                 # 全部候选
 *   node scripts/nas-discover.mjs --only droid,copilot
 *   node scripts/nas-discover.mjs --install       # 强制重装
 *   node scripts/nas-discover.mjs --session-only  # 不装,只跑会话+diff
 *
 * 注意:会话命令按候选表依次尝试;登录类 CLI 首次会失败(未登录),但很多
 * CLI **未登录也会先落盘会话目录**(codebuddy 就是这样校准出来的)—— 报错不是
 * 失败,「有没有新文件」才是判据。
 */
import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = os.homedir()
const REPORT_DIR = path.join(HOME, 'memorysql-nas-reports')
const STATE = path.join(HOME, '.memorysql-nas', 'discover-state.json')

/** 闭源候选(开源的不在这里 —— 它们按上游源码/测试样本适配)。 */
const CANDIDATES = [
  {
    id: 'qoder',
    name: 'Qoder',
    install: 'npm install -g @qoder-ai/qodercli@latest',
    bin: 'qoder',
    versionCmd: ['qoder', '--version'],
    sessionCmds: [['qoder', '-p', 'Reply with exactly: ok']]
  },
  {
    id: 'codebuddy',
    name: 'CodeBuddy',
    install: 'npm install -g @tencent-ai/codebuddy-code@latest',
    bin: 'codebuddy',
    versionCmd: ['codebuddy', '--version'],
    sessionCmds: [['codebuddy', '-p', 'Reply with exactly: ok']]
  },
  {
    id: 'droid',
    name: 'Droid (Factory)',
    install: 'curl -fsSL https://app.factory.ai/cli | sh',
    bin: 'droid',
    versionCmd: ['droid', '--version'],
    sessionCmds: [
      ['droid', 'exec', 'Reply with exactly: ok'],
      ['droid', '-p', 'Reply with exactly: ok'],
      ['droid', 'run', 'Reply with exactly: ok']
    ]
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot CLI',
    install: 'npm install -g @github/copilot@latest',
    bin: 'copilot',
    versionCmd: ['copilot', '--version'],
    sessionCmds: [
      ['copilot', '-p', 'Reply with exactly: ok'],
      ['copilot', '--prompt', 'Reply with exactly: ok'],
      ['copilot', 'exec', 'Reply with exactly: ok']
    ]
  },
  {
    id: 'commandcode',
    name: 'Command Code',
    install: 'npm install -g command-code@latest',
    bin: 'cmd',
    versionCmd: ['cmd', '--version'],
    sessionCmds: [
      ['cmd', '-p', 'Reply with exactly: ok'],
      ['cmd', 'exec', 'Reply with exactly: ok'],
      ['command-code', '-p', 'Reply with exactly: ok']
    ]
  },
  {
    id: 'muse',
    name: 'Muse Code (Meta)',
    install: 'curl -fsSL https://dev.meta.ai/install.sh | bash',
    bin: 'muse',
    versionCmd: ['muse', '--version'],
    sessionCmds: [
      ['muse', '-p', 'Reply with exactly: ok'],
      ['muse', 'exec', 'Reply with exactly: ok'],
      ['muse', 'run', 'Reply with exactly: ok']
    ]
  },
  {
    id: 'devin',
    name: 'Devin (Cognition)',
    // 官方安装脚本地址随文档变化,这里只探测已知的两个;都没有则记 skipped
    install: 'curl -fsSL https://cli.devin.ai/install.sh | bash',
    bin: 'devin',
    versionCmd: ['devin', '--version'],
    sessionCmds: [
      ['devin', '-p', 'Reply with exactly: ok'],
      ['devin', 'exec', 'Reply with exactly: ok']
    ]
  }
]

/** 明确不装的理由(写进报告,避免以后重复踩) */
const UNSUPPORTED = {
  deveco: 'npm @deveco/deveco-code 只带 macOS/Windows 二进制,Linux 无产物(magpie cliupdate.go 原文)',
  workbuddy: '无 npm 包、官方只发桌面/CLI 安装器,Linux 无渠道',
  antigravity: 'Antigravity 桌面版会话正文加密;agy CLI 无公开 Linux 安装渠道',
  stepcode: 'npm 上无官方包(stepcode/stepfun 命名均为抢注),无公开安装渠道',
  alma: '桌面 app(Electron),无 Linux CLI',
  aside: '桌面 app,无公开 Linux 安装渠道',
  reasonix: 'Studio 桌面 app + CLI 共配置,Linux 渠道未确认',
  ante: 'antigma.ai 闭源,Linux 渠道未确认(仅 mac 安装器见文档)',
  kirocrew: 'Kiro Crew 需要底层 harness(kiro-cli/codex/...)且需账号登录,先不做'
}

function runSteps(cmd, timeoutMs = 240_000) {
  const started = Date.now()
  try {
    const out = execSync(cmd, {
      encoding: 'utf-8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1', NO_COLOR: '1', TERM: 'dumb' }
    })
    return { ok: true, out: String(out), ms: Date.now() - started }
  } catch (e) {
    const out = `${e?.stdout ?? ''}${e?.stderr ?? ''}${e?.message ?? ''}`
    return { ok: false, out, ms: Date.now() - started }
  }
}

function hasBin(bin) {
  try {
    execFileSync('which', [bin], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.npm',
  '.cache',
  '.nvm',
  '.local/share/npm',
  '.local/lib',
  '.git',
  '.config/nvim',
  'go',
  '.rustup',
  '.cargo'
])

/**
 * 扫描 $HOME 下 mtime >= sinceMs 的文件(深度受限,跳过体积大且无关的目录)。
 * 返回 [{path, size, mtime}] —— 会话文件通常几十 KB,天然排在前面。
 */
function scanRecent(sinceMs, maxDepth = 5) {
  const out = []
  const walk = (dir, depth) => {
    if (depth > maxDepth) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      const rel = path.relative(HOME, p)
      if (SKIP_DIRS.has(rel) || SKIP_DIRS.has(e.name)) continue
      if (e.isSymbolicLink()) continue
      try {
        if (e.isDirectory()) {
          walk(p, depth + 1)
        } else if (e.isFile()) {
          const st = fs.statSync(p)
          if (st.mtimeMs >= sinceMs && st.size > 0) out.push({ path: p, size: st.size, mtime: st.mtimeMs })
        }
      } catch {
        /* 权限/竞态:忽略 */
      }
    }
  }
  walk(HOME, 0)
  return out.sort((a, b) => b.mtime - a.mtime)
}

/** 把新文件按「所属顶层目录」聚合,便于一眼看出各家落在哪 */
function groupByTop(files) {
  const groups = new Map()
  for (const f of files) {
    const rel = path.relative(HOME, f.path)
    const top = rel.split(path.sep).slice(0, 2).join('/')
    if (!groups.has(top)) groups.set(top, [])
    groups.get(top).push(f)
  }
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length)
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf-8'))
  } catch {
    return { runs: {} }
  }
}
function saveState(s) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true })
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2), 'utf-8')
}

const args = process.argv.slice(2)
const onlyArg = args.includes('--only') ? args[args.indexOf('--only') + 1] : ''
const only = onlyArg ? new Set(onlyArg.split(',').map((s) => s.trim())) : null
const forceInstall = args.includes('--install')
const sessionOnly = args.includes('--session-only')

const results = []
for (const c of CANDIDATES) {
  if (only && !only.has(c.id)) continue
  const r = { id: c.id, name: c.name, installed: false, version: null, help: '', session: null, newFiles: [] }
  console.log(`\n══════ ${c.name} (${c.id})`)

  // 1) 安装
  if (!sessionOnly && (forceInstall || !hasBin(c.bin))) {
    console.log(`  安装: ${c.install}`)
    const inst = runSteps(c.install, 300_000)
    console.log(`  → ${inst.ok ? 'ok' : 'failed'} (${inst.ms}ms)`)
    if (!inst.ok) r.installError = inst.out.split('\n').slice(-4).join(' | ').slice(0, 400)
  }
  r.installed = hasBin(c.bin)
  if (!r.installed) {
    r.session = { ok: false, detail: 'bin 不存在(安装失败或无 Linux 产物)' }
    results.push(r)
    console.log('  ✗ 未安装成功,跳过会话')
    continue
  }

  // 2) 版本 + help(非交互参数形态)
  const v = runSteps(c.versionCmd.join(' '), 30_000)
  r.version = v.ok ? v.out.split('\n')[0].trim().slice(0, 80) : null
  const h = runSteps(`${c.bin} --help`, 20_000)
  r.help = h.out.split('\n').slice(0, 40).join('\n')
  console.log(`  版本: ${r.version ?? '(取不到)'}`)

  // 3) 依次尝试会话命令,首个「产生新文件」的形态胜出
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `msql-disc-${c.id}-`))
  for (const cmd of c.sessionCmds) {
    const since = Date.now() - 2000
    const run = (() => {
      try {
        const out = execFileSync(cmd[0], cmd.slice(1), {
          cwd: sandbox,
          encoding: 'utf-8',
          timeout: 180_000,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, CI: '1', NO_COLOR: '1', TERM: 'dumb' }
        })
        return { ok: true, out: String(out) }
      } catch (e) {
        return { ok: false, out: `${e?.stdout ?? ''}${e?.stderr ?? ''}${e?.message ?? ''}` }
      }
    })()
    const fresh = scanRecent(since)
    console.log(`  试: ${cmd.join(' ').slice(0, 70)} → ${run.ok ? 'exit 0' : 'exit≠0'}, 新增 ${fresh.length} 文件`)
    r.session = {
      cmd: cmd.join(' '),
      ok: run.ok,
      output: run.out.split('\n').filter(Boolean).slice(0, 6).join(' | ').slice(0, 400),
      newFileCount: fresh.length
    }
    if (fresh.length > 0) {
      r.newFiles = fresh.slice(0, 60)
      break
    }
    // 没有任何新文件且命令失败 → 继续试下一种形态;成功但没文件 → 也继续
  }
  fs.rmSync(sandbox, { recursive: true, force: true })

  if (r.newFiles.length === 0) {
    // 兜底:再扫一遍最近 3 分钟(某些 CLI 写盘延迟/走后台)
    r.newFiles = scanRecent(Date.now() - 180_000).slice(0, 60)
  }
  results.push(r)
  console.log(`  → 落盘位置: ${r.newFiles.length ? groupByTop(r.newFiles).map(([k]) => k).join(', ') : '未发现'}`)
}

// ── 报告 ──────────────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
fs.mkdirSync(REPORT_DIR, { recursive: true })
const jsonPath = path.join(REPORT_DIR, `discover-${stamp}.json`)
fs.writeFileSync(jsonPath, JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2), 'utf-8')

const lines = [
  `# 闭源 agent 发现报告 · ${new Date().toISOString().slice(0, 10)}`,
  '',
  '> 由 `scripts/nas-discover.mjs` 在 NAS 上生成。判据是「跑完会话后 HOME 里新增了什么文件」——',
  '> 未登录导致的报错不算失败,很多 CLI 会先落盘再报认证错误。',
  ''
]
for (const r of results) {
  lines.push(`## ${r.name} (${r.id})`, '')
  lines.push(`- 安装: ${r.installed ? '✓' : '✗'}${r.version ? ` · 版本 ${r.version}` : ''}`)
  if (r.installError) lines.push(`- 安装错误: \`${r.installError}\``)
  if (r.session) lines.push(`- 会话命令: \`${r.session.cmd ?? '-'}\` → ${r.session.ok ? 'exit 0' : 'exit≠0'}${r.session.output ? ` · ${r.session.output}` : ''}`)
  if (r.newFiles?.length) {
    lines.push('', '| 新增文件 | 大小 |', '|---|---|')
    for (const f of groupByTop(r.newFiles).flatMap(([, fs2]) => fs2).slice(0, 25)) {
      lines.push(`| \`${path.relative(HOME, f.path)}\` | ${(f.size / 1024).toFixed(1)} KB |`)
    }
  } else {
    lines.push('- 落盘: **未发现新文件**')
  }
  lines.push('')
}
lines.push('## 明确不装(记录理由)', '')
for (const [k, why] of Object.entries(UNSUPPORTED)) lines.push(`- **${k}**: ${why}`)
const mdPath = path.join(REPORT_DIR, `discover-${stamp}.md`)
fs.writeFileSync(mdPath, lines.join('\n') + '\n', 'utf-8')

const st = loadState()
st.runs = st.runs ?? {}
st.runs[stamp] = Object.fromEntries(results.map((r) => [r.id, { installed: r.installed, version: r.version, files: r.newFiles?.length ?? 0 }]))
saveState(st)

console.log(`\n报告: ${mdPath}`)
console.log(`JSON: ${jsonPath}`)
for (const r of results) console.log(`  ${r.id.padEnd(12)} ${r.installed ? 'installed' : 'missing  '} files=${(r.newFiles?.length ?? 0).toString().padStart(3)}`)
