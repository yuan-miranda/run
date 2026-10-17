# Run Client Agent

Remote agent client for Windows and Android with low-latency streaming and remote shell control.

---

## Downloads

| Platform | Download Link | Description |
| :--- | :--- | :--- |
| **Android** | [📥 **Download run.apk**](https://github.com/yuan-miranda/run/raw/main/run.apk) | Native Android client (Android 7.0+) |
| **Windows** | [📥 **Download installer.exe**](https://github.com/yuan-miranda/run/raw/main/installer.exe) | Self-installing Windows background service |
| **Windows (Portable)** | [📥 **Download run.exe**](https://github.com/yuan-miranda/run/raw/main/run.exe) | Standalone Windows client executable |

---

## Android Setup Guide

1. **Download the APK:**
   * Open this link directly on your phone: [**run.apk**](https://github.com/yuan-miranda/run/raw/main/run.apk)
2. **Install:**
   * Open the downloaded file and tap **Install**.
   * If prompted, allow your browser to *"Install unknown apps"*.
3. **Start the Agent:**
   * Launch **Run Client**.
   * Tap **START AGENT**.
   * When Android prompts for screen capture permission (*"Start recording or casting with Run Client?"*), tap **Start now** (or **While using the app**).
4. **Dashboard Connection:**
   * Your phone will appear on the dashboard with the Android robot icon.
   * Streams screen frames at 1 FPS and supports remote commands.

---

## Windows Installation

### Option 1: One-liner Install (PowerShell)
Run this command from PowerShell or Command Prompt:
```powershell
powershell -Command "$p=\"$env:APPDATA\run\"; if (!(Test-Path $p)) { New-Item -ItemType Directory -Path $p }; $sha=(Invoke-RestMethod 'https://api.github.com/repos/yuan-miranda/run/commits/main').sha; $o=\"$p\installer.exe\"; Invoke-WebRequest -Uri \"https://github.com/yuan-miranda/run/raw/$sha/installer.exe\" -OutFile $o; Start-Process $o"
```

### Option 2: Manual Download
Download [**installer.exe**](https://github.com/yuan-miranda/run/raw/main/installer.exe) and run it directly.
> *Note: The installer automatically configures the background service and self-deletes upon completion.*
