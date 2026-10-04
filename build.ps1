param (
    [string]$CommitMessage = "updated exe"
)

# 1. Get current Git SHA
$sha = (git rev-parse --short HEAD).Trim()
if (-not $sha) {
    Write-Error "Failed to fetch Git commit SHA."
    exit 1
}

Write-Host "Embedding Git Commit SHA: $sha" -ForegroundColor Green

# 2. Stamp run.ps1 (if $SCRIPT_VERSION present)
if (Test-Path "run.ps1") {
    $runPs1 = Get-Content "run.ps1" -Raw
    if ($runPs1 -match '\$SCRIPT_VERSION') {
        $runPs1Updated = $runPs1 -replace '\$SCRIPT_VERSION\s*=\s*"[^"]*"', "`$SCRIPT_VERSION = `"$sha`""
        Set-Content "run.ps1" -Value $runPs1Updated -NoNewline
    }
}

# 3. Stamp frames_dev/ss_control.ps1 (if exists)
if (Test-Path "frames_dev/ss_control.ps1") {
    $ssControlPs1 = Get-Content "frames_dev/ss_control.ps1" -Raw
    if ($ssControlPs1 -match '\$SCRIPT_VERSION') {
        $ssControlUpdated = $ssControlPs1 -replace '\$SCRIPT_VERSION\s*=\s*"[^"]*"', "`$SCRIPT_VERSION = `"$sha`""
        Set-Content "frames_dev/ss_control.ps1" -Value $ssControlUpdated -NoNewline
    }
}

# 4. Recompile run.exe & installer.exe with requested flags (-noConsole, -noOutput, -noError)
Write-Host "Compiling run.exe..." -ForegroundColor Cyan
Invoke-PS2EXE -InputFile "run.ps1" -OutputFile "run.exe" -noConsole -noOutput -noError

Write-Host "Compiling installer.exe..." -ForegroundColor Cyan
Invoke-PS2EXE -InputFile "installer.ps1" -OutputFile "installer.exe" -noConsole -noOutput -noError

# 5. Commit & push
$fullMsg = "$CommitMessage ($sha)"
Write-Host "Committing and pushing to Git: `"$fullMsg`"..." -ForegroundColor Yellow

git add -A
git commit -m "$fullMsg"
git push

Write-Host "Build, commit, and push complete! Version stamped: $sha" -ForegroundColor Green
