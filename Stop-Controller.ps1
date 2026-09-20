param()

$ErrorActionPreference = 'Continue'
$appRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$dataDir = Join-Path $appRoot 'data'
$controlPath = Join-Path $dataDir 'control.json'

$control = @{}
if (Test-Path -LiteralPath $controlPath) {
    try {
        $existingControl = Get-Content -LiteralPath $controlPath -Raw | ConvertFrom-Json
        foreach ($property in $existingControl.PSObject.Properties) { $control[$property.Name] = $property.Value }
    } catch {}
}
$control['desiredState'] = 'STOPPED'
$control['requestedAt'] = (Get-Date).ToUniversalTime().ToString('o')
$control['requestedBy'] = 'Stop-Controller.ps1'
try { [IO.File]::WriteAllText($controlPath, (($control | ConvertTo-Json -Depth 6) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false)) } catch {}

foreach ($name in @('controller','watchdog')) {
    $pidFile = Join-Path $dataDir ($name + '.pid')
    if (-not (Test-Path -LiteralPath $pidFile)) { continue }
    try {
        $processId = [int](Get-Content -LiteralPath $pidFile -Raw)
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
        $marker = if ($name -eq 'controller') { '*src\controller.mjs*' } else { '*WatchdogLoop.ps1*' }
        if ($process -and $process.CommandLine -like $marker) {
            Stop-Process -Id $processId
            Write-Host "Stopped $name PID $processId."
        }
    } catch {}
}
