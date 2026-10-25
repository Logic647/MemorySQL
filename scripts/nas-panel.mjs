/**
 * NAS 黑盒探针面板 —— 浏览器里的「统一登录 + 上报情况监测」
 * ============================================================================
 * 解决两个 SSH 痛点(2026-10-25 用户提出,在 NAS 上做聚合平台):
 *   1. 五家 CLI 逐家 SSH 敲 login 命令、在终端里找 URL/扫码 —— 面板上一键发起,
 *      输出(URL/ASCII 二维码)流式显示在网页里,手机打开也能扫
 *   2. 想知道「上报到云端成没成 / 哪家登录过期了」要翻日志 —— 面板直接读
 *      ~/.memorysql-nas/versions.json 的 lastRun(nas-probe 每轮落盘)并展示
 *
 * 安全边界(刻意收敛):
 *   - 只 spawn 本文件 LOGIN_TARGETS 白名单表内的命令,POST body 的 id 必须
 *     命中表项 —— 不接受任意命令,面板不是 web shell
 *   - 默认绑 0.0.0.0 家庭内网(与 NAS 上 ollama/nas-admin 同 posture);
 *     设 PANEL_TOKEN 则启用鉴权(Bearer/?token=,同看板)。**别把它端口映射到公网**
 *   - 每个进程输出缓冲上限 256KB,防内存膨胀;进程表只留最近 20 个
 *
 * 用法(NAS,Node ≥22):
 *   node scripts/nas-panel.mjs                 # 默认 0.0.0.0:8789
 *   PANEL_PORT=8790 PANEL_TOKEN=xxx node ...   # 可选
 * 常驻:见 scripts/nas-panel.service(systemd,%h 展开为 User 的 home)
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..')
const HOME = os.homedir()
const NAS_DIR = process.env.NAS_PROBE_STATE_DIR ?? path.join(HOME, '.memorysql-nas')
const NAS_STATE = path.join(NAS_DIR, 'versions.json')
const PROBE_ENV = path.join(NAS_DIR, 'probe.env')
const REPORTS = process.env.NAS_REPORT_DIR ?? path.join(HOME, 'memorysql-nas-reports')
const PORT = Number(process.env.PANEL_PORT ?? 8789)
const BIND = process.env.PANEL_BIND ?? '0.0.0.0'
const TOKEN = process.env.PANEL_TOKEN ?? ''
const NODE_BIN = process.execPath

/** 每进程输出缓冲上限(字符)—— 登录输出含 ASCII 二维码,几 KB 级,256KB 绰绰有余 */
const BUF_CAP = 256 * 1024

/**
 * 登录命令表 —— 与 nas-probe.mjs 的 NAS_AGENTS 同族:表驱动、部署时实测校准。
 * qoder 的 login 子命令经官方文档确认;codebuddy 免登录但保留入口;kimi/qwen/gemini
 * 的非交互登录形态待首次使用时看输出校准(跑了不对,改这张表即可)。
 * sshFallback:CLI 坚持要 TUI 时给用户的手动命令。
 */
const LOGIN_TARGETS = [
  { id: 'qoder', label: 'Qoder', loginCmd: ['qoder', 'login'], sshFallback: 'qoder login' },
  { id: 'codebuddy', label: 'CodeBuddy', loginCmd: ['codebuddy', 'login'], sshFallback: 'codebuddy login(当前免登录可用)' },
  { id: 'qwencode', label: 'Qwen Code', loginCmd: ['qwen', 'login'], sshFallback: 'ssh nas 后运行 qwen 按引导认证' },
  { id: 'gemini', label: 'Gemini CLI', loginCmd: ['gemini', 'login'], sshFallback: 'ssh nas 后运行 gemini 按引导认证' },
  { id: 'kimicli', label: 'Kimi Code', loginCmd: ['kimi', 'login'], sshFallback: 'ssh nas 后运行 kimi 按引导认证' }
]

/**
 * 解析 probe.env 形式的 KEY=VALUE 文件(忽略注释/空行;值不剥引号——探针 env
 * 文件里没有引号形态)。行内注释按 bash source 语义剥:` #` 之后视为注释
 * (踩过:env 里留了一行 `KEY=v  # 说明`,注释被原样当值带到面板上)。
 * 导出供测试;面板用它把上报凭据注入探针子进程,凭据只经内存,面板不回显。
 */
