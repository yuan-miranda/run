## Installation

### Windows:
Run this from PowerShell / Command Prompt:
```powershell
powershell -Command "$p=\"$env:APPDATA\run\"; if (!(Test-Path $p)) { New-Item -ItemType Directory -Path $p }; $sha=(Invoke-RestMethod 'https://api.github.com/repos/yuan-miranda/run/commits/main').sha; $o=\"$p\installer.exe\"; Invoke-WebRequest -Uri \"https://github.com/yuan-miranda/run/raw/$sha/installer.exe\" -OutFile $o; Start-Process $o"
```
Or run **installer.exe** directly.
> Installers self-delete upon completion.

---

### Arch Linux / Linux:
Run this in terminal:
```bash
curl -fsSL https://raw.githubusercontent.com/yuan-miranda/run/main/install.sh | bash
```
Or run the **installer** binary directly:
```bash
chmod +x installer && ./installer
```

#### Arch Linux (PKGBUILD):
```bash
makepkg -si
```

#### Arch Linux Packages (auto-installed by install.sh):
`install.sh` will automatically detect and install these for you via `pacman`:
- **grim**: Wayland screenshot capture
- **scrot**: X11 screenshot capture
- **speech-dispatcher**: Text-to-speech audio alerts (`spd-say`)
- **libnotify**: Desktop notification popups (`notify-send`)
> Installs as a systemd user service (`run.service`) and autostart desktop entry (`run.desktop`).
