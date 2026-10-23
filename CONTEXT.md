# Repository Context — `run`

> Comprehensive orientation document for the entire repository. Intended for new
> contributors, reviewers, and AI agents working on this codebase. Keep this file
> updated when architecture, endpoints, or event contracts change.

---

## 1. Project Overview

**`run`** is a Windows remote-monitoring and administration toolkit consisting of
three cooperating parts:

1. **Central Server (`app.py`)** — A Flask + Socket.IO controller hosted on a VPS
   (`https://runx.ddns.net`, port **5002**, optional HTTPS via `cert.pem`/`key.pem`).
   It serves a password-protected web dashboard and brokers real-time WebSocket
   messaging with connected client agents.
2. **Web Dashboard (`templates/index.html` + `static/`)** — A single-page browser UI
   ("Windows Central") for managing all connected nodes: live screenshot streams,
   remote PowerShell command execution, image/audio popups, an FTP-style remote
   filesystem browser, visibility controls, and audit logs.
3. **Windows Client Agent (`client.py` → `run.exe`)** — A persistent background daemon
   installed on target Windows machines. It connects back to the server over
   Socket.IO and performs screen capture streaming, screenshot upload, command
   execution, dialog/audio playback, and remote file operations.

Distribution is automated: `installer.py` → `installer.exe` performs a self-deleting,
UAC-elevating install that registers persistence scheduled tasks; `build.py` compiles
both binaries with PyInstaller (locally via `build.bat` or in CI via GitHub Actions).

**Repository:** `github.com/yuan-miranda/run` · **Default branch:** `main`

---

## 2. Directory Structure

```
/
├── app.py                     # Flask/Socket.IO central server (~1.5k lines)
├── client.py                  # Windows client daemon (~1.1k lines)
├── installer.py               # Self-deleting Windows installer script
├── build.py                   # PyInstaller build pipeline (etches secrets, compiles EXEs)
├── build.bat                  # One-shot local build wrapper (runs build.py)
├── requirements.txt           # Python dependencies
├── README.md                  # End-user one-liner install instructions (PowerShell)
├── CONTEXT.md                 # This file
├── .gitignore                 # Ignores .env, *.db, uploaded_frames/, client_config.py, build artifacts
├── run.exe                    # Compiled client binary (committed artifact)
├── installer.exe              # Compiled installer binary (committed artifact)
├── templates/
│   └── index.html             # Dashboard SPA shell (672 lines, Bootstrap Icons CDN, "night" theme)
├── static/
│   ├── styles.css             # Dashboard styling / theming
│   ├── runApp.js              # RunApp controller — main dashboard module (4,875 lines)
│   ├── framesApp.js           # FramesApp — screenshot stream & history viewer (1,143 lines)
│   └── modeSwitcher.js        # Mode switching between RUN/FRAMES views + shared RunUtils (173 lines)
└── .github/workflows/
    └── build-binaries.yml     # CI: builds Windows binaries on push to main
```

Runtime-generated (gitignored): `database.db` (SQLite), `uploaded_frames/`
(screenshot storage per user), `client_config.py` (build-time etched secrets),
`build/`, `dist/`, `*.spec`.

---

## 3. Component Reference

### 3.1 `app.py` — Central Server

- **Stack:** Flask ≥3.0, flask-socketio ≥5.3, auto-detected async mode
  (`gevent`/`eventlet`/`threading`, override with `SOCKETIO_ASYNC_MODE`), SQLite,
  python-dotenv. CORS wide open (`cors_allowed_origins="*"`).
- **Required env:** `DASHBOARD_PASSWORD` (server refuses to start without it).
  Optional: `ACCESS_LOGS_PASSWORD` (falls back to `DASHBOARD_PASSWORD`),
  `SSL_CERT`/`SSL_KEY`.
- **Auth model:** HTTP routes use the `@require_password` decorator (password supplied
  by the dashboard); `/api/auth/login` validates it. Socket.IO clients authenticate by
  emitting `register` with a `CLIENT_KEY` matching `DASHBOARD_PASSWORD`. A separate
  `register_dashboard` event tags browser sessions.
