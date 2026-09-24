param()

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$watchdog = Join-Path $root 'Watchdog.ps1'

while ($true) {
    try {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $watchdog | Out-Null
    } catch {}
    Start-Sleep -Seconds 60
}
