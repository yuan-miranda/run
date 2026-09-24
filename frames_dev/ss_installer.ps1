$installerContent = @'
# nircmd - screenshot
$NirCmdDir = "$env:TEMP\run\nircmd"
$NirCmdZip = "$env:TEMP\nircmd.zip"
if (!(Test-Path $NirCmdDir)) { $null = New-Item $NirCmdDir -ItemType Directory }
if (-not (Test-Path "$NirCmdDir\nircmd.exe")) {
    $Url = "https://www.nirsoft.net/utils/nircmd.zip"
    Invoke-WebRequest -Uri $Url -OutFile $NirCmdZip

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    try {
        [System.IO.Compression.ZipFile]::ExtractToDirectory($NirCmdZip, $NirCmdDir)
    }
    catch {}
    if (Test-Path $NirCmdZip) { Remove-Item $NirCmdZip -Force }
}

# magick - resize
$MagickDir = "$env:TEMP\run\magick"
if (!(Test-Path $MagickDir)) { $null = New-Item $MagickDir -ItemType Directory }
if (-not (Test-Path "$MagickDir\magick.exe")) {
    $Url = "https://github.com/yuan-miranda/magick/raw/main/magick.exe"
    Invoke-WebRequest -Uri $Url -OutFile "$MagickDir\magick.exe"
}
'@

if (!(Test-Path "$env:TEMP\run")) {
  $null = New-Item "$env:TEMP\run" -ItemType Directory
}
Set-Content -Path "$env:TEMP\run\ss_installer.ps1" -Value $installerContent -Force

$self = Join-Path $env:TEMP "run\ss_installer.ps1"
if (Test-Path $self) {
  Start-Process powershell.exe -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', "& '$self'" -Wait -WindowStyle Hidden
}
