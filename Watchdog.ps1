param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dataDir = Join-Path $root 'data'
$statusPath = Join-Path $dataDir 'status.json'
$statePath = Join-Path $dataDir 'state.json'
$controlPath = Join-Path $dataDir 'control.json'
$controllerPidPath = Join-Path $dataDir 'controller.pid'
$watchdogStatePath = Join-Path $dataDir 'watchdog-state.json'
$incidentDir = Join-Path $dataDir 'incidents'
$coordinatorWake = Join-Path $root 'CoordinatorWake.ps1'
$startController = Join-Path $root 'Start-Controller.ps1'
$configPath = Join-Path $root 'config.json'
$cdpSessionProbe = Join-Path $root 'scripts\Test-CdpSession.mjs'
$cdpPort = 9333

New-Item -ItemType Directory -Force -Path $incidentDir | Out-Null

function Read-Json([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json } catch { return $null }
}

function Write-JsonNoBom([string]$Path, $Value) {
    $json = $Value | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText($Path, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}

function Sha16([string]$Value) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
        $hash = $sha.ComputeHash($bytes)
        return ([BitConverter]::ToString($hash)).Replace('-', '').ToLowerInvariant().Substring(0,16)
    } finally {
        $sha.Dispose()
    }
}

function Test-CdpReady {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$cdpPort/json/version" -TimeoutSec 2
        if ($response.StatusCode -ne 200) { return $false }
        if (-not (Test-Path -LiteralPath $cdpSessionProbe)) { return $false }
        & node.exe $cdpSessionProbe $cdpPort 6000 *> $null
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    }
}

try {
    $watchdogConfig = Read-Json $configPath
    if ($watchdogConfig -and $watchdogConfig.cdpPort) { $cdpPort = [int]$watchdogConfig.cdpPort }
} catch {}

$issues = [System.Collections.Generic.List[string]]::new()
$issueCodes = [System.Collections.Generic.List[string]]::new()
$now = Get-Date
$control = Read-Json $controlPath
$desiredState = if ($control -and $control.desiredState) { [string]$control.desiredState } else { 'RUNNING' }

if ($desiredState -ne 'RUNNING') {
    Write-JsonNoBom $watchdogStatePath ([ordered]@{
        last_healthy_at = (Get-Date).ToUniversalTime().ToString('o')
        last_fingerprint = $null
        last_incident_at = $null
        suppressed_state = $desiredState
    })
    exit 0
}

$controllerAlive = $false
if (-not (Test-Path -LiteralPath $controllerPidPath)) {
    $issues.Add('controller.pid is missing')
    $issueCodes.Add('CONTROLLER_PID_MISSING')
} else {
    try {
        $controllerProcessId = [int](Get-Content -LiteralPath $controllerPidPath -Raw)
        $controllerProcess = Get-Process -Id $controllerProcessId -ErrorAction SilentlyContinue
        $pidWrittenAt = (Get-Item -LiteralPath $controllerPidPath).LastWriteTimeUtc
        $startedAt = if ($controllerProcess) { $controllerProcess.StartTime.ToUniversalTime() } else { $null }
        $pidMatchesLaunch = $controllerProcess -and $controllerProcess.ProcessName -eq 'node' -and [Math]::Abs(($startedAt - $pidWrittenAt).TotalSeconds) -le 10
        if (-not $pidMatchesLaunch) {
            $issues.Add("controller process $controllerProcessId is not running")
            $issueCodes.Add('CONTROLLER_NOT_RUNNING')
        } else {
            $controllerAlive = $true
        }
    } catch {
        $issues.Add('controller.pid is invalid')
        $issueCodes.Add('CONTROLLER_PID_INVALID')
    }
}

if (-not $controllerAlive) {
    try {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startController -NoOpenDashboard | Out-Null
        Start-Sleep -Seconds 3
        $restartedPid = $null
        if (Test-Path -LiteralPath $controllerPidPath) {
            try { $restartedPid = [int](Get-Content -LiteralPath $controllerPidPath -Raw) } catch {}
        }
        $restartedProcess = if ($restartedPid) { Get-Process -Id $restartedPid -ErrorAction SilentlyContinue } else { $null }
        $restartedPidMatchesLaunch = $false
        if ($restartedProcess -and $restartedProcess.ProcessName -eq 'node' -and (Test-Path -LiteralPath $controllerPidPath)) {
            $pidWrittenAt = (Get-Item -LiteralPath $controllerPidPath).LastWriteTimeUtc
            $startedAt = $restartedProcess.StartTime.ToUniversalTime()
            $restartedPidMatchesLaunch = [Math]::Abs(($startedAt - $pidWrittenAt).TotalSeconds) -le 10
        }
        if ($restartedPidMatchesLaunch) {
            Write-JsonNoBom $watchdogStatePath ([ordered]@{
                last_healthy_at = (Get-Date).ToUniversalTime().ToString('o')
                last_fingerprint = $null
                last_incident_at = $null
                suppressed_state = $null
                auto_restarted_controller_at = (Get-Date).ToUniversalTime().ToString('o')
                auto_restarted_controller_pid = $restartedPid
            })
            exit 0
        }
        $issues.Add('automatic controller restart did not produce a live controller process')
        $issueCodes.Add('CONTROLLER_AUTO_RESTART_FAILED')
    } catch {
        $issues.Add("automatic controller restart failed: $($_.Exception.Message)")
        $issueCodes.Add('CONTROLLER_AUTO_RESTART_FAILED')
    }
}

