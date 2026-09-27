"""Explicit provisioning command; never invoked from an HTTP request."""
import os
import subprocess

from app.core.config import PROJECT_ROOT, Settings


def main():
    settings = Settings.from_env()
    env = dict(os.environ, PYTHONUNBUFFERED="1", PYTHONIOENCODING="utf-8", HF_HUB_OFFLINE="0")
    env["PYTHONPATH"] = str(PROJECT_ROOT) + os.pathsep + env.get("PYTHONPATH", "")
    subprocess.run([str(settings.pipeline_python), "-m", "app.pipeline_runner", "--prepare",
                    "--cache-dir", str(settings.cache_dir), "--device", settings.device], check=True, env=env)


if __name__ == "__main__":
    main()
