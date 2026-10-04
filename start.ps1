<#
  一键启动：把「启动客户端」和「启动 Agent」两条指令放在一个文件里。

  用法 / usage
    .\start.ps1                        客户端 + Agent（客户端已在跑则自动跳过）
    .\start.ps1 -NoClient              客户端已经开着了，只起 Agent
    .\start.ps1 -NoAgent               只把客户端送进世界，自己再手动起 Agent
    .\start.ps1 -Server host:25565     换服务器
    .\start.ps1 -Goal "gather wood" -Day
    .\start.ps1 -Wait 420              多等一会儿（默认 300 秒）
    .\start.ps1 -Help

  如果提示「未对文件进行数字签名 / 在此系统上禁止运行脚本」，用这一行绕过：
    powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1

  为什么会被拦（2026-10 实测定位，结论和直觉不一样）：
    本机执行策略是 RemoteSigned，它**允许**本地未签名脚本，所以报「未签名」不是
    策略太严，而是 PowerShell 把**这个目录**当成了远程位置。

    证据：字节完全相同的 start.ps1
      · 在 %TEMP%、E:\PCL、以及任何新建目录里   -> 正常运行
      · 只有放在 <repo> 里          -> 被拦
    而且在该目录里新建一个两行的 .ps1 也会被拦，所以与文件内容、换行符、BOM 都无关。

    已排除的原因：Zone.Identifier（Get-Item -Stream * 和 dir /r 都查不到）、
    目录重解析点（fsutil 报 not a reparse point）、受控文件夹访问（关闭）、
    AppLocker/Safer/WDAC（无有效规则）、路径空格（带空格的其他目录正常）。

    所以：不要用 Unblock-File（没有 zone 流，它是空操作），也不必改全局策略。
    用上面那行 Bypass；或者把项目复制到一个新目录，那个目录就是干净的。

  为什么要等，而不是两条命令直接连着跑：
    控制 Mod 的 HTTP 口（8899）在**进入世界之前**就开了，端口通 ≠ 能干活。
    这时起 Agent 会看到「扫描还没加载」，然后一连串看起来像 bug 的失败。
    所以这里等 /health 报 inWorld=true 再起 Agent。
#>

