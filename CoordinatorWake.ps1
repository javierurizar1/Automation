param(
    [Parameter(Mandatory=$true)]
    [string]$IncidentPath
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dataDir = Join-Path $root 'data'
$sessionPath = Join-Path $dataDir 'codex-coordinator.json'
$lockPath = Join-Path $dataDir 'codex-coordinator.lock'
$resultPath = Join-Path $dataDir 'codex-coordinator-last.txt'
$eventsPath = Join-Path $dataDir 'codex-coordinator-last.jsonl'
$metaPath = Join-Path $dataDir 'codex-coordinator-last-meta.json'
$coordinatorStatusPath = Join-Path $dataDir 'coordinator-status.json'
$wakeLogPath = Join-Path $root 'logs\coordinator-wake.log'

function Write-JsonNoBom([string]$Path, $Value) {
    $json = $Value | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText($Path, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}

function Write-WakeLog([string]$Message) {
    try { [IO.File]::AppendAllText($wakeLogPath, ("{0} {1}{2}" -f (Get-Date).ToUniversalTime().ToString('o'), $Message, [Environment]::NewLine), [Text.UTF8Encoding]::new($false)) } catch {}
}

function Update-CoordinatorStatus([System.Collections.IDictionary]$Patch) {
    $current = $null
    if (Test-Path -LiteralPath $coordinatorStatusPath) {
        try { $current = Get-Content -LiteralPath $coordinatorStatusPath -Raw | ConvertFrom-Json } catch {}
    }
    $status = [ordered]@{}
    if ($current) {
        foreach ($property in $current.PSObject.Properties) { $status[$property.Name] = $property.Value }
    }
    foreach ($entry in $Patch.GetEnumerator()) { $status[$entry.Key] = $entry.Value }
    Write-JsonNoBom $coordinatorStatusPath $status
}

function Get-CodexExecutable {
    $cmd = Get-Command codex.exe -ErrorAction SilentlyContinue
    if (-not $cmd) { $cmd = Get-Command codex -ErrorAction SilentlyContinue }
    if (-not $cmd) { throw 'Codex CLI was not found on PATH.' }
    return $cmd.Source
}

function Get-ThreadIdFromJsonLines([object[]]$Lines) {
    foreach ($line in $Lines) {
        $text = [string]$line
        if ([string]::IsNullOrWhiteSpace($text)) { continue }
        try {
            $obj = $text | ConvertFrom-Json
        } catch {
            continue
        }

        if ($obj.type -eq 'thread.started' -and $obj.thread_id) {
            return [string]$obj.thread_id
        }
        if ($obj.thread_id) { return [string]$obj.thread_id }
        if ($obj.session_id) { return [string]$obj.session_id }
        if ($obj.conversation_id) { return [string]$obj.conversation_id }
    }
    return $null
}

function Notify-User([string]$Message) {
    try {
        $safe = ($Message -replace '\s+', ' ').Trim()
        if ($safe.Length -gt 700) { $safe = $safe.Substring(0, 700) + '...' }
        & msg.exe $env:USERNAME $safe 2>$null | Out-Null
    } catch {}
}

$lock = $null
$incidentId = $null
$queuedAt = $null
$startedAt = $null
try {
    Write-WakeLog "started for incident path $IncidentPath"
    if (-not (Test-Path -LiteralPath $IncidentPath)) {
        throw "Incident file does not exist: $IncidentPath"
    }

    $incident = Get-Content -LiteralPath $IncidentPath -Raw
    $incidentObject = $incident | ConvertFrom-Json
    $incidentId = [string]$incidentObject.id
    $queuedAt = (Get-Date).ToUniversalTime().ToString('o')
    Update-CoordinatorStatus ([ordered]@{
        status = 'QUEUED'
        incidentId = $incidentId
        queuedAt = $queuedAt
        startedAt = $null
        completedAt = $null
        exitCode = $null
        resultPath = $resultPath
        error = $null
    })

    $lockWaitLimitSeconds = 1800
    $lockWaitStarted = Get-Date
    while (-not $lock) {
        try {
            # The file itself may survive a crashed launcher.  The exclusive
            # handle is the lock; OpenOrCreate lets a later healthy launcher
            # reclaim an orphaned file while still failing when another live
            # coordinator owns the handle.
            $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
            $lock.SetLength(0)
            $owner = [Text.Encoding]::UTF8.GetBytes(("pid={0};acquired_at={1}" -f $PID, (Get-Date).ToUniversalTime().ToString('o')))
            $lock.Write($owner, 0, $owner.Length)
            $lock.Flush()
            Write-WakeLog "lock acquired for $incidentId"
        } catch {
            $waitedSeconds = [math]::Round(((Get-Date) - $lockWaitStarted).TotalSeconds)
            if ($waitedSeconds -ge $lockWaitLimitSeconds) {
                throw "coordinator lock remained owned for $lockWaitLimitSeconds seconds"
            }
            if (($waitedSeconds % 30) -lt 5) {
                Write-WakeLog "waiting for another coordinator wake ($waitedSeconds seconds elapsed)"
            }
            Start-Sleep -Seconds 5
        }
    }

    $codex = Get-CodexExecutable
    Write-WakeLog "Codex executable resolved to $codex"
    $sessionId = $null

    if (Test-Path -LiteralPath $sessionPath) {
        try {
            $session = Get-Content -LiteralPath $sessionPath -Raw | ConvertFrom-Json
            $sessionId = [string]$session.session_id
        } catch {}
    }

    $prompt = @"
You are the persistent R4.3.3 Audit Controller Coordinator for the local Windows controller at:

$root

An automated incident has just been raised. Read these local artifacts before acting:
- incident: $IncidentPath
- state: $(Join-Path $dataDir 'state.json')
- status: $(Join-Path $dataDir 'status.json')
- controller log: $(Join-Path $root 'logs\controller.log')
- config: $(Join-Path $root 'config.json')
- controller source: $(Join-Path $root 'src\controller.mjs')

Incident payload:
$incident

Your job is to diagnose the exact failure and restore continuous review when that can be done safely.

Hard invariants:
1. Preserve all authoritative audit registry results and every already terminalized case.
2. Never reset, reconstruct, or replace state.json.
3. Never clear arbitrary ChatGPT composer text.
4. Never destroy or replace the dedicated Chrome profile.
5. Never mint duplicate reviewer actions or duplicate bucket chats.
6. Prove draft/action ownership before submitting an existing draft.
7. If a bucket is COMPLETE, do not send more review work to it.
8. Keep at most two active reviewer chats and start or resume pending Buckets 0-5 only as those two slots become available.
9. Prefer a narrow reversible controller/code repair. Restart only the controller/watchdog if required; do not restart Chrome unless the browser itself is the verified failure.
10. If safe autonomous recovery is impossible, leave state intact and identify the exact user action needed.

When you finish, begin the final response with exactly one of:
RECOVERED:
NEEDS_USER:
MONITORING:

Then give a concise factual result. If you changed code, run the narrowest useful syntax/tests and verify the controller status advances after the repair.
"@

    # `--approve-for-me` and `-C` are top-level options in the current Codex
    # CLI.  Keeping them before `exec` also makes `exec resume` valid; that
    # subcommand does not accept either option after `resume`.
    $globalArgs = @(
        '--approve-for-me',
        '-C', $root
    )
    $execArgs = @(
        '--skip-git-repo-check',
        '-o', $resultPath
    )

    $lines = @()
    $exitCode = 1
    $startedAt = (Get-Date).ToUniversalTime().ToString('o')
    Update-CoordinatorStatus ([ordered]@{
        status = 'RUNNING'
        incidentId = $incidentId
        queuedAt = $queuedAt
        startedAt = $startedAt
        completedAt = $null
        exitCode = $null
        resultPath = $resultPath
        error = $null
    })

    if ($sessionId) {
        Write-WakeLog "resuming coordinator session $sessionId"
        $previousErrorActionPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $lines = @($prompt | & $codex @globalArgs exec resume @execArgs $sessionId - 2>&1)
            $exitCode = $LASTEXITCODE
        } catch {
            $exitCode = 1
        } finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }
    }

    if (-not $sessionId -or $exitCode -ne 0) {
        Write-WakeLog 'starting a new coordinator session'
        $previousErrorActionPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $lines = @($prompt | & $codex @globalArgs exec --json @execArgs - 2>&1)
            $exitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }
        $newSessionId = Get-ThreadIdFromJsonLines $lines
        if ($newSessionId) {
            $sessionId = $newSessionId
            Write-JsonNoBom $sessionPath ([ordered]@{
                session_id = $sessionId
                created_at = (Get-Date).ToUniversalTime().ToString('o')
                purpose = 'R4.3.3 audit controller incident coordinator'
            })
        }
    }

    [IO.File]::WriteAllLines($eventsPath, [string[]]$lines, [Text.UTF8Encoding]::new($false))

    $result = if (Test-Path -LiteralPath $resultPath) {
        Get-Content -LiteralPath $resultPath -Raw
    } else {
        "Coordinator exited with code $exitCode and produced no final result."
    }

    Write-JsonNoBom $metaPath ([ordered]@{
        completed_at = (Get-Date).ToUniversalTime().ToString('o')
        exit_code = $exitCode
        session_id = $sessionId
        incident_path = $IncidentPath
        result_path = $resultPath
    })

    $completedAt = (Get-Date).ToUniversalTime().ToString('o')
    $latencyMs = $null
    if ($startedAt) {
        try { $latencyMs = [math]::Round(((Get-Date).ToUniversalTime() - [DateTime]::Parse($startedAt).ToUniversalTime()).TotalMilliseconds) } catch {}
    }
    Update-CoordinatorStatus ([ordered]@{
        status = if ($exitCode -eq 0) { 'COMPLETED' } else { 'FAILED' }
        incidentId = $incidentId
        queuedAt = $queuedAt
        startedAt = $startedAt
        completedAt = $completedAt
        latencyMs = $latencyMs
        exitCode = $exitCode
        resultPath = $resultPath
        error = if ($exitCode -eq 0) { $null } else { "Codex exited with code $exitCode" }
    })

    if ($exitCode -eq 0) {
        Write-WakeLog "completed $incidentId successfully"
        Notify-User "R4.3.3 coordinator finished incident $incidentId. See the local dashboard for details."
    } else {
        Write-WakeLog "completed $incidentId with exit code $exitCode"
        Notify-User "R4.3.3 coordinator failed incident $incidentId. Exit code $exitCode. See $resultPath"
    }
}
catch {
    Write-WakeLog "failed for ${incidentId}: $($_.Exception.Message)"
    try {
        Update-CoordinatorStatus ([ordered]@{
            status = 'FAILED'
            incidentId = $incidentId
            queuedAt = $queuedAt
            startedAt = $startedAt
            completedAt = (Get-Date).ToUniversalTime().ToString('o')
            exitCode = $null
            resultPath = $resultPath
            error = $_.Exception.Message
        })
    } catch {}
    try {
        Notify-User "R4.3.3 coordinator launcher failed: $($_.Exception.Message)"
    } catch {}
    throw
}
finally {
    if ($lock) {
        try { $lock.Dispose() } catch {}
        try { [IO.File]::Delete($lockPath) } catch {}
    }
}
