Write-Host "1. Creating base temporary directory"
if (!(Test-Path "$env:TEMP\run")) {
  $null = New-Item "$env:TEMP\run" -ItemType Directory
}

Write-Host "2. Writing inner installer script contents to disk"
$installerContent = @'
Write-Host "2.1. Verifying or creating NirCmd directory"
$NirCmdDir = "$env:TEMP\run\nircmd"
$NirCmdZip = "$env:TEMP\nircmd.zip"
if (!(Test-Path $NirCmdDir)) { $null = New-Item $NirCmdDir -ItemType Directory }

if (-not (Test-Path "$NirCmdDir\nircmd.exe")) {
    $Url = "https://www.nirsoft.net/utils/nircmd.zip"
    Write-Host "2.2. Downloading NirCmd zip archive"
    Invoke-WebRequest -Uri $Url -OutFile $NirCmdZip

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    try {
        Write-Host "2.3. Extracting NirCmd package"
        [System.IO.Compression.ZipFile]::ExtractToDirectory($NirCmdZip, $NirCmdDir)
    }
    catch {}
    if (Test-Path $NirCmdZip) { Remove-Item $NirCmdZip -Force }
}

Write-Host "2.4. Verifying or creating ImageMagick directory"
$MagickDir = "$env:TEMP\run\magick"
if (!(Test-Path $MagickDir)) { $null = New-Item $MagickDir -ItemType Directory }

if (-not (Test-Path "$MagickDir\magick.exe")) {
    $Url = "https://github.com/yuan-miranda/magick/raw/main/magick.exe"
    Write-Host "2.5. Downloading magick.exe binary"
    Invoke-WebRequest -Uri $Url -OutFile "$MagickDir\magick.exe"
}
'@

Set-Content -Path "$env:TEMP\run\ss_installer.ps1" -Value $installerContent -Force

Write-Host "3. Executing inner installer script with bypass policy"
$self = Join-Path $env:TEMP "run\ss_installer.ps1"
if (Test-Path $self) {
  Start-Process powershell.exe -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', "& '$self'" -Wait
}
