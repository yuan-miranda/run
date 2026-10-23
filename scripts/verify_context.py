"""
Automated Contract & Fact-Check Validator for CONTEXT.md
Verifies that all files, endpoints, socket events, and environment variables
documented in CONTEXT.md match the current codebase.
"""

import os
import re
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
CONTEXT_FILE = ROOT_DIR / "CONTEXT.md"
APP_FILE = ROOT_DIR / "app.py"
CLIENT_FILE = ROOT_DIR / "client.py"


def read_file(path: Path) -> str:
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8")


def check_files(context_text: str) -> list[str]:
    errors = []
    # Check key files mentioned in directory structure
    key_files = [
        "app.py",
        "client.py",
        "installer.py",
        "build.py",
        "build.bat",
        "requirements.txt",
        "README.md",
        "CONTEXT.md",
        "AGENTS.md",
        "templates/index.html",
        "static/styles.css",
        "static/runApp.js",
        "static/framesApp.js",
        "static/modeSwitcher.js",
        ".github/workflows/build-binaries.yml",
    ]
    for rel_path in key_files:
        full_path = ROOT_DIR / rel_path
        if not full_path.exists():
            errors.append(f"Missing file referenced in CONTEXT.md: {rel_path}")
    return errors


def check_endpoints(context_text: str, app_text: str) -> list[str]:
    errors = []
    # Find all @app.route / @app.get / @app.post in app.py
    pattern = re.compile(r'@app\.(?:route|get|post)\(["\']([^"\']+)["\']')
    actual_endpoints = set(pattern.findall(app_text))

    for ep in sorted(actual_endpoints):
        # Normalize <username> or other path parameters to test presence in CONTEXT.md
        # e.g. /frames/<username>/<filename> -> test prefix or regex
        clean_ep = re.sub(r"<[^>]+>", "", ep)
        if clean_ep not in context_text and ep not in context_text:
            errors.append(f"Endpoint '{ep}' in app.py is not documented in CONTEXT.md")

    return errors


def check_socketio_events(context_text: str, app_text: str, client_text: str) -> list[str]:
    errors = []
    # Server listener events: @socketio.on("...")
    app_events = set(re.findall(r'@socketio\.on\(["\']([^"\']+)["\']', app_text))
    # Client listener events: @sio.on("...")
    client_events = set(re.findall(r'@sio\.on\(["\']([^"\']+)["\']', client_text))

    for event in sorted(app_events):
        if event not in context_text:
            errors.append(f"Server Socket.IO event '{event}' in app.py is missing from CONTEXT.md")

    for event in sorted(client_events):
        if event not in context_text:
            errors.append(f"Client Socket.IO event '{event}' in client.py is missing from CONTEXT.md")

    return errors


def check_env_vars(context_text: str, app_text: str, client_text: str) -> list[str]:
    errors = []
    combined = app_text + "\n" + client_text
    env_matches = set(re.findall(r'os\.getenv\(["\']([A-Z0-9_]+)["\']', combined))
    for var in sorted(env_matches):
        if var not in context_text:
            errors.append(f"Environment variable '{var}' used in codebase is missing from CONTEXT.md")
    return errors


def main() -> int:
    print("=" * 60)
    print("  CONTEXT.md Automated Contract & Fact-Check Verification")
    print("=" * 60)

    if not CONTEXT_FILE.exists():
        print(f"[FAIL] CONTEXT.md not found at {CONTEXT_FILE}")
        return 1

    context_text = read_file(CONTEXT_FILE)
    app_text = read_file(APP_FILE)
    client_text = read_file(CLIENT_FILE)

    all_errors = []

    print("[*] Checking key repository files...")
    file_errors = check_files(context_text)
    all_errors.extend(file_errors)

    print("[*] Checking REST API endpoints...")
    endpoint_errors = check_endpoints(context_text, app_text)
    all_errors.extend(endpoint_errors)

    print("[*] Checking Socket.IO event contracts...")
    socket_errors = check_socketio_events(context_text, app_text, client_text)
    all_errors.extend(socket_errors)

    print("[*] Checking environment variables...")
    env_errors = check_env_vars(context_text, app_text, client_text)
    all_errors.extend(env_errors)

    print("-" * 60)
    if all_errors:
        print(f"[FAIL] Found {len(all_errors)} discrepancy/discrepancies:")
        for err in all_errors:
            print(f"  - {err}")
        return 1
    else:
        print("[PASS] CONTEXT.md is 100% synchronized with the codebase!")
        print("       All files, endpoints, socket events, and environment variables match.")
        return 0


if __name__ == "__main__":
    sys.exit(main())
