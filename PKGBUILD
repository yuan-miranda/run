# Maintainer: yuan-miranda
pkgname=run-client
pkgver=1.0.0
pkgrel=1
pkgdesc="Cross-platform remote client for Run dashboard"
arch=('x86_64')
url="https://github.com/yuan-miranda/run"
license=('MIT')
depends=('python' 'python-pillow' 'python-socketio' 'python-websocket-client' 'python-dotenv')
optdepends=(
    'grim: Wayland screen capture support'
    'scrot: X11 screen capture support'
    'speech-dispatcher: Text-to-speech support (spd-say)'
    'espeak: Text-to-speech fallback'
    'libnotify: Desktop notification support (notify-send)'
)
source=("$pkgname::git+https://github.com/yuan-miranda/run.git")
md5sums=('SKIP')

package() {
    cd "$srcdir/$pkgname"
    
    install -d "$pkgdir/opt/run"
    install -m 755 client.py "$pkgdir/opt/run/client.py"
    
    # Wrapper script
    install -d "$pkgdir/usr/bin"
    cat << 'EOF' > "$pkgdir/usr/bin/run-client"
#!/usr/bin/env bash
exec python3 /opt/run/client.py "$@"
EOF
    chmod 755 "$pkgdir/usr/bin/run-client"
    
    # Systemd user service
    install -d "$pkgdir/usr/lib/systemd/user"
    cat << 'EOF' > "$pkgdir/usr/lib/systemd/user/run.service"
[Unit]
Description=Run Client Service
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/run-client
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

    # Autostart desktop entry
    install -d "$pkgdir/etc/xdg/autostart"
    cat << 'EOF' > "$pkgdir/etc/xdg/autostart/run.desktop"
[Desktop Entry]
Type=Application
Name=Run
Exec=/usr/bin/run-client
Hidden=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
EOF
}