- **State:** Thread-safe in-memory dicts guarded by locks — `active_clients`
  (sid→username), `authenticated_sids`, `upload_counters`, and pending request maps
  (`pending_screenshot_requests`, `pending_fs_requests`) used to correlate synchronous
  REST calls with asynchronous WebSocket responses (request ID + `threading.Event`,
  ~10 s timeout).
- **Database (`init_db()` at import):** three SQLite tables —
  `clients` (registration/visibility metadata), `operations_log` (admin action audit),
  `access_logs` (dashboard access records with IP geolocation + parsed User-Agent).
- **Security helpers:** `is_safe_name()` regex-guards usernames/filenames against path
  traversal and SQL injection; `prune_old_frames()` caps stored frames at
  `MAX_FRAMES_PER_USER = 1000` per user folder under `uploaded_frames/`.

#### REST API (all JSON; password-protected unless noted)

| Endpoint | Purpose |
|---|---|
| `GET /` | Serve dashboard (`index.html`) |
| `POST /api/auth/login` | Verify dashboard password |
| `POST /api/access_logs/verify`, `GET /api/access_logs` | Access-log gate & listing |
| `GET /api/clients` | Connected + known clients with status |
| `GET /api/frames/<user>`, `POST /api/frames/delete`, `GET /frames/<user>/<file>` | Frame history read/delete/serving |
| `POST /api/capture` | Toggle continuous screen streaming per client |
| `POST /api/screenshot/take` | On-demand single screenshot (blocks until client replies) |
| `POST /api/visibility` | Show/hide a client in the dashboard |
| `POST /api/command` | Dispatch remote command (shell/PowerShell) to a client |
| `POST /api/image`, `POST /api/audio` | Push image dialog / audio blast to a client |
| `POST /api/fs/list\|read\|write\|delete\|mkdir\|rename` | Remote filesystem ops via `dispatch_fs_request()` |
| `GET /api/logs/<user>`, `POST /api/logs/<user>/clear` | Per-client operation audit log |

#### Socket.IO events (server side)

`register_dashboard`, `register`, `disconnect`, `heartbeat`, `upload_frame`,
`capture_screenshot_res`, and `fs_*_res` (`list/read/write/delete/mkdir/rename`).
Server→client emissions: `set_capture`, `take_screenshot`, `exec_command`,
`display_image`, `play_audio`, `fs_*_req`.

#### Entry point

`python app.py` → `socketio.run(app, host="0.0.0.0", port=5002)` with automatic SSL
if cert/key files exist.

### 3.2 `client.py` — Windows Agent (`run.exe`)

- **Windows-only:** uses `ctypes.windll` (kernel32/user32/shell32), `ImageGrab`,
  named mutex `run_py_mutex` for single-instance enforcement (exits silently if a
  second copy launches).
- **Identity:** persists an 8-char UUID in `%APPDATA%\Microsoft\run\run.txt`; version
  hash in `run.dat`. Composite username format: `USERNAME-<8charid>-W`
  (e.g. `john-a1b2c3d4-W`).
- **Config injection:** tries to import `client_config` (generated by `build.py`) for
  `CLIENT_KEY` and `CLIENT_VERSION`; falls back to env/`dev` when run as a script.
- **Connection:** `socketio.Client` with `ssl_verify=False`, auto-reconnect
  (2–10 s backoff) to `VPS_URL` (default `https://runx.ddns.net`). Registers with
  key, sends periodic heartbeats with LAN IP.
