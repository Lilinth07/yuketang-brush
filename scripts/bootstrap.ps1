# 环境自举：找到/准备 Node，装依赖，进菜单
# 由 启动.bat 调用，不要直接双击

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $Root
Set-Location $Root

# 让当前控制台支持 ANSI 颜色/清屏（子进程 node 继承同一控制台）
try {
  Add-Type -Name Con -Namespace Win32 -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr GetStdHandle(int n);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetConsoleMode(IntPtr h, out uint m);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleMode(IntPtr h, uint m);
'@ -ErrorAction Stop
  $hOut = [Win32.Con]::GetStdHandle(-11)
  $mode = [uint32]0
  if ([Win32.Con]::GetConsoleMode($hOut, [ref]$mode)) {
    [void][Win32.Con]::SetConsoleMode($hOut, $mode -bor 0x0004)
  }
  Remove-Item Env:NO_COLOR -ErrorAction SilentlyContinue
} catch {
  $env:NO_COLOR = '1'
}

$RuntimeDir = Join-Path $Root '.runtime'
$LocalNode  = Join-Path $RuntimeDir 'node.exe'
$LocalNpm   = Join-Path $RuntimeDir 'npm.cmd'

function Write-Step($msg) { Write-Host "  $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  [!] $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "  [x] $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "  雨课堂刷课器" -ForegroundColor White
Write-Host "  ------------" -ForegroundColor DarkGray
Write-Host ""

# ---------- 1. 找 Node ----------

function Find-Node {
  if (Test-Path $LocalNode) { return $LocalNode }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

$Node = Find-Node

if (-not $Node) {
  Write-Step "未检测到 Node.js，首次运行需要下载（约 30MB，只需一次）"
  Write-Host ""

  $ver = 'v20.18.1'
  $mirrors = @(
    "https://npmmirror.com/mirrors/node/$ver/node-$ver-win-x64.zip",
    "https://nodejs.org/dist/$ver/node-$ver-win-x64.zip"
  )

  New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
  $zip = Join-Path $RuntimeDir 'node.zip'
  $done = $false

  foreach ($url in $mirrors) {
    try {
      Write-Step "从 $url 下载…"
      $sw = [System.Diagnostics.Stopwatch]::StartNew()
      Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -TimeoutSec 300
      $sw.Stop()
      Write-Ok ("下载完成 {0:N1} MB / {1:N0} 秒" -f ((Get-Item $zip).Length / 1MB), $sw.Elapsed.TotalSeconds)
      $done = $true
      break
    } catch {
      Write-Warn "这个源不行，换下一个（$($_.Exception.Message.Split([Environment]::NewLine)[0])）"
    }
  }

  if (-not $done) {
    Write-Err "下载失败。请手动安装 Node.js：https://nodejs.org/zh-cn"
    Write-Host "  装完后重新双击 启动.bat" -ForegroundColor Gray
    exit 1
  }

  Write-Step "解压…"
  Expand-Archive -Path $zip -DestinationPath $RuntimeDir -Force
  $inner = Get-ChildItem -Path $RuntimeDir -Directory | Where-Object { $_.Name -like 'node-*' } | Select-Object -First 1
  if (-not $inner) {
    Write-Err "解压后找不到 node 目录"
    exit 1
  }
  Get-ChildItem -Path $inner.FullName -Force | Move-Item -Destination $RuntimeDir -Force
  Remove-Item -Path $inner.FullName -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -Path $zip -Force -ErrorAction SilentlyContinue

  $Node = Find-Node
  if (-not $Node) {
    Write-Err "Node 准备失败"
    exit 1
  }
  Write-Ok "Node 已就位：$ver"
} else {
  $v = & $Node --version
  Write-Ok "Node $v"
}

$NodeDir = Split-Path -Parent $Node
$Npm = Join-Path $NodeDir 'npm.cmd'
if (-not (Test-Path $Npm)) {
  $cmd = Get-Command npm -ErrorAction SilentlyContinue
  if ($cmd) { $Npm = $cmd.Source }
}

# ---------- 2. 装依赖 ----------

$PwDir = Join-Path $Root 'node_modules\playwright'
if (-not (Test-Path $PwDir)) {
  if (-not $Npm -or -not (Test-Path $Npm)) {
    Write-Err "找不到 npm，无法安装依赖"
    exit 1
  }
  Write-Step "首次运行，安装依赖（约 1 分钟）…"
  & $Npm install --no-audit --no-fund --loglevel=error
  if ($LASTEXITCODE -ne 0) {
    Write-Warn "默认源失败，改用国内镜像重试…"
    & $Npm install --registry=https://registry.npmmirror.com --no-audit --no-fund --loglevel=error
  }
  if ($LASTEXITCODE -ne 0) {
    Write-Err "依赖安装失败，检查网络后重试"
    exit 1
  }
  Write-Ok "依赖安装完成"
} else {
  Write-Ok "依赖已就绪"
}

# ---------- 3. 检查浏览器 ----------

$browsers = @(@(
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ })

if ($browsers.Count -eq 0) {
  Write-Warn "没找到 Edge / Chrome，登录那一步会失败"
  Write-Host "  Windows 10/11 自带 Edge，如果你卸了，去装一个" -ForegroundColor Gray
} else {
  Write-Ok "浏览器：$(Split-Path -Leaf $browsers[0])"
}

Write-Host ""

# ---------- 4. 进菜单 ----------

& $Node (Join-Path $Root 'src\menu.mjs')
exit $LASTEXITCODE
