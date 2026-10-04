import os
import shutil
import subprocess
import sys

def build():
    root_dir = os.path.dirname(os.path.abspath(__file__))
    dist_dir = os.path.join(root_dir, "dist")
    build_dir = os.path.join(root_dir, "build")

    print("[Build] Installing dependencies from requirements.txt...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-r", "requirements.txt"])

    print("\n[Build] Compiling client.py -> run.exe...")
    subprocess.check_call([
        sys.executable, "-m", "PyInstaller",
        "--noconsole",
        "--onefile",
        "--clean",
        "-n", "run",
        "client.py"
    ], cwd=root_dir)

    print("\n[Build] Compiling installer.py -> installer.exe...")
    subprocess.check_call([
        sys.executable, "-m", "PyInstaller",
        "--noconsole",
        "--onefile",
        "--clean",
        "-n", "installer",
        "installer.py"
    ], cwd=root_dir)

    run_dist = os.path.join(dist_dir, "run.exe")
    installer_dist = os.path.join(dist_dir, "installer.exe")

    run_target = os.path.join(root_dir, "run.exe")
    installer_target = os.path.join(root_dir, "installer.exe")

    if os.path.exists(run_dist):
        shutil.copy2(run_dist, run_target)
        print(f"[Build] Successfully copied run.exe to root -> {run_target}")

    if os.path.exists(installer_dist):
        shutil.copy2(installer_dist, installer_target)
        print(f"[Build] Successfully copied installer.exe to root -> {installer_target}")

    print("\n[Build] Cleaning up temporary build artifacts...")
    if os.path.exists(build_dir):
        shutil.rmtree(build_dir, ignore_errors=True)
    if os.path.exists(dist_dir):
        shutil.rmtree(dist_dir, ignore_errors=True)

    for spec in ["run.spec", "installer.spec"]:
        spec_path = os.path.join(root_dir, spec)
        if os.path.exists(spec_path):
            os.remove(spec_path)

    print("\n[Build Complete] Both run.exe and installer.exe are ready in the project root!")

if __name__ == "__main__":
    build()
