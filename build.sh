#!/usr/bin/env bash
set -e

# Change directory to the script's directory
cd "$(dirname "$0")"

echo "[Build] Running cross-platform build script..."
if command -v python3 &>/dev/null; then
    python3 build.py
elif command -v python &>/dev/null; then
    python build.py
else
    echo "[Error] Python 3 is not installed or not in PATH."
    exit 1
fi
