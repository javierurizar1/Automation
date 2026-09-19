param(
    [string]$ProjectRoot = "C:\\Users\\javi_\\.codex\\Apps\\R433AuditController",
    [string]$RepoUrl = "https://github.com/javierurizar1/Automation.git",
    [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $ProjectRoot)) { throw "Project root not found: $ProjectRoot" }
Set-Location -LiteralPath $ProjectRoot

Write-Host "Project root: $ProjectRoot"
Write-Host "Repository:   $RepoUrl"
Write-Host "Branch:       $Branch"

if (-not (Test-Path -LiteralPath ".git")) { git init }

$origin = git remote get-url origin 2>$null
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($origin)) {
    git remote add origin $RepoUrl
} elseif ($origin -ne $RepoUrl) {
    git remote set-url origin $RepoUrl
}

$ignoreLines = @(
    "node_modules/",
    "data/*.json",
    "data/*.log",
    "logs/",
    "*.log",
    ".user-data/",
    "browser-profile/",
    "cookies*",
    "session*",
    "*.token",
    "*.secret",
    ".env",
    ".env.*"
)

$gitignorePath = Join-Path $ProjectRoot ".gitignore"
if (-not (Test-Path -LiteralPath $gitignorePath)) { New-Item -ItemType File -Path $gitignorePath | Out-Null }
$currentIgnore = Get-Content -LiteralPath $gitignorePath -ErrorAction SilentlyContinue
foreach ($line in $ignoreLines) {
    if ($currentIgnore -notcontains $line) { Add-Content -LiteralPath $gitignorePath -Value $line -Encoding UTF8 }
}

git fetch origin $Branch
$remoteExists = $true
git rev-parse --verify "origin/$Branch" 1>$null 2>$null
if ($LASTEXITCODE -ne 0) { $remoteExists = $false }

if ($remoteExists) {
    $currentBranch = git branch --show-current
    if ([string]::IsNullOrWhiteSpace($currentBranch)) {
        git switch -C $Branch "origin/$Branch"
    } elseif ($currentBranch -ne $Branch) {
        git switch $Branch 2>$null
        if ($LASTEXITCODE -ne 0) { git switch -c $Branch "origin/$Branch" }
    }
    git pull --rebase origin $Branch
} else {
    git switch -C $Branch
}

$dangerousNames = @(".env", ".env.local", "credentials.json", "client_secret.json", "cookies.json", "session.json")
foreach ($name in $dangerousNames) {
    Get-ChildItem -LiteralPath $ProjectRoot -Recurse -Force -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq $name } |
        ForEach-Object { Write-Warning "Potential private/secret file exists and should NOT be committed: $($_.FullName)" }
}

git add -A
git reset -- data logs .user-data browser-profile 2>$null

Write-Host "Staged changes:"
git diff --cached --stat
git diff --cached --check

git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
    git commit -m "Import local R4.3.3 Audit Controller source"
    git push -u origin $Branch
    Write-Host "Local source imported successfully."
} else {
    Write-Host "No local source changes to commit."
}
