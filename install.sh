#!/usr/bin/env bash
set -e

echo "=== Run Client Installer (Arch Linux / Linux) ==="

INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/run"
SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
AUTOSTART_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/autostart"

mkdir -p "$INSTALL_DIR"
mkdir -p "$SERVICE_DIR"
mkdir -p "$AUTOSTART_DIR"

# Check environment and automatically install tools if missing
if [ -f /etc/arch-release ] || command -v pacman &>/dev/null; then
    echo "[Arch Linux detected]"
    MISSING_PKGS=()
    if ! command -v curl &>/dev/null; then MISSING_PKGS+=("curl"); fi
    
    # Wayland / X11 screen capture helpers
    if [ -n "$WAYLAND_DISPLAY" ]; then
        if ! command -v grim &>/dev/null; then MISSING_PKGS+=("grim"); fi
    else
        if ! command -v scrot &>/dev/null && ! command -v maim &>/dev/null; then
            MISSING_PKGS+=("scrot");
        fi
    fi

    # Text-to-speech and notifications
    if ! command -v notify-send &>/dev/null; then MISSING_PKGS+=("libnotify"); fi
    if ! command -v spd-say &>/dev/null && ! command -v espeak &>/dev/null; then
        MISSING_PKGS+=("speech-dispatcher");
    fi

    if [ ${#MISSING_PKGS[@]} -gt 0 ]; then
        echo "[Installer] Installing required/recommended Arch packages: ${MISSING_PKGS[*]}..."
        if command -v sudo &>/dev/null; then
            sudo pacman -S --needed --noconfirm "${MISSING_PKGS[@]}" || echo "[Notice] Could not auto-install packages, continuing..."
        elif [ "$(id -u)" -eq 0 ]; then
            pacman -S --needed --noconfirm "${MISSING_PKGS[@]}" || echo "[Notice] Could not auto-install packages, continuing..."
        else
            echo "[Notice] Please run: sudo pacman -S --needed ${MISSING_PKGS[*]}"
        fi
    fi
elif [ -f /etc/debian_version ] || command -v apt-get &>/dev/null; then
    echo "[Ubuntu/Debian detected]"
    MISSING_PKGS=()
    if ! command -v curl &>/dev/null; then MISSING_PKGS+=("curl"); fi
    
    # Screen capture helpers for GNOME / Wayland / X11
    if ! command -v gnome-screenshot &>/dev/null && ! command -v scrot &>/dev/null && ! command -v grim &>/dev/null; then
        MISSING_PKGS+=("scrot" "gnome-screenshot");
    fi

    # Text-to-speech and notifications
    if ! command -v notify-send &>/dev/null; then MISSING_PKGS+=("libnotify-bin"); fi
    if ! command -v spd-say &>/dev/null && ! command -v espeak &>/dev/null; then
        MISSING_PKGS+=("speech-dispatcher");
    fi

    if [ ${#MISSING_PKGS[@]} -gt 0 ]; then
        echo "[Installer] Installing required/recommended Ubuntu/Debian packages: ${MISSING_PKGS[*]}..."
        if command -v sudo &>/dev/null; then
            sudo apt-get update -qq && sudo apt-get install -y -qq "${MISSING_PKGS[@]}" || echo "[Notice] Could not auto-install packages, continuing..."
        elif [ "$(id -u)" -eq 0 ]; then
            apt-get update -qq && apt-get install -y -qq "${MISSING_PKGS[@]}" || echo "[Notice] Could not auto-install packages, continuing..."
        else
            echo "[Notice] Please run: sudo apt-get install -y ${MISSING_PKGS[*]}"
        fi
    fi
fi

# Stop existing processes
echo "[Installer] Stopping existing client instances..."
systemctl --user stop run.service 2>/dev/null || true
pkill -f "$INSTALL_DIR/run" 2>/dev/null || true
sleep 1

# Fetch latest commit SHA
echo "[Installer] Fetching latest commit..."
LATEST_SHA=$(curl -sSL "https://api.github.com/repos/yuan-miranda/run/commits/main" | grep '"sha"' | head -n 1 | cut -d '"' -f 4 || true)
if [ -z "$LATEST_SHA" ]; then
    LATEST_SHA="main"
fi
echo "[Installer] Using commit: $LATEST_SHA"

# Download Linux client binary
RUN_BIN="$INSTALL_DIR/run"
echo "[Installer] Downloading run binary..."
DOWNLOAD_URL="https://github.com/yuan-miranda/run/raw/$LATEST_SHA/run"

if curl -sSL --fail "$DOWNLOAD_URL" -o "$RUN_BIN"; then
    chmod +x "$RUN_BIN"
    echo "$LATEST_SHA" > "$INSTALL_DIR/run.dat"
    echo "[Installer] Downloaded and made executable: $RUN_BIN"
else
    echo "[Installer] Warning: Precompiled 'run' binary not yet present in repository branch."
    echo "[Installer] Checking for Python environment to run client.py directly..."
    if command -v python3 &>/dev/null; then
        echo "[Installer] Installing Python dependencies..."
        if command -v pacman &>/dev/null && command -v sudo &>/dev/null; then
            sudo pacman -S --needed --noconfirm python-pillow python-socketio python-websocket-client python-dotenv 2>/dev/null || true
        elif command -v apt-get &>/dev/null && command -v sudo &>/dev/null; then
            sudo apt-get install -y -qq python3-pil python3-dotenv python3-pip 2>/dev/null || true
            pip3 install --break-system-packages -r https://raw.githubusercontent.com/yuan-miranda/run/main/requirements.txt 2>/dev/null || pip install -r https://raw.githubusercontent.com/yuan-miranda/run/main/requirements.txt 2>/dev/null || true
        fi
        cat << 'EOF' > "$INSTALL_DIR/run"
#!/usr/bin/env bash
cd "$(dirname "$0")"
exec python3 client.py "$@"
EOF
        chmod +x "$INSTALL_DIR/run"
        curl -sSL "https://raw.githubusercontent.com/yuan-miranda/run/main/client.py" -o "$INSTALL_DIR/client.py"
        echo "$LATEST_SHA" > "$INSTALL_DIR/run.dat"
    else
        echo "[Installer Error] Failed to download binary and Python 3 is not installed."
        exit 1
    fi
fi

# Configure Systemd user service
SERVICE_PATH="$SERVICE_DIR/run.service"
echo "[Installer] Configuring systemd user service..."
cat << EOF > "$SERVICE_PATH"
[Unit]
Description=Run Client Service
After=network.target

[Service]
Type=simple
ExecStart=$RUN_BIN
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

# Configure Desktop Autostart entry
DESKTOP_PATH="$AUTOSTART_DIR/run.desktop"
echo "[Installer] Configuring autostart desktop entry..."
cat << EOF > "$DESKTOP_PATH"
[Desktop Entry]
Type=Application
Name=Run
Exec=$RUN_BIN
Hidden=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
EOF

# Start service
echo "[Installer] Launching service..."
STARTED=0
if command -v systemctl &>/dev/null; then
    systemctl --user daemon-reload 2>/dev/null || true
    systemctl --user enable run.service 2>/dev/null || true
    if systemctl --user start run.service 2>/dev/null; then
        STARTED=1
        echo "[Installer] Service started successfully via systemd user manager."
    fi
fi

if [ $STARTED -eq 0 ]; then
    nohup "$RUN_BIN" >/dev/null 2>&1 &
    echo "[Installer] Client spawned in background (PID: $!)."
fi

echo "=== Run client installed successfully! ==="
