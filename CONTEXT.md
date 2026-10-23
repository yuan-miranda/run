# Repository Context — `run`

> Comprehensive orientation document for the entire repository. Intended for new
> contributors, reviewers, and AI agents working on this codebase. Keep this file
> updated when architecture, endpoints, or event contracts change.
> See [AGENTS.md](file:///c:/Users/yuane/OneDrive/Documents/vscode/run/AGENTS.md) for automated agent instructions on maintaining this context.

---

## 1. Project Overview

**`run`** is a Windows remote-monitoring and administration toolkit consisting of
three cooperating parts:

1. **Central Server (`app.py`)** — A Flask + Socket.IO controller hosted on a VPS
   (`https://runx.ddns.net`, port **5002**, optional HTTPS via `cert.pem`/`key.pem`).
   It serves a password-protected web dashboard and brokers real-time WebSocket
   messaging with connected client agents.
2. **Web Dashboard (`templates/index.html` + `static/`)** — A single-page browser UI
   (`run.exe webview client` / "Windows Central") for managing all connected nodes:
   live screenshot streams, remote PowerShell command execution, speech synthesis,
   image dialogs, max-volume audio blasting, an FTP-style remote filesystem browser,
   visibility controls, and real-time audit logs with geolocation security gating.
3. **Windows Client Agent (`client.py` → `run.exe`)** — A persistent background daemon
   installed on target Windows machines. It connects back to the server over
   Socket.IO and performs continuous screen streaming, on-demand screenshots, command
   execution, dialog/audio playback, and remote file operations.

Distribution is automated: `installer.py` → `installer.exe` performs a self-deleting,
UAC-elevating install that registers Windows Defender exclusions and scheduled tasks;
`build.py` compiles both binaries with PyInstaller (locally via `build.bat` or in CI
via GitHub Actions).

**Repository:** `github.com/yuan-miranda/run` · **Default branch:** `main`

---

## 2. Directory Structure

```
/
├── app.py                     # Flask/Socket.IO central server (~1.5k lines)
├── client.py                  # Windows client daemon (~1.1k lines)
├── installer.py               # Self-deleting Windows installer script (224 lines)
├── build.py                   # PyInstaller build pipeline (etches secrets, compiles EXEs) (146 lines)
├── build.bat                  # One-shot local build wrapper (runs build.py)
├── requirements.txt           # Python dependencies
├── README.md                  # End-user one-liner install instructions (PowerShell)
├── CONTEXT.md                 # System documentation & architectural reference
├── AGENTS.md                  # Context maintenance rules & workflow instructions for AI agents
├── scripts/
│   └── verify_context.py      # Automated contract & fact-check validator for CONTEXT.md
├── .gitignore                 # Ignores .env, *.db, uploaded_frames/, client_config.py, build artifacts
├── run.exe                    # Compiled client binary (committed artifact)
├── installer.exe              # Compiled installer binary (committed artifact)
├── templates/
│   └── index.html             # Dashboard SPA shell (~670 lines, Bootstrap Icons CDN, theme engine)
├── static/
│   ├── styles.css             # Dashboard styling, themes, modals, canvas (~4.1k lines)
│   ├── runApp.js              # RunApp controller — main dashboard module (~4.9k lines)
│   ├── framesApp.js           # FramesApp — screenshot stream & history viewer (~1.1k lines)
│   └── modeSwitcher.js        # Mode switching between RUN/FRAMES views + shared RunUtils (174 lines)
└── .github/workflows/
    └── build-binaries.yml     # CI: builds Windows binaries on push to main
```

Runtime-generated (gitignored): `database.db` (SQLite with WAL mode), `uploaded_frames/`
(screenshot storage per client), `client_config.py` (build-time etched secrets),
`build/`, `dist/`, `*.spec`.

---

## 3. Component Reference

### 3.1 `app.py` — Central Server

- **Stack:** Flask ≥3.0, flask-socketio ≥5.3, auto-detected async mode
  (`gevent`/`eventlet`/`threading`, override with `SOCKETIO_ASYNC_MODE`), SQLite with WAL mode,
  python-dotenv. CORS wide open (`cors_allowed_origins="*"`).
- **Required env:** `DASHBOARD_PASSWORD` (server refuses to boot without it).
  Optional: `ACCESS_LOGS_PASSWORD` (falls back to `DASHBOARD_PASSWORD`),
  `SSL_CERT`/`SSL_KEY` (defaults `cert.pem`/`key.pem`).
- **Auth model:**
  - HTTP routes require `@require_password` decorator (token supplied via `x-access-token` header,
    query param `token`, or request JSON `password`/`token`).
  - `/api/auth/login` validates password and logs browser client telemetry (fingerprint + IP) to `access_logs`.
  - `/api/access_logs/verify` validates access log gate password (`ACCESS_LOGS_PASSWORD` or `DASHBOARD_PASSWORD`).
  - Socket.IO clients authenticate by emitting `register` with `{"username", "auth_token", "version", "lan_ip"}`
    where `auth_token == DASHBOARD_PASSWORD`.
  - Browser dashboard connects to Socket.IO and emits `register_dashboard` with `{"password"}` to join the
    `"dashboard"` broadcast room.
- **State:** Thread-safe in-memory dicts guarded by locks:
  - `active_clients` (sid → username) & `authenticated_sids` (`client_lock`)
  - `upload_counters` (username → count) (`counter_lock`)
  - `pending_screenshot_requests` (req_id → `{event, username, result}`) (`screenshot_lock`)
  - `pending_fs_requests` (req_id → `{event, result}`) (`fs_lock`)
- **Database (`init_db()` at import):** SQLite with WAL mode (`database.db`):
  - `clients`: `username` (PK), `visible` (INT default 1), `capture` (INT default 0), `version` (TEXT), `updated_at` (TEXT), `ip` (TEXT).
  - `operations_log`: `id` (PK AUTOINCREMENT), `username` (TEXT), `op_type` (TEXT), `details` (TEXT), `status` (TEXT), `created_at` (TEXT). Indexed on `(username, id DESC)`.
  - `access_logs`: `id` (PK AUTOINCREMENT), `ip` (TEXT), `status` (TEXT), `country`, `region`, `city`, `isp`, `browser`, `os`, `device`, `screen`, `timezone`, `language`, `hardware`, `gpu`, `latitude` (REAL), `longitude` (REAL), `accuracy` (REAL), `gps_location` (TEXT), `details` (TEXT JSON), `created_at` (TEXT). Indexed on `id DESC`.
- **Security & Storage helpers:**
  - `is_safe_name()`: Regex `^[a-zA-Z0-9_\-\.]+$` guards against path traversal (`..`, `/`, `\`).
  - `prune_old_frames()`: Caps stored frames per client folder at `MAX_FRAMES_PER_USER = 1000`.

#### REST API (JSON; password-protected unless noted)

| Endpoint | Method | Purpose |
|---|---|---|
| `/` | `GET` | Serve dashboard SPA shell (`index.html`) (Public) |
| `/api/auth/login` | `POST` | Authenticate dashboard; logs device fingerprint & IP to `access_logs` |
| `/api/access_logs/verify` | `POST` | Verify access-log password (`ACCESS_LOGS_PASSWORD`) |
| `/api/access_logs` | `GET` | List audit records of dashboard logins with IP & geolocation |
| `/api/clients` | `GET` | Connected and registered clients with online status, IP, version, visibility |
| `/api/frames/<username>` | `GET` | Frame history list for user (sorted newest first) |
| `/api/frames/delete` | `POST` | Delete single frame or all frames for a user |
| `/frames/<username>/<filename>` | `GET` | Serve static frame image from disk (Public) |
| `/api/capture` | `POST` | Toggle continuous screen streaming (`capture: true/false`) |
| `/api/screenshot/take` | `POST` | On-demand single screenshot (synchronously awaits client response; rejects if continuous stream is active) |
| `/api/visibility` | `POST` | Toggle client visibility (`visible: true/false`) |
| `/api/command` | `POST` | Dispatch shell/PowerShell command to a client |
| `/api/image` | `POST` | Push base64 image + caption modal dialog to a client |
| `/api/audio` | `POST` | Push base64 audio clip to blast on client physical speakers |
| `/api/fs/list` | `POST` | Enumerate Windows drives or scan directory items (≤5000 items) |
| `/api/fs/read` | `POST` | Read text file preview (≤512 KB) |
| `/api/fs/write` | `POST` | Write or overwrite file contents on client |
| `/api/fs/delete` | `POST` | Delete file or directory recursively |
| `/api/fs/mkdir` | `POST` | Create directory on client |
| `/api/fs/rename` | `POST` | Rename or move file / directory |
| `/api/logs/<username>` | `GET` | Fetch operations audit log for specific user or all users |
| `/api/logs/<username>/clear` | `POST` | Clear audit log for user or all users |

#### Socket.IO Event Contracts

- **Client → Server Events:**
  - `register` — Payload: `{"username", "auth_token", "version", "lan_ip"}`. Validates `auth_token == DASHBOARD_PASSWORD`, registers session, joins user room, updates IP/version in DB, emits `set_capture` to client and `status_change` to dashboard.
  - `heartbeat` — Payload: `{"username", "version"}`. Updates `updated_at` and `ip` in DB.
  - `upload_frame` — Payload: `{"username", "filename", "image"}`. Accepts raw JPEG bytes or base64. Writes JPEG to `uploaded_frames/<username>/<filename>`, emits `new_frame` to dashboard, and resolves any pending single screenshot requests.
  - `capture_screenshot_res` — Payload: `{"req_id", "success", "filename", "width", "height"}` or `{"req_id", "error"}`. Correlates single screenshot REST requests.
  - Filesystem response events: `fs_list_res`, `fs_read_res`, `fs_write_res`, `fs_delete_res`, `fs_mkdir_res`, `fs_rename_res` — Payload: `{"req_id", "payload"}`. Correlates synchronous REST calls via `dispatch_fs_request()`.
  - `disconnect` — Cleans up session and emits `status_change` (`online: false`) to dashboard if no sessions remain for user.

- **Server → Client Emissions:**
  - `set_capture` — `{"capture": bool}`: Start/stop streaming loop.
  - `take_screenshot` — `{"req_id": str}`: Single screenshot capture trigger.
  - `exec_command` — `{"cmd": str, "visible": int}`: Remote command payload.
  - `display_image` — `{"image": b64_str, "caption": str}`: Show image dialog.
  - `play_audio` — `{"audio": b64_str, "filename": str, "title": str}`: Blast audio payload.
  - Filesystem request events: `fs_list_req`, `fs_read_req`, `fs_write_req`, `fs_delete_req`, `fs_mkdir_req`, `fs_rename_req` — `{"req_id": str, ...}`: Dispatched remote filesystem operations.

- **Dashboard ⇆ Server Events:**
  - Dashboard → Server: `register_dashboard` with `{"password"}` (joins `"dashboard"` room).
  - Server → Dashboard (room: `"dashboard"`):
    - `status_change` — `{"username", "online", "version", "ip"}`: Real-time node connect/disconnect.
    - `new_frame` — `{"username", "filename"}`: Broadcasts uploaded frame for live streaming.
    - `new_operation_log` — `{"id", "username", "op_type", "details", "status", "created_at"}`: Real-time audit log stream.
    - `new_access_log` — `{"id", "ip", "status", "country", "region", "city", "isp", "browser", "os", "device", ...}`: Real-time dashboard access attempt stream.

---

### 3.2 `client.py` — Windows Agent (`run.exe`)

- **Windows-only daemon:** Uses `ctypes.windll` (kernel32, user32, shell32) and Pillow (`ImageGrab`, `Image`).
- **Single-instance mutex:** Enforced via named Windows mutex `run_py_mutex`. If already running, new instances terminate silently.
- **Identity & Paths:**
  - Binary location: `%APPDATA%\run\run.exe`.
  - Identity directory: `%APPDATA%\Microsoft\run\`.
  - `run.txt`: Persists unique 8-char client UUID.
  - `run.dat`: Persists installed version commit SHA.
  - Composite username format: `USERNAME-<8charid>-W` (e.g. `john-a1b2c3d4-W`).
- **Config & Etched Secrets:**
  - Compiled binaries import etched `client_config.py` (`CLIENT_KEY`, `CLIENT_VERSION`).
  - Script dev fallback: Uses `CLIENT_KEY = ""` and version `"dev"`.
- **Connection & Protocol Fallback:**
  - Uses `socketio.Client(ssl_verify=False, reconnection=True, reconnection_delay=2, reconnection_delay_max=10)`.
  - Default `VPS_URL = https://runx.ddns.net`.
  - In `main()`, attempts connections using both `https://` and fallback `http://` variants.
  - Emits `heartbeat` keepalives every 5 seconds.
- **Subsystems:**
  - *Screen Capture & Streaming:*
    - Captures screen with Pillow `ImageGrab.grab()`.
    - Downsamples to 50% resolution using bilinear resampling, converts to **grayscale** (`"L"`), and compresses to **JPEG** (quality 80).
    - Emits `upload_frame` with raw JPEG binary bytes (`img_bytes`).
    - `capture_loop()` streams frames continuously while `capture_active` is true.
    - `take_and_upload_screenshot(req_id)` responds with `capture_screenshot_res` containing metadata (`req_id`, `success`, `filename`, `width`, `height`). Note: Single screenshot is disallowed while continuous stream is active.
  - *Remote Execution & Administrative Commands:*
    - Shell commands executed through PowerShell (`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass [-WindowStyle Hidden] -Command <cmd>`).
    - Special command triggers:
      - `panic` in command: Immediately terminates client process (`sys.exit(0)`).
      - `altf4` in command: Immediately forces system shutdown (`shutdown /s /t 0`).
  - *Interactive Image Viewer (`display_image`):*
    - Spawns top-most, centered Windows Forms dialog with dark theme (`#18181b`) and zoom-fit image box.
    - Transparently converts WebP and animated WebP images to PNG or GIF via Pillow for GDI+ compatibility.
    - Modal closes on `ESC` or `Enter`.
  - *Audio Blasting Subsystem (`play_audio`):*
    - Automatically unmutes and maximizes master volume by pulsing 50 `VK_VOLUME_UP` (0xAF) virtual key events via `keybd_event`.
    - Uses embedded C# COM interop (`AudioDeviceHelper` implementing `IPolicyConfigClient` / `IMMDeviceEnumerator`) to force audio routing to the machine's internal/physical speakers (bypassing headphones), then restores original default endpoint after playback.
    - Plays audio at 100% volume via WinMM MCI (resolves 8.3 short paths using `GetShortPathNameW`) or MediaPlayer.
  - *Remote Filesystem / FTP Subsystem:*
    - Enumerate logical drives (`get_windows_drives()`).
    - Directory scanner (`scan_directory()`) capped at 5,000 items.
    - File preview reader (`read_file_preview()`) capped at 512 KB.
    - File writer, recursive delete, directory creation, rename/move (`fs_*_req` → `fs_*_res`).

---

### 3.3 `installer.py` — Installer (`installer.exe`)

- **Privilege Elevation:** Requests UAC elevation (`ShellExecuteW "runas"`) on fresh installs; skipped on updates if `run.dat` exists.
- **Process Termination:** Stops existing `run.exe` and `powershell.exe` processes and disables watchdog task before updating files.
- **Windows Defender Exclusion:** Adds Windows Defender folder exclusion on fresh installs:
  `Add-MpPreference -ExclusionPath '%APPDATA%\run'`.
- **Target Paths:**
  - Client binary downloaded to `%APPDATA%\run\run.exe`.
  - Version state written to `%APPDATA%\Microsoft\run\run.dat`.
- **Scheduled Tasks:** Registers three scheduled tasks:
  1. `WinRun` — Launches `run.exe` at user logon (`-AtLogOn`).
  2. `WinRunInstaller` — Pulls latest `installer.exe` pinned to latest GitHub commit SHA on `main`.
  3. `WinRunChecker` — 1-minute repeat interval watchdog (`-RepetitionInterval (New-TimeSpan -Minutes 1)`) ensuring the daemon stays online.
- **Self-Deletion:** Launches background delayed cleanup `cmd.exe /c timeout /t 2 >nul & del /f /q "<self_path>"` upon completion.

---

### 3.4 `build.py` / `build.bat` — Build Pipeline

1. Reads `.env` via lightweight standalone parser (no external dependencies required).
2. Sets `CLIENT_KEY = DASHBOARD_PASSWORD` (defaults to `"DEFAULT_SECRET"` if unset).
3. Resolves version hash from `CLIENT_VERSION` env or `git rev-parse --short HEAD` (truncated to 7 chars).
4. Generates temporary build-time secret file `client_config.py`.
5. Runs `pip install -r requirements.txt`.
6. Invokes PyInstaller:
   - `client.py` → `run.exe` (`--noconsole --onefile --clean -n run`).
   - `installer.py` → `installer.exe` (`--noconsole --onefile --clean -n installer`).
7. Copies compiled binaries to repository root.
8. Automatically removes `client_config.py`, `build/`, `dist/`, and `.spec` files.
9. `build.bat` provides one-click execution on Windows dev environments.

---

### 3.5 Frontend Architecture (`templates/`, `static/`)

- **`index.html`** — Single-Page Application shell:
  - Header with mode toggle (`RUN` / `FRAMES`), client target picker, action mode selector, theme selector, and access logs button.
  - Main RUN client grid and action drawers.
  - FRAMES canvas viewport with pan/zoom and timeline scrubber.
  - Modals: Action modal, Imager modal, Audio Blaster modal, FTP File Manager modal, Operations Audit Log modal, Access Logs modal, and Security Verification Gate modal.
- **`runApp.js` (RunApp controller — ~4.9k lines):**
  - *Block 1:* State container, demo users, constants, status ordering.
  - *Block 2:* Username parsing (`parseUsername` extracting base name, 8-char ID, OS tag), platform icons.
  - *Block 3:* Dynamic Theme Engine — 6 dark themes (`night`, `graphite`, `midnight`, `forest`, `ember`, `polar`) and randomizer.
  - *Block 4:* Authentication & VPS Connection — Auth Gate modal with browser location permission prompt (`navigator.geolocation`), device telemetry fingerprinting (WebGL GPU, CPU cores, screen dimensions, IP), and automatic HTTPS upgrade.
  - *Block 5:* Real-time WebSocket synchronization with server (`status_change`, `new_frame`, `new_operation_log`, `new_access_log`).
  - *Block 6:* Client card grid rendering with status badges (green/yellow/red), latency, and visibility toggle.
  - *Block 7:* Selection state, keyboard navigation (`J`/`K` navigation, `Space` selection).
  - *Block 8:* Action Modal for 6 modes:
    - `cmd` — Interactive command execution with PowerShell script library.
    - `speak` — Text-to-speech synthesis (David/Zira voices, pitch/rate controls).
    - `popup_msg` — Native Windows dialog message boxes.
    - `imager` — Image push modal.
    - `audio` — Audio blaster modal.
    - `scripts` — Script management library.
  - *Block 9:* Imager Modal controller — image upload, preview, caption input, presets.
  - *Block 10:* Audio Blaster controller — sound library, audio upload, duration preview, max volume dispatch.
  - *Block 11:* Remote script library and execution dispatcher.
  - *Block 12:* Remote Filesystem / FTP Browser — logical drive selector, directory browser, file preview editor (<512 KB), file write/upload, recursive delete, folder creation, rename, and download.
  - *Block 13:* Operations Audit Log Subsystem — real-time action feed, client filtering, export, clear.
  - *Block 13B:* Access Verification Logs Subsystem — authentication audit viewer, geolocation details with map link, ISP, browser, OS, GPU, hardware concurrency, and verification pass/fail status.
  - *Block 14:* Command dispatching and REST API integration with error handling.
  - *Block 15:* Bootstrap, hotkeys, and event delegation.
- **`framesApp.js` (FramesApp viewer — ~1.1k lines):**
  - High-performance pan/zoom canvas viewport engine (mouse drag, wheel zoom, WASD / arrow keys).
  - Frame history cache, preloading, and scrubber timeline.
  - Auto-play video simulation loop with adjustable FPS (1–30 FPS).
  - Real-time frame ingestion via Socket.IO `new_frame` events.
  - State persisted under `localStorage` (`framesViewerState`).
- **`modeSwitcher.js` (174 lines):**
  - View switcher between RUN and FRAMES modes with fade transitions.
  - Keyboard shortcuts: `R` for RUN mode, `F` for FRAMES mode.
  - Shared `window.RunUtils`: Dynamic dropdown button/menu auto-measuring (`sizeDropdownToContent`), UTF-8 Base64 encoding/decoding, and composite username parser.

---

## 4. End-to-End Data Flow

```
┌─────────────────────────── Browser Dashboard ───────────────────────────┐
│  - RUN View: Node cards, Command/Speak/Audio modals, FTP file manager  │
│  - FRAMES View: Pan/zoom canvas, frame scrubber, real-time stream      │
│  - Security Gate: Browser geolocation & device telemetry capture       │
└──────────────────┬────────────────────────────────▲────────────────────┘
                   │ HTTPS / REST                   │ Socket.IO Events:
                   │ Requests                       │ - status_change
                   │                                │ - new_frame
                   │                                │ - new_operation_log
                   │                                │ - new_access_log
                   ▼                                │
┌────────────────────────── Central Server (app.py) ──────────────────────┐
│  - Validates dashboard tokens and enforces client is_safe_name checks   │
│  - Correlates sync REST requests with async client events (req_id)      │
│  - Persists frames to uploaded_frames/ and metadata to SQLite database  │
└──────────────────┬────────────────────────────────▲────────────────────┘
                   │ Server -> Client               │ Client -> Server
                   │ - set_capture                  │ - register (LAN IP, key)
                   │ - take_screenshot              │ - heartbeat (every 5s)
                   │ - exec_command                 │ - upload_frame (raw JPEG)
                   │ - display_image                │ - capture_screenshot_res
                   │ - play_audio                   │ - fs_*_res (FTP ops)
                   │ - fs_*_req                     │
                   ▼                                │
┌────────────────────── Windows Client (client.py / run.exe) ─────────────┐
│  - Single-instance mutex enforcement (run_py_mutex)                    │
│  - Grayscale JPEG screen capture & streaming worker loop                │
│  - PowerShell runner (with 'panic' exit & 'altf4' shutdown triggers)    │
│  - Top-most image dialogs (with Pillow WebP -> PNG/GIF conversion)      │
│  - Internal speaker volume blaster (50x VK_VOLUME_UP + C# COM interop)  │
│  - Remote filesystem manager (drives, scan <=5k, preview <=512KB)       │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Configuration & Environment Variables

| Variable | Used by | Required | Default | Notes |
|---|---|---|---|---|
| `DASHBOARD_PASSWORD` | `app.py`, `build.py` | **Yes** | — | Server refuses to boot without it. Doubles as client `CLIENT_KEY` etched into compiled binaries. |
| `ACCESS_LOGS_PASSWORD` | `app.py` | No | `DASHBOARD_PASSWORD` | Password required to unlock dashboard access verification records. |
| `SOCKETIO_ASYNC_MODE` | `app.py` | No | Auto-detect | Forces Socket.IO async mode (`gevent`, `eventlet`, or `threading`). |
| `SSL_CERT` / `SSL_KEY` | `app.py` | No | `cert.pem` / `key.pem` | Enables HTTPS when certificate and private key files exist. |
| `VPS_URL` | `client.py` | No | `https://runx.ddns.net` | Target server URL. Automatically tests HTTPS and HTTP fallback. |
| `CLIENT_VERSION` | `build.py`, CI | No | Git commit SHA | Truncated to 7 characters and etched into binary. Falls back to `"dev"`. |
| `APPDATA` | `client.py`, `installer.py` | OS-provided | `~\\AppData\\Roaming` | Base path for client installation and identity storage. |
| `USERNAME` | `client.py` | OS-provided | `user` | Local Windows username used in composite identity string. |
| `TEMP` | `client.py` | OS-provided | System temp dir | Directory for temporary image and audio file payloads. |

---

## 6. Development & Deployment Workflow

- **Run Server Locally:**
  ```bash
  pip install -r requirements.txt
  # Set DASHBOARD_PASSWORD=your_secret in .env
  python app.py
  ```
  Dashboard loads at `http://localhost:5002`.
- **Run Client in Development:**
  ```bash
  python client.py
  ```
  Runs client directly on Windows against `VPS_URL`.
- **Build Binaries Locally:**
  Run `build.bat` or `python build.py`. Requires PyInstaller. Etches `DASHBOARD_PASSWORD` into binary, compiles `run.exe` and `installer.exe`, and copies them to repository root.
- **Continuous Integration (GitHub Actions):**
  Pushing to `main` touching `client.py`, `installer.py`, `build.py`, `requirements.txt`, or workflow files triggers `.github/workflows/build-binaries.yml` on `windows-latest`. Compiles binaries using secrets and auto-commits the fresh `.exe` files with `[skip ci]`.
- **Target Machine Installation:**
  Users execute the one-line PowerShell command from `README.md`. Downloads `installer.exe` at pinned commit SHA into `%APPDATA%\run`, elevates UAC, adds Defender exclusions, configures scheduled tasks, launches client, and self-deletes.

---

## 7. System Invariants & Conventions

1. **Composite Client Identifier is Immutable:**
   - Identity format: `USERNAME-<8charid>-W` (e.g. `john-a1b2c3d4-W`).
   - Frame directories, database rows, rooms, and audit logs key off this string.
2. **Path & Identifier Sanitization:**
   - Any client-supplied username or filename entering queries or paths MUST pass `is_safe_name()`.
3. **Thread Safety:**
   - Shared server structures (`active_clients`, `upload_counters`, `pending_screenshot_requests`, `pending_fs_requests`) are guarded by dedicated threading locks. Never mutate without holding the respective lock.
4. **Synchronous REST-over-WebSocket Dispatch:**
   - Synchronous actions (`/api/screenshot/take`, `/api/fs/*`) register a `threading.Event` with a UUID request ID, emit the WebSocket event, wait up to 10 seconds, and return JSON once the client responds.
5. **Committed Release Binaries:**
   - `run.exe` and `installer.exe` at repository root are distribution artifacts. Binary builds generate large Git diffs.
6. **Consistent Error Payload Schema:**
   - REST responses consistently follow `{"status": "success", ...}` or `{"status": "error", "message": "..."}` / `{"detail": "..."}`.

---

## 8. Verification & Context Synchronization

To guarantee this context document never drifts from codebase reality, use the automated verification tool:
```bash
python scripts/verify_context.py
```
This script validates:
- All referenced files exist.
- All HTTP endpoints documented match `@app.get` / `@app.post` / `@app.route` in `app.py`.
- All Socket.IO events documented match `@socketio.on` and `socketio.emit` in `app.py` and `client.py`.
- Environment variable contracts match definitions.
