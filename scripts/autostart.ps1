<#
.SYNOPSIS
  Starts the whole stack by itself each time you sign in to Windows.

.DESCRIPTION
  Puts a shortcut in your Startup folder that runs start-all.ps1 -NoBrowser in a
  minimized window (no administrator rights, nothing outside your user profile). Its
  output goes to data\logs\autostart.log. Run with -Remove to undo, -Status to check.

.EXAMPLE
  .\scripts\autostart.ps1
  .\scripts\autostart.ps1 -Status
  .\scripts\autostart.ps1 -Remove
#>
param(
  [switch]$Remove,
  [switch]$Status,
  # Internal: what the shortcut calls.
  [switch]$Run,
  # Start-up programs compete at sign-in; give Docker Desktop and the network a moment.
  [ValidateRange(0, 600)][int]$DelaySeconds = 30
)
$ErrorActionPreference = 'Stop'
$Backend = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$link = Join-Path ([Environment]::GetFolderPath('Startup')) 'Vehicle Tracking.lnk'

if ($Status) {
  if (Test-Path $link) { Write-Host "Installed: $link" } else { Write-Host 'Not installed.' }
  $log = Join-Path $Backend 'data\logs\autostart.log'
  if (Test-Path $log) { Write-Host "Last run ($log):"; Get-Content $log -Tail 15 }
  return
}
if ($Remove) {
  if (Test-Path $link) { Remove-Item $link -Confirm:$false; Write-Host "Removed $link" }
  else { Write-Host 'Not installed; nothing to remove.' }
  return
}

$logs = Join-Path $Backend 'data\logs'
if ($Run) {
  # What the shortcut runs at sign-in. The log keeps the latest run only.
  New-Item -ItemType Directory -Force $logs | Out-Null
  Start-Sleep -Seconds $DelaySeconds
  $ErrorActionPreference = 'Continue'
  try { & (Join-Path $PSScriptRoot 'start-all.ps1') -NoBrowser *>&1 | Tee-Object -FilePath (Join-Path $logs 'autostart.log') }
  catch {
    "FAILED: $_" | Tee-Object -FilePath (Join-Path $logs 'autostart.log') -Append
    Read-Host 'start-all failed; press Enter to close'
  }
  return
}

$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($link)
$shortcut.TargetPath = (Get-Command powershell.exe).Source
$shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Run -DelaySeconds $DelaySeconds"
$shortcut.WorkingDirectory = $Backend
$shortcut.WindowStyle = 7 # Minimized
$shortcut.Description = 'Vehicle Tracking: PostgreSQL, API, worker and web'
$shortcut.Save()

Write-Host "Installed: $link" -ForegroundColor Green
Write-Host 'The stack now starts when you sign in to Windows. Also needed:'
Write-Host ' - Docker Desktop installed (start-all opens it when it is not running).'
Write-Host ' - The laptop must stay awake: Settings > System > Power > "When plugged in, put my device to sleep" = Never.'
Write-Host 'Undo with: .\scripts\autostart.ps1 -Remove'