[CmdletBinding()]
param(
  [string]$Server,
  [string]$Profile = 'simpfun',
  [switch]$NoClient,
  [switch]$NoAgent,
  [int]$Wait = 300,
  [string]$Goal,
  [switch]$Day,
  [string[]]$AgentArg = @(),
  [switch]$Help
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

# ---------------------------------------------------------------- 参数 / 服务器

if ($Help) {
  Write-Host @'
一键启动：把「启动客户端」和「启动 Agent」两条指令放在一个文件里。

  .\start.ps1                        客户端 + Agent（客户端已在跑则自动跳过）
  .\start.ps1 -NoClient              客户端已经开着了，只起 Agent
  .\start.ps1 -NoAgent               只把客户端送进世界，自己再手动起 Agent
  .\start.ps1 -Server host:25565     换服务器
  .\start.ps1 -Profile local         换 config/servers.json 里的档位
  .\start.ps1 -Goal "gather wood" -Day
  .\start.ps1 -AgentArg --force      额外参数原样传给 Agent
  .\start.ps1 -Wait 420              多等一会儿（默认 300 秒）

停止：Ctrl+C（只停 Agent） 或  .\stop.ps1       连游戏一起停：.\stop.ps1 -Client

若提示「在此系统上禁止运行脚本」：
  powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1
'@
  exit 0
}

# 服务器地址从 config/servers.json 的档位里取，取不到就用默认值。
$McHost = 'mc.example.com'
$McPort = 25565
try {
  $servers = Get-Content (Join-Path $Root 'config\servers.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $p = $servers.profiles.$Profile
  if ($p) { $McHost = $p.host; $McPort = $p.port }
} catch {
  Write-Host '  [!!]   读 config\servers.json 失败，改用默认地址' -ForegroundColor Yellow
}
$Target = if ($Server) { $Server } else { "${McHost}:${McPort}" }

# 用户名（只用于打印）
$Username = 'AgentSteve'
try {
  $agentCfg = Get-Content (Join-Path $Root 'config\agent.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($agentCfg.bot.username) { $Username = $agentCfg.bot.username }
} catch { }

function Say($msg) { Write-Host $msg }
function Ok($msg) { Write-Host "  [OK]   $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  [!!]   $msg" -ForegroundColor Yellow }
function Bad($msg) { Write-Host "  [FAIL] $msg" -ForegroundColor Red }
function Info($msg) { Write-Host "         $msg" -ForegroundColor DarkGray }

# ---------------------------------------------------------------- 小工具

function Get-ModPort { 8899 }

function Test-Mod {
  param([int]$TimeoutSec = 2)
  try { return Invoke-RestMethod -Uri "http://127.0.0.1:$(Get-ModPort)/health" -TimeoutSec $TimeoutSec } catch { return $null }
}

function Test-ProcessAlive {
  param([int]$ProcessId)
  if (-not $ProcessId) { return $false }
  return [bool](Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

# 客户端日志里的已知故障 → 结论 + 处理办法
$KnownFailures = @(
  @{ re = 'port 8899 is already owned by another Minecraft instance'
     why = '已经有一个客户端占着 8899 端口（同时只能开一个）'
     fix = '关掉那个客户端，或加 -NoClient 复用正在跑的那个' },
  @{ re = 'UnsupportedClassVersionError|class file version'
     why = 'Java 版本不对（1.20.1 Forge 需要 Java 17-21）'
     fix = '设置环境变量 MC_JAVA=<jdk17-21 的 java.exe>，或改 config\pcl.json 的 javaCandidates' },
  @{ re = 'A fatal error has been detected|Failed to start game'
     why = 'Java 进程崩溃（多半是内存）'
     fix = '给启动脚本加 --memory 6144；完整堆栈在 runtime\logs\forge-client-*.log' },
  @{ re = 'Could not find or load main class|NoClassDefFoundError'
     why = '客户端 classpath 不完整（整合包没装全）'
     fix = '先用 PCL2 启动一次该版本，让它补齐 libraries' },
  @{ re = 'multiplayer\.disconnect|Failed to connect|Connection refused'
     why = '客户端起来了，但没连上服务器'
     fix = '检查 -Server 参数和网络；客户端本身没问题' }
)

function Show-Diagnosis {
  $launcherLog = Get-ChildItem (Join-Path $Root 'runtime\logs') -Filter 'forge-client-*.log' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  $gameLog = Join-Path $env:APPDATA '.minecraft\versions\1.20.1-Forge_47.4.10\logs\latest.log'
  $text = ''
  if ($launcherLog) { $text += (Get-Content $launcherLog.FullName -Raw -Encoding UTF8 -ErrorAction SilentlyContinue) }
  if (Test-Path $gameLog) { $text += (Get-Content $gameLog -Raw -Encoding UTF8 -ErrorAction SilentlyContinue) }

  if (-not $text) {
    Warn '客户端日志是空的 —— 游戏可能根本没启动起来'
  } else {
    $hit = $false
    foreach ($k in $KnownFailures) {
      if ($text -match $k.re) {
        Bad "原因：$($k.why)"
        Info "处理：$($k.fix)"
        $hit = $true
        break
      }
    }
    if (-not $hit) {
      Warn '没匹配到已知原因，下面是日志最后几行：'
      ($text -split "`n" | Select-Object -Last 10) | ForEach-Object { Info $_.Trim() }
    }
  }
  if ($launcherLog) { Info "完整日志：$($launcherLog.FullName)" }
  if (Test-Path $gameLog) { Info "游戏日志：$gameLog" }
}

function Get-PanelPort {
  foreach ($port in 8766, 8767, 8768) {
    try {
      $null = Invoke-RestMethod -Uri "http://127.0.0.1:$port/ui/state" -TimeoutSec 2
      return $port
    } catch { }
  }
  return $null
}

# ---------------------------------------------------------------- 开场

Say ''
Say '==============================================================='
Say '  Minecraft 生存 Agent —— 一键启动'
Say "  角色   : $Username  ->  $Target"
Say '  面板   : http://127.0.0.1:8766/panel  （Agent 起来后）'
Say '  停止   : Ctrl+C 停 Agent；.\stop.ps1 连客户端一起停'
Say '==============================================================='

# ---------------------------------------------------------------- 指令 1：启动客户端

Say ''
Say '=== 步骤 1/2  客户端 ==='

if (Test-Mod) {
  Ok '控制 Mod 已经在 8899 端口应答 —— 不重复启动'
  Info '（同时开两个客户端会互抢 8899，后启动的那个会完全失去 API 却看起来一切正常）'
} elseif ($NoClient) {
  Bad '-NoClient 指定跳过启动，但 8899 端口上什么都没有'
  Info '先把客户端开起来：npm run client:launch -- --server <地址>'
  exit 1
} else {
  Say "         正在启动 Forge 客户端并进入 $Target（60-90 秒，窗口会自己弹出来）…"

  # ---- 指令 1 ----
  & node (Join-Path $Root 'scripts\launch-forge-client.js') --server $Target
  if ($LASTEXITCODE -ne 0) {
    Bad "客户端启动脚本退出码 $LASTEXITCODE"
    Show-Diagnosis
    exit 1
  }
  Ok '客户端进程已拉起'
}

# 等控制 Mod 上线（最多 180 秒）
$deadline = (Get-Date).AddSeconds(180)
$mod = $null
while ((Get-Date) -lt $deadline -and -not $mod) {
  $mod = Test-Mod
  if (-not $mod) {
    Start-Sleep -Seconds 2
    $left = [int]($deadline - (Get-Date)).TotalSeconds
    if ($left % 20 -eq 0) { Say "         等待控制 Mod 上线…（还剩 ${left}s）" }
  }
}
if (-not $mod) {
  Bad '等了 180 秒，8899 端口上还是没有控制 Mod'
  Info '可能原因：Mod 没装进这个版本 / 客户端崩了 / 端口被别的程序占了'
  Show-Diagnosis
  exit 1
}
Ok "控制 Mod 已上线：$($mod.mod) $($mod.version)"

# 等真正进入世界（inWorld = true）
$deadline = (Get-Date).AddSeconds($Wait)
$inWorld = $false
while ((Get-Date) -lt $deadline -and -not $inWorld) {
  $h = Test-Mod
  if ($h -and $h.inWorld) { $inWorld = $true; break }
  Start-Sleep -Seconds 2
  $left = [int]($deadline - (Get-Date)).TotalSeconds
  if ($left % 15 -eq 0) { Say "         已连上，等待进入世界…（还剩 ${left}s）" }
}
if (-not $inWorld) {
  Bad "等了 $Wait 秒还没进入世界"
  Info '客户端可能停在主菜单、卡在登录界面，或者连接被服务器拒绝'
  Show-Diagnosis
  exit 1
}

# 世界状态摘要（/state 会重建整张方块表，只取一次）
$state = $null
try { $state = Invoke-RestMethod -Uri 'http://127.0.0.1:8899/state' -TimeoutSec 6 } catch { }
if ($state) {
  $pos = if ($state.position) { "$([math]::Round($state.position.x)),$([math]::Round($state.position.y)),$([math]::Round($state.position.z))" } else { '?' }
  Ok "已进入世界：$($state.dimension) @ $pos"
  Info "血量 $($state.health)/$($state.maxHealth) · 饱食 $($state.food)"
  if ($state.screenOpen) {
    Warn "游戏里开着界面（$($state.screen)）—— 开着界面时 Minecraft 会忽略所有移动输入"
    Info 'Agent 能动，但角色不会走。关掉那个界面（或按 Esc）再继续。'
  }
  if (-not $state.mouseGrabbed) {
    Warn '鼠标没被游戏捕获（窗口没聚焦）—— 移动输入同样会被忽略，点一下游戏窗口'
  }
}

if ($NoAgent) {
  Say ''
  Ok '完成（-NoAgent）：客户端已经在世界里，随时可以手动起 Agent：npm run agent:client'
  exit 0
}

# ---------------------------------------------------------------- 指令 2：启动 Agent

Say ''
Say '=== 步骤 2/2  Agent ==='

# Agent 自己的单实例锁：已经有一个在跑就别再开，否则会互踢下线
$lockFile = Join-Path $Root 'runtime\agent.lock'
if (Test-Path $lockFile) {
  try {
    $lock = Get-Content $lockFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if (Test-ProcessAlive $lock.pid) {
      Bad "已经有一个 Agent 在跑（pid $($lock.pid)，启动于 $($lock.startedAt)）"
      Info '先停掉它：.\stop.ps1    或加 -AgentArg --force 强行再开一个（会互踢下线）'
      exit 1
    }
    Info "清掉过期的 agent.lock（pid $($lock.pid) 已经不在了）"
    Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
  } catch { }
}

$agentArgs = @('src\index.js', '--body', 'clientmod', '--profile', $Profile)
if ($Day) { $agentArgs += '--day' }
if ($Goal) { $agentArgs += @('--goal', $Goal) }
if ($AgentArg.Count -gt 0) { $agentArgs += $AgentArg }

Say "         node $($agentArgs -join ' ')"
Say '         提示：聊天框 `!chop 8` 是指令通道，`@猫娘 你好` 是自然语言通道；Ctrl+C 停 Agent（游戏继续开着）'
Say ''

# ---- 指令 2 ----
& node @agentArgs
$code = $LASTEXITCODE

Say ''
Say '=== Agent 已退出 ==='
Say "  退出码 $code"
$panel = Get-PanelPort
if ($panel) { Info "面板：http://127.0.0.1:$panel/panel" }
Info '想重开：再跑一次 .\start.ps1（客户端已经在跑，会直接跳到步骤 2）'
exit $code
