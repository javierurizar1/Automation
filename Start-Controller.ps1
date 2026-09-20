param(
    [switch]$NoOpenDashboard
)

$ErrorActionPreference = 'Stop'
$appRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$dataDir = Join-Path $appRoot 'data'
$logsDir = Join-Path $appRoot 'logs'
$profileDir = Join-Path $appRoot 'chrome-profile'
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$port = 9333
$dashboardPort = 9350
$configPath = Join-Path $appRoot 'config.json'
$cdpSessionProbe = Join-Path $appRoot 'scripts\Test-CdpSession.mjs'
try {
    $launchConfig = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if ($launchConfig.cdpPort) { $port = [int]$launchConfig.cdpPort }
    if ($launchConfig.dashboardPort) { $dashboardPort = [int]$launchConfig.dashboardPort }
} catch {}
$controlPath = Join-Path $dataDir 'control.json'
$dashboardPidFile = Join-Path $dataDir 'dashboard.pid'

New-Item -ItemType Directory -Force -Path $dataDir,$logsDir,$profileDir | Out-Null

$control = @{}
if (Test-Path -LiteralPath $controlPath) {
    try {
        $existingControl = Get-Content -LiteralPath $controlPath -Raw | ConvertFrom-Json
        foreach ($property in $existingControl.PSObject.Properties) { $control[$property.Name] = $property.Value }
    } catch {}
}
$preservePausedState = [string]$control['desiredState'] -eq 'PAUSED'
if ($preservePausedState) {
    Write-Host 'Existing PAUSED controller state preserved.'
} else {
    $control['desiredState'] = 'RUNNING'
    $control['requestedAt'] = (Get-Date).ToUniversalTime().ToString('o')
    $control['requestedBy'] = 'Start-Controller.ps1'
    [IO.File]::WriteAllText($controlPath, (($control | ConvertTo-Json -Depth 6) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
}

if (-not (Test-Path -LiteralPath $chrome)) {
    throw "Chrome not found: $chrome"
}

$watchdogPidFile = Join-Path $dataDir 'watchdog.pid'
function Ensure-Watchdog {
    $watchdogProcessId = $null
    if (Test-Path -LiteralPath $watchdogPidFile) {
        try { $watchdogProcessId = [int](Get-Content -LiteralPath $watchdogPidFile -Raw) } catch {}
    }
    if (-not $watchdogProcessId -or -not (Get-Process -Id $watchdogProcessId -ErrorAction SilentlyContinue)) {
        $watchdog = Start-Process -FilePath 'powershell.exe' `
            -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',(Join-Path $appRoot 'WatchdogLoop.ps1')) `
            -WindowStyle Hidden `
            -PassThru
        Set-Content -LiteralPath $watchdogPidFile -Value $watchdog.Id -Encoding ASCII
        Write-Host "Watchdog started PID $($watchdog.Id)."
    }
}

function Test-CdpSession {
    if (-not (Test-Path -LiteralPath $cdpSessionProbe)) { return $false }
    try {
        & node.exe $cdpSessionProbe $port 6000 *> $null
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    }
}

function Stop-DedicatedChrome {
    $dedicated = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profileDir*" }
    foreach ($process in $dedicated) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
    if ($dedicated) { Start-Sleep -Seconds 2 }
}

$cdpHttpReady = $false
try {
    $null = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 2
    $cdpHttpReady = $true
} catch {}
$cdpReady = $cdpHttpReady -and (Test-CdpSession)

if (-not $cdpReady) {
    if ($cdpHttpReady) {
        Write-Host "Chrome CDP endpoint is responding but the browser session is unusable; restarting dedicated Chrome."
    }
    Stop-DedicatedChrome
    Start-Process -FilePath $chrome -ArgumentList @(
        "--remote-debugging-port=$port",
        "--user-data-dir=$profileDir",
        '--disable-gpu',
        '--no-first-run',
        'https://chatgpt.com/'
    )
    $cdpReady = $false
    for ($attempt = 1; $attempt -le 6; $attempt += 1) {
        Start-Sleep -Seconds 2
        $httpReady = $false
        try {
            $null = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 2
            $httpReady = $true
        } catch {}
        if ($httpReady -and (Test-CdpSession)) {
            $cdpReady = $true
            break
        }
    }
    if (-not $cdpReady) {
        throw "Dedicated Chrome did not produce a usable CDP session on port $port"
    }
}

$dashboardRunning = $false
if (Test-Path -LiteralPath $dashboardPidFile) {
    try {
        $dashboardProcessId = [int](Get-Content -LiteralPath $dashboardPidFile -Raw)
        $dashboardProcess = Get-Process -Id $dashboardProcessId -ErrorAction SilentlyContinue
        if ($dashboardProcess -and $dashboardProcess.ProcessName -eq 'node') {
            $pidWrittenAt = (Get-Item -LiteralPath $dashboardPidFile).LastWriteTimeUtc
            $startedAt = $dashboardProcess.StartTime.ToUniversalTime()
            $dashboardRunning = [Math]::Abs(($startedAt - $pidWrittenAt).TotalSeconds) -le 10
        }
    } catch {}
}

if (-not $dashboardRunning) {
    $dashboardStdout = Join-Path $logsDir 'dashboard.stdout.log'
    $dashboardStderr = Join-Path $logsDir 'dashboard.stderr.log'
    $dashboard = Start-Process -FilePath 'node.exe' `
        -ArgumentList @((Join-Path $appRoot 'src\dashboard.mjs')) `
        -WorkingDirectory $appRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $dashboardStdout `
        -RedirectStandardError $dashboardStderr `
        -PassThru
    Set-Content -LiteralPath $dashboardPidFile -Value $dashboard.Id -Encoding ASCII
    Write-Host "Dashboard started PID $($dashboard.Id) on http://127.0.0.1:$dashboardPort/."
} else {
    Write-Host "Dashboard already running PID $dashboardProcessId."
}
if (-not $NoOpenDashboard) {
    try {
        Start-Process "http://127.0.0.1:$dashboardPort/"
    } catch {
        Write-Warning "Dashboard is running on http://127.0.0.1:$dashboardPort/ but could not be opened automatically: $($_.Exception.Message)"
    }
}

$controllerPidFile = Join-Path $dataDir 'controller.pid'
$statusPath = Join-Path $dataDir 'status.json'
$controllerProcessId = $null
if (Test-Path -LiteralPath $controllerPidFile) {
    try { $controllerProcessId = [int](Get-Content -LiteralPath $controllerPidFile -Raw) } catch {}
}

$controllerProcess = $null
$controllerPidMatchesLaunch = $false
if ($controllerProcessId) {
    try {
        $controllerProcess = Get-Process -Id $controllerProcessId -ErrorAction SilentlyContinue
        if ($controllerProcess -and $controllerProcess.ProcessName -eq 'node') {
            $pidWrittenAt = (Get-Item -LiteralPath $controllerPidFile).LastWriteTimeUtc
            $startedAt = $controllerProcess.StartTime.ToUniversalTime()
            $controllerPidMatchesLaunch = [Math]::Abs(($startedAt - $pidWrittenAt).TotalSeconds) -le 10
        }
    } catch {}
}
$controllerHealthy = $false
if ($controllerProcess -and $controllerPidMatchesLaunch -and (Test-Path -LiteralPath $statusPath)) {
    try {
        $controllerStatus = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
        $statusAgeSeconds = ((Get-Date).ToUniversalTime() - (Get-Item -LiteralPath $statusPath).LastWriteTimeUtc).TotalSeconds
        $controllerHealthy = $statusAgeSeconds -le 300 -and [string]$controllerStatus.controllerState -ne 'STOPPED'
    } catch {}
}
if ($controllerHealthy) {
    Ensure-Watchdog
    Write-Host "Controller already running PID $controllerProcessId."
    exit 0
}
if ($controllerProcess -and $controllerPidMatchesLaunch) {
    Stop-Process -Id $controllerProcessId -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    Write-Host "Replaced stale controller PID $controllerProcessId."
} elseif ($controllerProcess) {
    throw "controller.pid points to a live process whose launch identity cannot be verified; refusing to replace or duplicate it"
}

$stdout = Join-Path $logsDir 'controller.stdout.log'
$stderr = Join-Path $logsDir 'controller.stderr.log'
$controller = Start-Process -FilePath 'node.exe' `
    -ArgumentList @((Join-Path $appRoot 'src\controller.mjs')) `
    -WorkingDirectory $appRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -PassThru

Set-Content -LiteralPath $controllerPidFile -Value $controller.Id -Encoding ASCII
Ensure-Watchdog
Write-Host "Controller started PID $($controller.Id)."
Write-Host "Dedicated Chrome profile: $profileDir"
Write-Host "If ChatGPT asks for authentication in that Chrome window, sign in once."
