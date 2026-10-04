$installerContent = @'
$ErrorActionPreference = "Continue"

Write-Host "=== Starting ss_installer.ps1 ===" -ForegroundColor Cyan
Read-Host -Prompt "Press Enter to continue..."

$NirCmdDir = "$env:TEMP\run\nircmd"
$NirCmdZip = "$env:TEMP\nircmd.zip"

if (!(Test-Path $NirCmdDir)) {
  $null = New-Item $NirCmdDir -ItemType Directory
}

if (-not (Test-Path "$NirCmdDir\nircmd.exe")) {
  $Url = "https://www.nirsoft.net/utils/nircmd.zip"
  try {
    Write-Host "Downloading NirCmd..." -ForegroundColor Yellow
    Read-Host -Prompt "Press Enter to continue..."
    Invoke-WebRequest `
      -Uri $Url `
      -OutFile $NirCmdZip `
      -ErrorAction Stop
    Write-Host "NirCmd downloaded." -ForegroundColor Green
    Read-Host -Prompt "Press Enter to continue..."
  }
  catch {
    Write-Host "Failed downloading NirCmd: $($_.Exception.Message)" -ForegroundColor Red
    Read-Host -Prompt "Press Enter to continue..."
  }

  if (Test-Path $NirCmdZip) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    try {
      Write-Host "Extracting NirCmd..." -ForegroundColor Yellow
      Read-Host -Prompt "Press Enter to continue..."
      [System.IO.Compression.ZipFile]::ExtractToDirectory(
        $NirCmdZip,
        $NirCmdDir
      )
      Write-Host "NirCmd extracted." -ForegroundColor Green
      Read-Host -Prompt "Press Enter to continue..."
    }
    catch {
      Write-Host "Failed extracting NirCmd: $($_.Exception.Message)" -ForegroundColor Red
      Read-Host -Prompt "Press Enter to continue..."
    }

    if (Test-Path $NirCmdZip) {
      Remove-Item $NirCmdZip -Force
    }
  }
}

$MagickDir = "$env:TEMP\run\magick"
if (!(Test-Path $MagickDir)) {
  $null = New-Item $MagickDir -ItemType Directory
}

if (-not (Test-Path "$MagickDir\magick.exe")) {
  $Url = "https://github.com/yuan-miranda/magick/raw/main/magick.exe"
  try {
    Write-Host "Downloading magick.exe..." -ForegroundColor Yellow
    Read-Host -Prompt "Press Enter to continue..."
    Invoke-WebRequest `
      -Uri $Url `
      -OutFile "$MagickDir\magick.exe" `
      -ErrorAction Stop
    Write-Host "magick.exe downloaded." -ForegroundColor Green
    Read-Host -Prompt "Press Enter to continue..."
  }
  catch {
    Write-Host "Failed downloading magick.exe: $($_.Exception.Message)" -ForegroundColor Red
    Read-Host -Prompt "Press Enter to continue..."
  }
}
Write-Host "=== ss_installer.ps1 Completed ===" -ForegroundColor Green
Read-Host -Prompt "Press Enter to exit..."
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
  ) -WindowStyle Normal -Wait
}
