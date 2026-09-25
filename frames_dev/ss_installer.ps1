$installerContent = @'
$ErrorActionPreference = "Continue"

function Log($text) {
  Write-Host $text
}

Log "01 ss_installer.ps1 started"

# nircmd - screenshot
Log "02 Configuring NirCmd"

$NirCmdDir = "$env:TEMP\run\nircmd"
$NirCmdZip = "$env:TEMP\nircmd.zip"

Log "03 NirCmd directory: $NirCmdDir"
Log "04 NirCmd executable: $NirCmdDir\nircmd.exe"

if (!(Test-Path $NirCmdDir)) {
  Log "05 Creating NirCmd directory"

  $null = New-Item `
    $NirCmdDir `
    -ItemType Directory
}
else {
  Log "05 NirCmd directory already exists"
}

if (-not (Test-Path "$NirCmdDir\nircmd.exe")) {
  Log "06 NirCmd not found, downloading"

  $Url = "https://www.nirsoft.net/utils/nircmd.zip"

  try {
    Invoke-WebRequest `
      -Uri $Url `
      -OutFile $NirCmdZip `
      -ErrorAction Stop

    Log "07 NirCmd download completed"
  }
  catch {
    Log "07 ERROR: NirCmd download failed"
    Log "08 Error: $($_.Exception.Message)"
  }

  if (Test-Path $NirCmdZip) {
    Log "09 NirCmd ZIP found"
    Log "10 Loading compression library"

    Add-Type -AssemblyName System.IO.Compression.FileSystem

    try {
      Log "11 Extracting NirCmd ZIP"

      [System.IO.Compression.ZipFile]::ExtractToDirectory(
        $NirCmdZip,
        $NirCmdDir
      )

      Log "12 NirCmd ZIP extraction completed"
    }
    catch {
      Log "12 ERROR: NirCmd extraction failed"
      Log "13 Error: $($_.Exception.Message)"
    }

    if (Test-Path $NirCmdZip) {
      Log "14 Removing NirCmd ZIP"
      Remove-Item $NirCmdZip -Force
    }
  }
  else {
    Log "09 ERROR: NirCmd ZIP does not exist"
  }
}
else {
  Log "06 NirCmd already exists, skipping download"
}

if (Test-Path "$NirCmdDir\nircmd.exe") {
  Log "15 NirCmd verified successfully"
}
else {
  Log "15 ERROR: NirCmd executable is missing"
}

# magick - resize
Log "16 Configuring ImageMagick"

$MagickDir = "$env:TEMP\run\magick"

Log "17 ImageMagick directory: $MagickDir"
Log "18 ImageMagick executable: $MagickDir\magick.exe"

if (!(Test-Path $MagickDir)) {
  Log "19 Creating ImageMagick directory"

  $null = New-Item `
    $MagickDir `
    -ItemType Directory
}
else {
  Log "19 ImageMagick directory already exists"
}

if (-not (Test-Path "$MagickDir\magick.exe")) {
  Log "20 ImageMagick not found, downloading"

  $Url = "https://github.com/yuan-miranda/magick/raw/main/magick.exe"

  try {
    Invoke-WebRequest `
      -Uri $Url `
      -OutFile "$MagickDir\magick.exe" `
      -ErrorAction Stop

    Log "21 ImageMagick download completed"
  }
  catch {
    Log "21 ERROR: ImageMagick download failed"
    Log "22 Error: $($_.Exception.Message)"
  }
}
else {
  Log "20 ImageMagick already exists, skipping download"
}

if (Test-Path "$MagickDir\magick.exe") {
  Log "23 ImageMagick verified successfully"
}
else {
  Log "23 ERROR: ImageMagick executable is missing"
}

Log "24 ss_installer.ps1 finished"

'@

if (!(Test-Path "$env:TEMP\run")) {
  Write-Host "01 Creating TEMP run directory"

  $null = New-Item `
    "$env:TEMP\run" `
    -ItemType Directory
}
else {
  Write-Host "01 TEMP run directory already exists"
}

Write-Host "02 Writing ss_installer.ps1"

Set-Content `
  -Path "$env:TEMP\run\ss_installer.ps1" `
  -Value $installerContent `
  -Force

$self = Join-Path $env:TEMP "run\ss_installer.ps1"

Write-Host "03 Installer path: $self"

if (Test-Path $self) {
  Write-Host "04 Installer file verified"
  Write-Host "05 Starting ss_installer.ps1"

  Start-Process powershell.exe `
    -ArgumentList `
    '-NoProfile',
  '-ExecutionPolicy',
  'Bypass',
  '-Command',
  "& '$self'" `
    -WindowStyle Hidden `
    -Wait

  Write-Host "06 ss_installer.ps1 process finished"
}
else {
  Write-Host "04 ERROR: Installer file was not created"
}

Write-Host "07 Done"
