$p = "$env:APPDATA\run"
if (!(Test-Path $p)) { 
    New-Item -ItemType Directory -Path $p 
}

$sha = (Invoke-RestMethod 'https://api.github.com/repos/yuan-miranda/run/commits/main').sha
$o = "$p\installer.exe"

Invoke-WebRequest -Uri "https://github.com/yuan-miranda/run/raw/$sha/installer.exe" -OutFile $o
Start-Process $o