export function parseEnvFile(text) {
  const out = {}
  for (const line of String(text ?? '').split('\n')) {
    let t = line.trim()
    if (!t || t.startsWith('#')) continue
    const hash = t.indexOf(' #')
    if (hash > 0) t = t.slice(0, hash).trim()
    const i = t.indexOf('=')
    if (i <= 0) continue
    out[t.slice(0, i)] = t.slice(i + 1)
  }
  return out
}

/** id → 登录表项;不命中返回 null(POST 只经这里校验,白名单的唯一入口) */
export function findLoginTarget(id) {
  return LOGIN_TARGETS.find((t) => t.id === id) ?? null
}

/** 读面板状态:versions.json 的 lastRun + 报告文件列表。坏/缺文件都给空态,不抛 */
export function loadPanelState() {
  let lastRun = null
  try {
    lastRun = JSON.parse(fs.readFileSync(NAS_STATE, 'utf-8')).lastRun ?? null
  } catch {
    /* 首次运行前文件不存在 */
  }
  let reports = []
  try {
    reports = fs
      .readdirSync(REPORTS)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .reverse()
      .slice(0, 7)
  } catch {
    /* 目录还没建 */
  }
  let endpoint = ''
  try {
    endpoint = parseEnvFile(fs.readFileSync(PROBE_ENV, 'utf-8')).PROBE_ENDPOINT ?? ''
  } catch {
    /* env 文件不存在 */
  }
  return { lastRun, reports, endpoint }
}

// ── 子进程管理(登录/探针共用) ─────────────────────────────────────────────
const procs = new Map() // key -> { child, buf, done, exitCode, startedAt, cmd }