- **Subsystems:**
  - *Streaming:* `capture_loop()` grabs the screen and emits `upload_frame` while
    `capture_active` (toggled by `set_capture`).
  - *Screenshots:* `take_and_upload_screenshot()` responds to `take_screenshot` with
    `capture_screenshot_res` (base64 PNG, correlated by request ID).
  - *Commands:* `on_exec_command()` runs shell commands via `subprocess`; commands
    starting with `powershell` are launched through `powershell.exe`.
  - *UI payloads:* `_show_image_dialog()` renders modal dialogs (via PowerShell/.NET
    WinForms on a worker thread) for `display_image`; audio handling includes
    embedded C# (`AudioDeviceHelper`) to max out the speaker before `_play_audio_clip()`
    blasts server-pushed audio.
  - *Remote FS (FTP):* `get_windows_drives()`, `scan_directory()` (capped at 5000
    items), `read_file_preview()` (≤512 KB), `write_file()`, `delete_path()`,
    `make_directory()`, `rename_path()` — each wired to an `fs_*_req` handler that
    replies with the matching `fs_*_res` event. Handles drive-letter enumeration and
    8.3 short-path resolution (`_get_short_path`).
  - *Resilience:* `heartbeat_loop()` plus OS-level keepalive tasks (see installer).

### 3.3 `installer.py` — Installer (`installer.exe`)

- Requests UAC elevation via `ShellExecuteW "runas"` on fresh installs (skipped for
  updates when `run.dat` exists).
- Stops running `run.exe` processes and pauses the watchdog task before replacing files.
- Copies the client binary into `%APPDATA%\Microsoft\run\` and registers **three
  scheduled tasks**: `WinRun` (logon startup), `WinRunInstaller` (periodic update
  check pulling the latest `installer.exe` from GitHub raw at the current `main`
  commit SHA), and `WinRunChecker` (1-minute keepalive so the client never goes
  offline).
- **Self-deletes** upon completion (matches README claim).

### 3.4 `build.py` / `build.bat` — Build Pipeline

1. Loads `.env` manually (no external deps).
2. Reads `DASHBOARD_PASSWORD` → `CLIENT_KEY`; resolves version from `CLIENT_VERSION`
   env or `git rev-parse --short HEAD`.
3. Writes gitignored `client_config.py` with the etched values.
4. Runs PyInstaller with `--onefile --noconsole` to produce `run.exe` (from
   `client.py`) and `installer.exe` (from `installer.py`).
5. Copies binaries to repo root and cleans `build/`/`dist/`.

### 3.5 Frontend (`templates/`, `static/`)

- **`index.html`** — SPA shell, dark `"night"` theme, Bootstrap Icons via CDN, loads
  the three JS modules and `styles.css`.
- **`runApp.js` (RunApp)** — Core controller organized in commented blocks: app state
  & constants, client grid rendering, command dispatch UI, interactive dialogs
  (speech synthesis, message popups, full-screen image viewer, audio blaster), FTP
  browser, capture controls, and admin audit log panels. Talks to the REST API using
  the dashboard password kept client-side.
- **`framesApp.js` (FramesApp)** — High-performance frame viewer: pan/zoom canvas
  viewport, image preloading, folder/user switching, real-time WebSocket frame
  ingestion, playback of screenshot history. State persisted under
  `localStorage` key `framesViewerState`.
- **`modeSwitcher.js`** — Toggles between the RUN control grid and FRAMES browser
  views, global keyboard shortcuts, and exposes shared helpers on `window.RunUtils`
  (e.g. dynamic dropdown width measurement to avoid layout shift).
- Naming convention: IIFE module pattern (`const RunApp = (() => {...})()`),
  `'use strict'`, JSDoc on functions, box-drawing comment separators (`──`, `═══`).

---

## 4. End-to-End Data Flow

```
Browser Dashboard ──HTTPS/REST──▶ Flask API (app.py) ──Socket.IO──▶ run.exe clients
       ▲                               │                              │
       └────── Socket.IO (frames) ◀────┴── uploaded_frames/, SQLite ◀─┘
                                        (screenshots, logs, client registry)