# A live Node process with a fresh heartbeat is not healthy if the dedicated
# Chrome/CDP endpoint has disappeared. The controller intentionally keeps its
# heartbeat fresh while retrying CDP, so this must be checked independently.
if ($controllerAlive -and -not (Test-CdpReady)) {
    try {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startController -NoOpenDashboard | Out-Null
        $cdpRecovered = $false
        for ($attempt = 1; $attempt -le 6; $attempt += 1) {
            Start-Sleep -Seconds 2
            if (Test-CdpReady) {
                $cdpRecovered = $true
                break
            }
        }
        if ($cdpRecovered) {
            Write-JsonNoBom $watchdogStatePath ([ordered]@{
                last_healthy_at = (Get-Date).ToUniversalTime().ToString('o')
                last_fingerprint = $null
                last_incident_at = $null
                suppressed_state = $null
                auto_restarted_browser_at = (Get-Date).ToUniversalTime().ToString('o')
                cdp_port = $cdpPort
            })
            exit 0
        }
        $issues.Add("Chrome CDP endpoint 127.0.0.1:$cdpPort is unavailable after automatic browser restart")
        $issueCodes.Add('BROWSER_CDP_UNAVAILABLE')
    } catch {
        $issues.Add("automatic browser/CDP restart failed: $($_.Exception.Message)")
        $issueCodes.Add('BROWSER_CDP_AUTO_RESTART_FAILED')
    }
}

$statusStale = $false
if (-not (Test-Path -LiteralPath $statusPath)) {
    $issues.Add('status.json is missing')
    $issueCodes.Add('STATUS_MISSING')
} else {
    $ageSeconds = ($now - (Get-Item -LiteralPath $statusPath).LastWriteTime).TotalSeconds
    if ($ageSeconds -gt 300) {
        $statusStale = $true
        $issues.Add(("status.json is stale ({0:N0}s)" -f $ageSeconds))
        $issueCodes.Add('STATUS_STALE')
    }
}

if ($controllerAlive -and $statusStale) {
    try {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startController -NoOpenDashboard | Out-Null
        Start-Sleep -Seconds 3
        $newStatusAgeSeconds = if (Test-Path -LiteralPath $statusPath) {
            ((Get-Date) - (Get-Item -LiteralPath $statusPath).LastWriteTime).TotalSeconds
        } else { [double]::PositiveInfinity }
        if ($newStatusAgeSeconds -le 60) {
            Write-JsonNoBom $watchdogStatePath ([ordered]@{
                last_healthy_at = (Get-Date).ToUniversalTime().ToString('o')
                last_fingerprint = $null
                last_incident_at = $null
                suppressed_state = $null
                auto_restarted_stale_controller_at = (Get-Date).ToUniversalTime().ToString('o')
            })
            exit 0
        }
        $issues.Add('automatic stale-controller restart did not refresh status.json')
        $issueCodes.Add('STALE_CONTROLLER_AUTO_RESTART_FAILED')
    } catch {
        $issues.Add("automatic stale-controller restart failed: $($_.Exception.Message)")
        $issueCodes.Add('STALE_CONTROLLER_AUTO_RESTART_FAILED')
    }
}

if ($issues.Count -eq 0) {
    Write-JsonNoBom $watchdogStatePath ([ordered]@{
        last_healthy_at = (Get-Date).ToUniversalTime().ToString('o')
        last_fingerprint = $null
        last_incident_at = $null
        suppressed_state = $null
    })
    exit 0
}

$summary = $issues -join ' | '
$fingerprintSource = if ($issueCodes.Count -gt 0) {
    (($issueCodes | Sort-Object -Unique) -join '|')
} else {
    $summary
}
$fingerprint = Sha16 $fingerprintSource
$prior = Read-Json $watchdogStatePath
if ($prior -and [string]$prior.last_fingerprint -eq $fingerprint -and $prior.last_incident_at) {
    try {
        $last = [DateTime]::Parse([string]$prior.last_incident_at)
        if (((Get-Date).ToUniversalTime() - $last.ToUniversalTime()).TotalMinutes -lt 30) {
            exit 0
        }
    } catch {}
}

$id = 'INC-WATCHDOG-' + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ') + '-' + $fingerprint
$incidentPath = Join-Path $incidentDir ($id + '.json')
Write-JsonNoBom $incidentPath ([ordered]@{
    id = $id
    detectedAt = (Get-Date).ToUniversalTime().ToString('o')
    kind = 'WATCHDOG_FAILURE'
    bucket = $null
    detail = $summary
    controllerRoot = $root
    statusPath = $statusPath
    statePath = $statePath
    logPath = (Join-Path $root 'logs\controller.log')
})

Write-JsonNoBom $watchdogStatePath ([ordered]@{
    last_healthy_at = if ($prior) { $prior.last_healthy_at } else { $null }
    last_fingerprint = $fingerprint
    last_incident_at = (Get-Date).ToUniversalTime().ToString('o')
})

try {
    & msg.exe $env:USERNAME "R4.3.3 audit controller issue detected. Coordinator repair is starting: $summary" 2>$null | Out-Null
} catch {}

Start-Process -FilePath 'powershell.exe' `
    -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',$coordinatorWake,'-IncidentPath',$incidentPath) `
    -WindowStyle Hidden