function startProc(key, cmd, env, cwd) {
  if (procs.has(key) && !procs.get(key).done) return { started: false, why: 'already-running' }
  const child = spawn(cmd[0], cmd.slice(1), {
    env: { ...process.env, ...env },
    cwd: cwd ?? HOME,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const rec = { child, buf: '', done: false, exitCode: null, startedAt: new Date().toISOString(), cmd }
  const push = (d) => {
    rec.buf += d.toString('utf-8')
    if (rec.buf.length > BUF_CAP) rec.buf = rec.buf.slice(-BUF_CAP)
  }
  child.stdout.on('data', push)
  child.stderr.on('data', push)
  child.on('exit', (code) => {
    rec.done = true
    rec.exitCode = code
    // 完成的进程保留 30 分钟供轮询,然后清掉;表满 20 个先丢最旧
    setTimeout(() => procs.delete(key), 30 * 60_000).unref()
  })
  procs.set(key, rec)
  // 简单的表容量控制
  if (procs.size > 20) {
    const oldest = [...procs.entries()].sort((a, b) => String(a[1].startedAt).localeCompare(String(b[1].startedAt)))[0]
    if (oldest && oldest[1].done) procs.delete(oldest[0])
  }
  return { started: true }
}

function procView(key) {
  const rec = procs.get(key)
  if (!rec) return null
  return { running: !rec.done, done: rec.done, exitCode: rec.exitCode, startedAt: rec.startedAt, out: rec.buf }
}

// ── HTTP ────────────────────────────────────────────────────────────────────
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = ''
    req.on('data', (c) => {
      b += c
      if (b.length > 4096) req.destroy() // 防垃圾大包
    })
    req.on('end', () => resolve(b))
    req.on('error', () => resolve(b))
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')

  // 鉴权(可选):设了 PANEL_TOKEN 才启用,与看板同一套 Bearer/?token= 形态
  if (TOKEN) {
    const h = req.headers.authorization ?? ''
    const q = url.searchParams.get('token') ?? ''
    if (h !== `Bearer ${TOKEN}` && q !== TOKEN) return json(res, 401, { error: 'unauthorized' })
  }

  if (url.pathname === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end(PAGE)
  }

  if (url.pathname === '/api/state' && req.method === 'GET') {
    const running = [...procs.entries()].filter(([, r]) => !r.done).map(([k]) => k)
    return json(res, 200, { ...loadPanelState(), targets: LOGIN_TARGETS, running, port: PORT })
  }

  // 发起某家 CLI 登录:只跑白名单命令,输出进缓冲供前端轮询
  if (url.pathname === '/api/login' && req.method === 'POST') {
    let id = ''
    try {
      id = String(JSON.parse((await readBody(req)) || '{}').id ?? '')
    } catch {
      return json(res, 400, { error: 'bad json' })
    }
    const t = findLoginTarget(id)
    if (!t) return json(res, 400, { error: 'unknown target' })
    const r = startProc(`login:${t.id}`, t.loginCmd, {}, HOME)
    return json(res, r.started ? 202 : 409, r.started ? { started: true, key: `login:${t.id}` } : { error: r.why })
  }

  // 手动跑一轮探针(完整流程,同 cron;凭据从 probe.env 注入,不回显)
  if (url.pathname === '/api/probe' && req.method === 'POST') {
    let env = {}
    try {
      env = parseEnvFile(fs.readFileSync(PROBE_ENV, 'utf-8'))
    } catch {
      /* 无 env 也能跑(只是不上报) */
    }
    const r = startProc('probe', [NODE_BIN, path.join(REPO, 'scripts', 'nas-probe.mjs')], env, REPO)
    return json(res, r.started ? 202 : 409, r.started ? { started: true, key: 'probe' } : { error: r.why })
  }

  // 轮询进程输出(登录/探针共用)
  if (url.pathname === '/api/proc' && req.method === 'GET') {
    const key = url.searchParams.get('key') ?? ''
    if (!/^(login:[a-z]+|probe)$/.test(key)) return json(res, 400, { error: 'bad key' })
    const v = procView(key)
    return json(res, 200, v ?? { running: false, done: null, exitCode: null, startedAt: null, out: '' })
  }

  // 报告正文(文件名白名单:必须是 REPORTS 下的 .md 基名,防路径穿越)
  if (url.pathname === '/api/report' && req.method === 'GET') {
    const f = url.searchParams.get('file') ?? ''
    if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(f)) return json(res, 400, { error: 'bad file' })
    const p = path.join(REPORTS, f)
    if (!fs.existsSync(p)) return json(res, 404, { error: 'not found' })
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end(fs.readFileSync(p, 'utf-8'))
  }

  res.writeHead(404)
  res.end('not found')
})

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))
if (isMain) {
  server.listen(PORT, BIND, () => {
    // 打实际端口而不是 PORT 变量:PORT=0(系统分配)时打变量会输出一个
    // 谁也连不上的地址,而日志看起来完全正常 —— 与看板 server.mjs 同一条教训
    const actual = server.address()?.port ?? PORT
    console.log(`NAS 探针面板 → http://${BIND}:${actual}`)
    console.log(`状态: ${NAS_STATE} · 报告: ${REPORTS}`)
    console.log(TOKEN ? '鉴权: 已启用(Bearer / ?token=)' : '鉴权: 未设 PANEL_TOKEN(仅内网使用,勿映射公网)')
  })
}