```

- Synchronous-feeling remote operations (single screenshot, FS browsing) are
  implemented as REST calls that block on a `threading.Event` until the client's
  async WebSocket response arrives with the matching request ID.
- Continuous streaming flows client → `upload_frame` → disk + broadcast to the
  requesting dashboard socket.

---

## 5. Configuration & Environment

| Variable | Used by | Required | Notes |
|---|---|---|---|
| `DASHBOARD_PASSWORD` | app.py, build.py | **Yes** | Server refuses to boot without it; doubles as `CLIENT_KEY` etched into binaries |
| `ACCESS_LOGS_PASSWORD` | app.py | No | Falls back to `DASHBOARD_PASSWORD` |
| `SOCKETIO_ASYNC_MODE` | app.py | No | Force gevent/eventlet/threading |
| `SSL_CERT` / `SSL_KEY` | app.py | No | Defaults `cert.pem`/`key.pem`; enables HTTPS when present |
| `VPS_URL` | client.py | No | Default `https://runx.ddns.net` |
| `CLIENT_VERSION` | build.py (CI sets to commit SHA) | No | Shortened to 7 chars |

`.env` is gitignored; `client_config.py` is generated at build time and gitignored.

---

## 6. Development Workflow

- **Run the server:** `pip install -r requirements.txt`, set `DASHBOARD_PASSWORD` in
  `.env`, then `python app.py` → dashboard at `http://localhost:5002`.
- **Run the client (dev):** `python client.py` on Windows (without `client_config.py`
  it uses `CLIENT_KEY=""`/version `dev`; server registration will fail unless the key
  matches — typically you test against a locally configured server).
- **Build binaries (local, Windows):** `build.bat` (wraps `build.py`, needs PyInstaller).
- **CI:** pushing changes to `client.py`, `installer.py`, `build.py`,
  `requirements.txt`, or workflow files triggers `.github/workflows/build-binaries.yml`
  on `windows-latest` with Python 3.11, injecting `DASHBOARD_PASSWORD` and the commit
  SHA as secrets/env, and commits/uploads the rebuilt binaries.
- **Installation (end user):** the README PowerShell one-liner downloads
  `installer.exe` pinned to the latest `main` commit SHA into `%APPDATA%\run` and runs
  it; the installer self-deletes after finishing.

---

## 7. Conventions & Invariants

- **Code style:** heavily documented Python with typed signatures (`typing` module),
  section banners using Unicode rules (`# ── Section ───`), and docstrings describing
  Parameters/Returns. Frontend mirrors this with block banners and JSDoc.
- **Thread safety:** every shared mutable dict/set in `app.py` has a dedicated
  `threading.Lock`; never touch `active_clients`, counters, or pending-request maps
  without it.
- **Validation:** any username/filename entering paths or queries must pass
  `is_safe_name()` first.
- **Client identity is load-bearing:** everything (frame folders, DB rows, rooms,
  logs) keys off the composite `USERNAME-ID-W` string — do not change its format
  without migrating server and frontend.
- **Committed binaries:** `run.exe` and `installer.exe` live at repo root and are the
  distribution channel (fetched by URL at a pinned commit SHA). Rebuilding regenerates
  them; expect large diffs.
- **Error payloads:** consistent `{"detail": ..., "status": "error"}` /
  `{"status": "success"}` JSON shapes across the REST API.

---

## 8. Security Considerations (current design)

- Shared-secret auth everywhere (`DASHBOARD_PASSWORD` == `CLIENT_KEY`); no per-user
  credentials or token rotation.
- `cors_allowed_origins="*"`, client TLS verification disabled
  (`ssl_verify=False`), Werkzeug dev server used in production
  (`allow_unsafe_werkzeug=True`) — acceptable within the project's threat model but
  flagged here for awareness.
- Mitigations in place: path-traversal/injection name validation, frame-count pruning,
  single-instance mutex, item/byte caps on FS scans and previews, complete operation
  and access audit logging (with IP geolocation).

---

## 9. Quick Glossary

| Term | Meaning |
|---|---|
| **Frame** | A single base64 JPEG/PNG screen capture uploaded by a client, stored under `uploaded_frames/<username>/` |
| **RUN view** | Dashboard mode showing the client control grid (`runApp.js`) |
| **FRAMES view** | Dashboard mode for browsing/streaming screenshots (`framesApp.js`) |
| **Watchdog** | Scheduled task `WinRunChecker` restarting the client every minute |
| **Etched config** | `client_config.py` secrets baked into the PyInstaller binary at build time |
| **Dispatch** | Server pattern of REST call → WS event → awaited `*_res` response via request-ID + Event |
