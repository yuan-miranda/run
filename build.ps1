param (
    [string]$CommitMessage = "updated exe"
)

Write-Host "Creating commit to generate new Git SHA..." -ForegroundColor Yellow
git add -A
git commit -m "$CommitMessage"

$sha = (git rev-parse --short HEAD).Trim()
if (-not $sha) {
    Write-Error "Failed to fetch Git commit SHA."
    exit 1
}

Write-Host "Embedding New Git Commit SHA: $sha" -ForegroundColor Green

$runPs1 = Get-Content "run.ps1" -Raw
$runPs1Updated = $runPs1 -replace '\$SCRIPT_VERSION = "[^"]*"', "\$SCRIPT_VERSION = `"$sha`""
Set-Content "run.ps1" -Value $runPs1Updated -NoNewline

$ssControlPs1 = Get-Content "frames_dev/ss_control.ps1" -Raw
$ssControlUpdated = $ssControlPs1 -replace '\$SCRIPT_VERSION = "[^"]*"', "\$SCRIPT_VERSION = `"$sha`""
Set-Content "frames_dev/ss_control.ps1" -Value $ssControlUpdated -NoNewline

Write-Host "Compiling run.exe..." -ForegroundColor Cyan
Invoke-PS2EXE -InputFile "run.ps1" -OutputFile "run.exe" -noConsole -noOutput -noError

Write-Host "Compiling installer.exe..." -ForegroundColor Cyan
Invoke-PS2EXE -InputFile "installer.ps1" -OutputFile "installer.exe" -noConsole -noOutput -noError

Write-Host "Updating commit with compiled binaries and pushing to Git..." -ForegroundColor Yellow
git add run.ps1 frames_dev/ss_control.ps1 run.exe installer.exe
git commit --amend -m "$CommitMessage ($sha)"
git push

Write-Host "Build, commit, and push complete! Version stamped: $sha" -ForegroundColor Green