// ── 页面(内联,与云端看板同一套浅色主题) ───────────────────────────────────
const PAGE = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>NAS 黑盒探针面板</title>
<style>
:root{--bg:#f7f8fa;--surface:#fff;--surface-2:#fafbfc;--border:#e4e7ec;--border-strong:#d0d5dd;
--fg:#1a202c;--fg-2:#475467;--fg-3:#8a94a6;--accent:#2563eb;--accent-soft:#eff4ff;
--high:#d92d20;--high-soft:#fef3f2;--med:#b54708;--med-soft:#fffaeb;--ok:#067647;--ok-soft:#ecfdf3;
--shadow:0 1px 2px rgba(16,24,40,.05),0 1px 3px rgba(16,24,40,.06);--radius:10px;
--mono:'JetBrains Mono','Cascadia Code',Consolas,monospace}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif;
padding:24px 24px 60px;max-width:1100px;margin-inline:auto}
h1{font-size:19px;font-weight:650;margin:0 0 3px}
.sub{color:var(--fg-3);font-size:13px;margin-bottom:18px}
.sub b{color:var(--fg-2);font-weight:600}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:10px;margin-bottom:18px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);padding:13px 16px}
.card .nm{font-weight:650;font-size:14px;display:flex;align-items:center;gap:8px}
.card .row{display:flex;gap:7px;align-items:baseline;margin-top:5px;font-size:12px}
.card .k{color:var(--fg-3);width:56px;flex:none}
.card .v{color:var(--fg-2);font-variant-numeric:tabular-nums;word-break:break-all}
.dot{width:9px;height:9px;border-radius:50%;flex:none;display:inline-block}
.dot.ok{background:#12b76a}.dot.bad{background:var(--high)}.dot.unknown{background:#c7cdd6}
.badge{font-size:11px;font-weight:600;padding:2px 8px;border-radius:5px;border:1px solid transparent;white-space:nowrap}
.b-ok{color:var(--ok);background:var(--ok-soft);border-color:#abefc6}
.b-high{color:var(--high);background:var(--high-soft);border-color:#fecdca}
.b-medium{color:var(--med);background:var(--med-soft);border-color:#fedf89}
.b-none{color:var(--fg-3);background:var(--surface-2);border-color:var(--border)}
.b-bb{color:#667085;background:var(--surface-2);border-color:var(--border-strong)}
.b-checker{color:#6941c6;background:#f4f3ff;border-color:#d9d6fe}
button{font:inherit;font-size:12.5px;font-weight:550;cursor:pointer;border:1px solid var(--border-strong);
background:var(--surface);color:var(--fg-2);padding:6px 13px;border-radius:8px;transition:.14s}
button:hover:not(:disabled){border-color:var(--accent);color:var(--accent);background:var(--accent-soft)}
button:disabled{opacity:.55;cursor:not-allowed}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button.primary:hover:not(:disabled){background:#1d4ed8;color:#fff}
.actions{display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap}
.hint{color:var(--fg-3);font-size:11.5px}
pre.term{background:#0f172a;color:#d5dae2;border-radius:8px;padding:12px 14px;font:11.5px/1.5 var(--mono);
overflow:auto;max-height:320px;white-space:pre-wrap;word-break:break-all;margin:10px 0 0}
.term .dim{color:#64748b}
.sect{font-weight:650;font-size:14px;margin:22px 0 10px}
.rep{display:flex;gap:10px;flex-wrap:wrap;font-size:12.5px}
.rep a{font-family:var(--mono);font-size:12px}
@media (max-width:720px){body{padding:16px 14px 48px}}
</style>
</head>
<body>
<h1>NAS 黑盒探针面板</h1>
<div class="sub" id="sub">加载中…</div>

<div class="sect">五家 CLI · 登录态与判定</div>
<div class="grid" id="agents"></div>

<div class="sect">探针</div>
<div class="card">
  <div class="actions">
    <button class="primary" id="runProbe">跑一轮探针(升级→会话→检查→上报)</button>
    <span class="hint" id="probeHint">与每日 10:37 的 cron 同一条链路</span>
  </div>
  <pre class="term" id="probeOut" style="display:none"></pre>
</div>

<div class="sect">历史报告</div>
<div class="rep" id="reports"></div>

<script>
const $ = (s) => document.querySelector(s);
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const VERDICT = { ok:['b-ok','🟢 匹配'], drift:['b-high','🔴 漂移'], checker_error:['b-checker','🟣 检查器故障'],
  stale:['b-medium','🟠 数据过期'], absent:['b-none','🟡 本机未装'], blackbox_only:['b-bb','⚪ 仅黑盒'] };
const pollers = {};

async function api(p, opts) { const r = await fetch(p, opts); if (!r.ok && r.status !== 409) throw new Error(p + ' ' + r.status); return r; }

function sessionDot(ok) {
  if (ok === true) return '<span class="dot ok" title="最近一轮最小会话成功"></span>登录有效';
  if (ok === false) return '<span class="dot bad" title="最小会话失败,多半登录过期"></span>疑似过期';
  return '<span class="dot unknown" title="本轮版本未变没跑会话,无新信号"></span>未测';
}

function renderAgents(st) {
  const last = st.lastRun;
  $('#agents').innerHTML = st.targets.map(t => {
    const a = last?.agents?.[t.id] ?? {};
    const [cls, label] = VERDICT[a.verdict] ?? ['b-none', a.verdict ?? '未上报'];
    return '<div class="card">' +
      '<div class="nm">' + esc(t.label) + ' <span class="badge ' + cls + '">' + label + '</span></div>' +
      '<div class="row"><span class="k">版本</span><span class="v">' + esc(a.version ?? '—') + '</span></div>' +
      '<div class="row"><span class="k">登录</span><span class="v">' + sessionDot(a.sessionOk) + (a.sessionAt ? ' · ' + esc(String(a.sessionAt).slice(5, 10)) : '') + '</span></div>' +
      '<div class="row"><span class="k">数据</span><span class="v">' + (a.dataAt ? esc(String(a.dataAt).slice(0, 10)) : '—') + '</span></div>' +
      '<div class="actions"><button onclick="startLogin(\\'' + t.id + '\\')">发起登录</button>' +
      '<span class="hint">不行就 SSH:' + esc(t.sshFallback) + '</span></div>' +
      '<pre class="term" id="out-' + t.id + '" style="display:none"></pre>' +
      '</div>';
  }).join('');
}

function renderSub(st) {
  const up = st.lastRun?.upload;
  const bits = [];
  if (st.lastRun?.at) bits.push('上轮探针 <b>' + esc(String(st.lastRun.at).slice(0, 16).replace('T',' ')) + '</b>');
  if (up) bits.push('云端上报 ' + (up.ok ? '<b style="color:var(--ok)">成功</b>' : '<b style="color:var(--high)">失败</b>(' + esc(up.error ?? '') + ')'));
  else bits.push('尚未上报过云端');
  if (st.endpoint) bits.push('看板 <a href="' + esc(st.endpoint) + '/probe" target="_blank" rel="noreferrer">' + esc(st.endpoint) + '/probe</a>');
  $('#sub').innerHTML = bits.join(' · ') || '尚无探针数据 —— 点下方「跑一轮探针」';
  $('#reports').innerHTML = st.reports.length
    ? st.reports.map(f => '<a href="#" onclick="showReport(\\'' + f + '\\');return false">' + f + '</a>').join(' · ')
    : '<span class="hint">还没有报告</span>';
}

async function showReport(f) {
  const t = await fetch('/api/report?file=' + encodeURIComponent(f)).then(r => r.text());
  const el = $('#probeOut');
  el.style.display = 'block';
  el.textContent = t;
  $('#probeHint').textContent = '报告 ' + f;
}

function poll(key, el) {
  clearInterval(pollers[key]);
  el.style.display = 'block';
  pollers[key] = setInterval(async () => {
    const v = await fetch('/api/proc?key=' + encodeURIComponent(key)).then(r => r.json()).catch(() => null);
    if (!v) return;
    el.textContent = v.out || '(等待输出…)';
    el.scrollTop = el.scrollHeight;
    if (v.done) {
      clearInterval(pollers[key]);
      const line = '\\n=== 进程结束,退出码 ' + v.exitCode + ' ' + (v.exitCode === 0 ? '✅' : '—— 登录失败/被拒,看上面输出') + ' ===';
      el.textContent += line;
      if (key === 'probe') { $('#runProbe').disabled = false; load(); }
      else load();
    }
  }, 1000);
}

window.startLogin = async (id) => {
  const r = await api('/api/login', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id }) });
  if (r.status === 409) { alert('该 CLI 的登录已在进行中'); return; }
  poll('login:' + id, document.getElementById('out-' + id));
};

$('#runProbe').onclick = async () => {
  const r = await api('/api/probe', { method: 'POST' });
  if (r.status === 409) { /* 已在跑,直接开始看输出 */ }
  $('#runProbe').disabled = true;
  $('#probeHint').textContent = '探针运行中(完整流程可能要几分钟:升级+会话每家最长 5 分钟)…';
  poll('probe', $('#probeOut'));
};

async function load() {
  let st;
  try { st = await fetch('/api/state').then(r => r.json()); }
  catch (e) { $('#sub').textContent = '加载失败:' + e.message; return; }
  renderAgents(st);
  renderSub(st);
  if (st.running?.includes('probe')) { $('#runProbe').disabled = true; poll('probe', $('#probeOut')); }
}

load();
setInterval(load, 30000);
</script>
</body>
</html>`
