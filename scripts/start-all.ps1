<#
.SYNOPSIS
  Starts the whole local stack: PostgreSQL (Docker), API, recognition worker and FE.

.DESCRIPTION
  Each service opens in its own titled window so its output stays visible; close a
  window to stop that service. Services already running are left untouched, so the
  script can be re-run safely without interrupting a job in progress.

.EXAMPLE
  .\scripts\start-all.ps1
  .\scripts\start-all.ps1 -SkipBuild -NoBrowser
#>
param(
  [string]$FrontendDir = (Join-Path $PSScriptRoot '..\..\Vehicle_Tracking_FE_test'),
  [switch]$SkipBuild,
  [switch]$NoBrowser
)
# Native tools write progress to stderr; check exit codes instead of stopping on it.
$ErrorActionPreference = 'Continue'
$Backend = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not (Test-Path (Join-Path $FrontendDir 'package.json'))) {
  throw "Frontend not found at $FrontendDir (pass -FrontendDir)."
}
$Frontend = (Resolve-Path $FrontendDir).Path
$envFile = Join-Path $Backend '.env'
if (-not (Test-Path $envFile)) { throw 'Missing .env; copy .env.example and fill it in first.' }
$apiPort = 3000
$portLine = Select-String -Path $envFile -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
if ($portLine) { $apiPort = [int]$portLine.Matches[0].Groups[1].Value }
$fePort = 5173

function Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Run($what) {
  & $what[0] $what[1..($what.Length - 1)]
  if ($LASTEXITCODE -ne 0) { throw "Failed ($LASTEXITCODE): $($what -join ' ')" }
}
function Listening($port) {
  [bool](Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
}
function WorkerRunning {
  [bool](Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*worker.js*' })
}
function Open-Window($title, $dir, $command) {
  $cmd = "`$Host.UI.RawUI.WindowTitle='$title'; Set-Location '$dir'; $command"
  Start-Process powershell -ArgumentList '-NoExit', '-NoProfile', '-Command', $cmd
}
function Wait-Until($what, $seconds, [scriptblock]$ready) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while (-not (& $ready)) {
    if ((Get-Date) -gt $deadline) { throw "$what did not become ready within $seconds s." }
    Start-Sleep -Seconds 2
  }
}

Push-Location $Backend
try {
  Step 'Docker'
  docker info *> $null
  if ($LASTEXITCODE -ne 0) {
    $desktop = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
    if (-not (Test-Path $desktop)) { throw 'Docker is not running and Docker Desktop was not found.' }
    Start-Process $desktop
    Wait-Until 'Docker' 180 { docker info *> $null; $LASTEXITCODE -eq 0 }
  }

  Step 'PostgreSQL'
  Run @('docker', 'compose', 'up', '-d', '--wait', 'postgres')

  if (-not $SkipBuild) {
    Step 'Build backend'
    Run @('npm.cmd', 'run', 'build')
  }
  Step 'Migrate database'
  Run @('npm.cmd', 'run', 'db:migrate')

  if (-not (Test-Path (Join-Path $Frontend 'node_modules'))) {
    Step 'Install frontend dependencies'
    Push-Location $Frontend
    try { Run @('npm.cmd', 'install') } finally { Pop-Location }
  }

  Step 'Start services'
  if (Listening $apiPort) { Write-Host "API already listening on :$apiPort" }
  else { Open-Window "API (BE :$apiPort)" $Backend 'npm start' }
  # Only one worker may own the database; a second one would exit immediately.
  if (WorkerRunning) { Write-Host 'Worker already running' }
  else { Open-Window 'WORKER' $Backend 'npm run worker' }
  if (Listening $fePort) { Write-Host "FE already listening on :$fePort" }
  else { Open-Window "WEB (FE :$fePort)" $Frontend 'npm run dev' }

  Step 'Wait for readiness'
  Wait-Until 'API' 90 {
    try { (Invoke-WebRequest "http://127.0.0.1:$apiPort/health/ready" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 }
    catch { $false }
  }
  Wait-Until 'FE' 90 { Listening $fePort }

  Write-Host ''
  Write-Host "Ready: web http://127.0.0.1:$fePort  |  API docs http://127.0.0.1:$apiPort/docs" -ForegroundColor Green
  if (-not $NoBrowser) { Start-Process "http://127.0.0.1:$fePort" }
}
finally {
  Pop-Location
}
