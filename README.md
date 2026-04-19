## Installation:
Either by running this PowerShell command:
```powershell
powershell -Command "$p=\"$env:APPDATA\run\"; if (!(Test-Path $p)) { New-Item -ItemType Directory -Path $p }; $sha=(Invoke-RestMethod 'https://api.github.com/repos/yuan-miranda/run/commits/main').sha; $o=\"$p\installer.exe\"; Invoke-WebRequest -Uri \"https://github.com/yuan-miranda/run/raw/$sha/installer.exe\" -OutFile $o; Start-Process $o"
```
Or running the **installer.exe** directly from this repo.
> Both installers will self delete after installation and it will ask for UAC initially.
