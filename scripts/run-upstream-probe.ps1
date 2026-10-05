<#
.SYNOPSIS
  每日跑一次黑盒探针并上报云端看板。

.DESCRIPTION
  看板的价值取决于**黑盒那一栏**。白盒(抓上游 changelog)云端自己就能做,
  但"本机装的那些 agent 的数据现在还读不读得懂"只有本机知道 ——
  而"漂移"的判断会直接决定要不要发一个适配版本。

  手动跑探针意味着:某天上游改了格式,可能几个月都没人发现,
  期间用户的捕获一直是坏的。**这正是建这套东西要解决的"静默失效"。**
  所以它必须自己跑。

  token 写在同目录的 upstream-probe.env(已 gitignore,ACL 只留当前用户),
  不写进本文件、不走命令行 —— 命令行参数会出现在任务历史和进程列表里。
  2026-10-05 起云端对写端点要求真 token(此前 nginx 对所有路径注入,
  等于写端点对任何拿到网址的人敞开),所以这个 token 是必需的。

.NOTES
  调用方式: powershell -ExecutionPolicy Bypass -File scripts\run-upstream-probe.ps1
#>
$ErrorActionPreference = 'Continue'

# ── 输出编码:必须在调用 node **之前**设好 ──
# node 往 stdout 写 UTF-8,而 Windows PowerShell 5.1 默认用
# [Console]::OutputEncoding(本机是 GBK)解码管道结果。后果是 $out 里的中文全是乱码,
# 于是 `$out -match '云端上报成功'` 永远为假 —— **成功会被报成失败**。
# 实测踩过:输出里明明有「云端上报成功」,脚本却记了 ⚠。
# 任务计划里跑时没有交互式控制台,这个设置尤其必要。
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repo
$logFile = Join-Path $repo 'upstream-probe.log'

function Write-Log([string]$msg) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  # 用 .NET API 追加并显式给编码,不用 Add-Content -Encoding UTF8(它会写 BOM)
  [System.IO.File]::AppendAllText($logFile, $line + "`r`n", $utf8NoBom)
  Write-Output $line
}

# ── 1. 环境变量从 env 文件读 ──
$envFile = Join-Path $PSScriptRoot 'upstream-probe.env'
if (-not (Test-Path $envFile)) {
  Write-Log "缺少 $envFile —— 请先创建并填入 PROBE_ENDPOINT 与 PROBE_TOKEN"
  exit 2
}
foreach ($line in [System.IO.File]::ReadAllLines($envFile, $utf8NoBom)) {
  $t = $line.Trim()
  if (-not $t -or $t.StartsWith('#')) { continue }
  $i = $t.IndexOf('=')
  if ($i -lt 1) { continue }
  $k = $t.Substring(0, $i).Trim()
  $v = $t.Substring($i + 1).Trim().Trim('"').Trim("'")
  [Environment]::SetEnvironmentVariable($k, $v, 'Process')
}

if (-not $env:PROBE_ENDPOINT) { Write-Log 'PROBE_ENDPOINT 为空'; exit 2 }
if (-not $env:PROBE_TOKEN)   { Write-Log 'PROBE_TOKEN 为空'; exit 2 }

# ── 2. 确认 Node 够新(探针要执行 TS 检查器,需 ≥22.6)──
try {
  $v = ((& node -v) 2>$null) -replace '^v', ''
  if (-not $v) { throw 'node 无输出' }
  $parts = $v.Split('.') | ForEach-Object { [int]$_ }
  if ($parts[0] -lt 22 -or ($parts[0] -eq 22 -and $parts[1] -lt 6)) {
    Write-Log "Node $v 太老(需 >=22.6,探针要执行 TS 检查器)"
    exit 2
  }
} catch {
  Write-Log "找不到 node: $($_.Exception.Message)"
  exit 2
}

# ── 3. 跑探针 ──
Write-Log '开始'
try {
  $out = (& node 'scripts\upstream-probe.mjs' 2>&1 | Out-String)
  foreach ($l in ($out -split "`r?`n")) {
    if ($l.Trim()) { Write-Log $l.Trim() }
  }
  # 以「云端上报成功」这行为准 —— 它是唯一能证明云端真的收到了的信号。
  # 早期 nginx 给所有路径注入 token 时,带错 token 也返回成功;
  # 收紧之后不会了,但仍然以这行为准,因为脚本没法假设服务端一定诚实。
  if ($out -match '云端上报成功') {
    Write-Log 'OK(已上报云端)'
  } else {
    Write-Log '⚠ 未见「云端上报成功」—— 数据可能没上云,看板黑盒那栏会停留在上一次'
  }
} catch {
  Write-Log "失败: $($_.Exception.Message)"
  exit 1
}
