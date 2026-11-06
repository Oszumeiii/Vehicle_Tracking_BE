"""Bound the ML process tree, including Windows worker/crash cleanup.

Node keeps stdin open while this supervisor lives. If Node disappears, the pipe
closes; a Windows Job Object owned here kills all inference descendants. On POSIX
the entire isolated supervisor process group is terminated.
"""
import argparse
import os
from pathlib import Path
import signal
import sys
import threading
import subprocess

from app.core.processes import run_process


class RecognitionSupervisor:
    @staticmethod
    def main():
        parser = argparse.ArgumentParser(description=__doc__)
        parser.add_argument("--payload", type=Path, required=True)
        parser.add_argument("--timeout", type=float, required=True)
        args = parser.parse_args()
        if sys.stdin.readline().strip() != "go":
            return 1
        if os.name != "nt":
            signal.signal(signal.SIGTERM, RecognitionSupervisor.terminate)
        threading.Thread(target=RecognitionSupervisor.parent_pipe, daemon=True).start()
        try:
            return run_process([sys.executable, "-m", "app.recognition.runner", "--wait-for-parent",
                                "--payload", str(args.payload)], env=dict(os.environ), log=sys.stdout,
                               timeout=args.timeout)
        except subprocess.TimeoutExpired:
            from app.recognition.runner import ResultWriter
            ResultWriter.write_json(args.payload.parent / "recognition-result.json", {"ok": False, "error_code": "JOB_TIMEOUT"})
            return 1

    @staticmethod
    def terminate(_signal, _frame):
        raise SystemExit(3)  # run_process finally kills its isolated process group.

    @staticmethod
    def parent_pipe():
        sys.stdin.read()
        if os.name != "nt":
            os.kill(os.getpid(), signal.SIGTERM)
        else:
            os._exit(3)


if __name__ == "__main__":
    raise SystemExit(RecognitionSupervisor.main())
