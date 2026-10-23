# AI Agent Guidelines & Context Maintenance Contract — `run`

This document defines mandatory guidelines for all AI agents (Antigravity, Gemini, Claude, Qwen, Copilot, Cursor, etc.) and contributors working on this repository.

---

## 1. Context Read Requirement

Before proposing or executing code changes:
1. **Always read [CONTEXT.md](file:///c:/Users/yuane/OneDrive/Documents/vscode/run/CONTEXT.md)** to orient yourself with the architectural overview, component responsibilities, event contracts, database schemas, and system invariants.
2. Do not introduce breaking changes to the composite client identity format (`USERNAME-ID-W`), existing Socket.IO event names, or endpoint contracts without coordinating across both server (`app.py`), client (`client.py`), and frontend (`static/runApp.js`, `static/framesApp.js`).

---

## 2. Context Maintenance Invariant (Mandatory)

Whenever you make any change to the codebase that affects:
- **Endpoints & Routes:** Added, renamed, or modified HTTP routes in [app.py](file:///c:/Users/yuane/OneDrive/Documents/vscode/run/app.py).
- **Socket.IO Contracts:** Added, modified, or deleted events/payloads in [app.py](file:///c:/Users/yuane/OneDrive/Documents/vscode/run/app.py) or [client.py](file:///c:/Users/yuane/OneDrive/Documents/vscode/run/client.py).
- **Database Schema:** Tables, columns, or indexes altered in `init_db()` in [app.py](file:///c:/Users/yuane/OneDrive/Documents/vscode/run/app.py).
- **Client Agent Subsystems:** Changes to screen capture, commands, image/audio handlers, or FTP logic in [client.py](file:///c:/Users/yuane/OneDrive/Documents/vscode/run/client.py).
- **Installer & Persistence:** Changes to tasks (`WinRun`, `WinRunChecker`, `WinRunInstaller`), registry, Defender exclusions, or paths in [installer.py](file:///c:/Users/yuane/OneDrive/Documents/vscode/run/installer.py).
- **Build Pipeline:** PyInstaller options, etched configurations, or dependencies in [build.py](file:///c:/Users/yuane/OneDrive/Documents/vscode/run/build.py) or [.github/workflows/build-binaries.yml](file:///c:/Users/yuane/OneDrive/Documents/vscode/run/.github/workflows/build-binaries.yml).
- **Frontend Modules & Features:** New action modes, themes, or UI flows in [templates/index.html](file:///c:/Users/yuane/OneDrive/Documents/vscode/run/templates/index.html) or [static/](file:///c:/Users/yuane/OneDrive/Documents/vscode/run/static/).
- **Configuration:** New or modified environment variables in [.env](file:///c:/Users/yuane/OneDrive/Documents/vscode/run/.env).

### Your Rule:
> **You MUST update [CONTEXT.md](file:///c:/Users/yuane/OneDrive/Documents/vscode/run/CONTEXT.md) in the same task/commit to reflect the new state of the codebase.**
> 
> Never leave [CONTEXT.md](file:///c:/Users/yuane/OneDrive/Documents/vscode/run/CONTEXT.md) stale or out of sync with your changes.

---

## 3. Verification Command

After updating code and [CONTEXT.md](file:///c:/Users/yuane/OneDrive/Documents/vscode/run/CONTEXT.md), run the automated contract verification script:

```bash
python scripts/verify_context.py
```

This script parses the codebase and verifies:
- All documented files exist.
- All documented REST API routes exist in [app.py](file:///c:/Users/yuane/OneDrive/Documents/vscode/run/app.py).
- All documented Socket.IO events exist in [app.py](file:///c:/Users/yuane/OneDrive/Documents/vscode/run/app.py) and [client.py](file:///c:/Users/yuane/OneDrive/Documents/vscode/run/client.py).
- Documented environment variables match actual references.

---

## 4. Coding Conventions for This Repository

- **Section Banners:** Preserve the clean unicode box-drawing section banners (`# ── Section ───`) in Python and JavaScript files.
- **Documentation & Types:** Maintain comprehensive docstrings (Parameters / Returns) and type hints in Python.
- **Thread Safety:** Every shared dictionary in [app.py](file:///c:/Users/yuane/OneDrive/Documents/vscode/run/app.py) must remain guarded by its corresponding `threading.Lock`.
- **Validation:** Always pass untrusted client inputs (usernames, filenames) through `is_safe_name()` before using them in filesystem operations or database queries.
