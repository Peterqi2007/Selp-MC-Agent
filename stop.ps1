<#
  一键停止：先走面板急停（Agent 自己会干净退出、释放单实例锁），
  不行再兜底 kill。默认**不关**游戏客户端。

  用法 / usage
    .\stop.ps1              停 Agent，游戏继续开着
    .\stop.ps1 -Client      连游戏客户端一起关
    .\stop.ps1 -Help

  如果提示「在此系统上禁止运行脚本」：
    powershell -NoProfile -ExecutionPolicy Bypass -File .\stop.ps1
#>

[CmdletBinding()]
param(
  [switch]$Client,
  [switch]$Help
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

if ($Help) {
  Write-Host @'
一键停止：先走面板急停（Agent 自己干净退出、释放单实例锁），不行再兜底 kill。
默认不关游戏客户端。

  .\stop.ps1              停 Agent，游戏继续开着
  .\stop.ps1 -Client      连游戏客户端一起关

若提示「在此系统上禁止运行脚本」：
  powershell -NoProfile -ExecutionPolicy Bypass -File .\stop.ps1
'@
  exit 0
}

function Ok($msg) { Write-Host "  [OK]   $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  [!!]   $msg" -ForegroundColor Yellow }
function Bad($msg) { Write-Host "  [FAIL] $msg" -ForegroundColor Red }
function Info($msg) { Write-Host "         $msg" -ForegroundColor DarkGray }

function Test-ProcessAlive {
  param([int]$ProcessId)
  if (-not $ProcessId) { return $false }
  return [bool](Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

# 只杀我们自己启动的那类进程：pid 会被系统回收，名字不对就绝不动手。
function Stop-AgentProcess {
  param([int]$ProcessId, [string]$What)
  $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if (-not $proc) { return $true }
  if ($proc.ProcessName -notmatch '^(node|javaw?|java)$') {
    Warn "$What pid $ProcessId 现在是 $($proc.ProcessName)，不是我们启动的进程 —— 不动它"
    return $false
  }
  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
  return -not (Test-ProcessAlive $ProcessId)
}

Write-Host ''
Write-Host '=== 停止 ==='

# ---- 1. 面板急停（最优路径：Agent 自己收尾）
$panel = $null
foreach ($port in 8766, 8767, 8768) {
  try {
    $null = Invoke-RestMethod -Uri "http://127.0.0.1:$port/ui/state" -TimeoutSec 2
    $panel = $port
    break
  } catch { }
}
if ($panel) {
  try {
    # Invoke-RestMethod 默认按 Latin-1 发 body，必须显式给 UTF-8，否则中文参数会变问号。
    $json = '{"reason":"stop.ps1"}'
    $body = [System.Text.Encoding]::UTF8.GetBytes($json)
    $null = Invoke-RestMethod -Uri "http://127.0.0.1:$panel/emergency-stop" -Method Post `
      -ContentType 'application/json; charset=utf-8' -Body $body -TimeoutSec 5
    Ok "已发送面板急停（127.0.0.1:$panel）"
  } catch {
    Warn "面板急停请求失败：$($_.Exception.Message)"
  }
} else {
  Warn '面板没有响应（Agent 可能本来就没在跑）'
}

# ---- 2. Agent 进程
$lockFile = Join-Path $Root 'runtime\agent.lock'
$lockPid = 0
if (Test-Path $lockFile) {
  try { $lockPid = [int](Get-Content $lockFile -Raw -Encoding UTF8 | ConvertFrom-Json).pid } catch { $lockPid = 0 }
}
if ($lockPid -and (Test-ProcessAlive $lockPid)) {
  $gone = $false
  for ($i = 0; $i -lt 12; $i++) {
    Start-Sleep -Milliseconds 500
    if (-not (Test-ProcessAlive $lockPid)) { $gone = $true; break }
  }
  if ($gone) {
    Ok "Agent（pid $lockPid）已退出"
  } else {
    Warn "Agent（pid $lockPid）没有自己退出，强制结束它"
    if (Stop-AgentProcess -ProcessId $lockPid -What 'Agent') { Ok "Agent（pid $lockPid）已结束" }
  }
} else {
  Ok '没有正在运行的 Agent'
  if (Test-Path $lockFile) {
    Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
    Ok '清掉了过期的 agent.lock'
  }
}

# ---- 3. 游戏客户端（可选）
if ($Client) {
  $meta = Get-ChildItem (Join-Path $Root 'runtime\logs') -Filter 'forge-client-*.json' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  $gamePid = 0
  if ($meta) {
    try { $gamePid = [int](Get-Content $meta.FullName -Raw -Encoding UTF8 | ConvertFrom-Json).pid } catch { $gamePid = 0 }
  }
  if ($gamePid -and (Test-ProcessAlive $gamePid)) {
    if (Stop-AgentProcess -ProcessId $gamePid -What '客户端') {
      Ok "客户端（pid $gamePid）已关闭"
    } else {
      Bad '客户端没关掉，请手动关掉游戏窗口'
    }
  } else {
    Warn '没找到正在运行的客户端（runtime\logs\forge-client-*.json 里的 pid 已经不在了）'
    Info '如果游戏窗口还开着，请手动关掉它'
  }
} else {
  Info '客户端保持运行。要连游戏一起关：.\stop.ps1 -Client'
}

Write-Host ''
exit 0
