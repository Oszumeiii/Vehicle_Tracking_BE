"""Live recognition process: python -m app.live --payload PAYLOAD.json --out DIR

The payload holds the pipeline snapshot (as created by `node dist/src/cli.js live-payload`)
and the source: {"type": "youtube", "url": ...} or {"type": "file", "path": ..., "realtime": bool},
either with optional "exclude_zones": [[x1, y1, x2, y2], ...] in normalized frame coordinates.
Events are JSON lines on stdout; diagnostics go to stderr. Send "stop" on stdin, close
stdin, or press Ctrl+C to stop: open tracks are finished and recognized before exit.
"""
import argparse
from datetime import datetime, timezone
import importlib
import json
import os
from pathlib import Path
import signal
import sys
import threading
import traceback

STARTUP_CODES = {"ENVIRONMENT_ERROR", "CUDA_UNAVAILABLE", "CUDA_ERROR", "CHECKPOINT_MISSING", "PIPELINE_FAILED"}


class Emitter:
    """JSON lines on stdout.

    If the parent died (closed pipe), later events are dropped and the run is asked
    to stop: open tracks are still finished on disk, where a restarted worker finds them.
    """

    def __init__(self, stop):
        self.stop, self.closed = stop, False

    def __call__(self, event):
        if self.closed:
            return
        event = {"time": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                 **event}
        try:
            sys.stdout.write(json.dumps(event, ensure_ascii=False, allow_nan=False) + "\n")
            sys.stdout.flush()
        except OSError:
            self.closed = True
            sys.stdout = open(os.devnull, "w")  # no flush error at interpreter exit
            self.stop.set()


def watch_stdin(stop):
    """Set stop on a "stop" line or EOF (the parent closed the pipe or died).

    Reads the raw descriptor: a thread blocked in sys.stdin holds its buffer lock,
    and any other thread touching sys.stdin (libraries do at import) would hang.
    """
    pending, fd = b"", sys.stdin.fileno()
    while True:
        chunk = os.read(fd, 1024)
        if not chunk:
            break
        *lines, pending = (pending + chunk).split(b"\n")
        if any(line.strip() == b"stop" for line in lines):
            break
    stop.set()


def source_factory(source):
    from app.live.source import FfmpegFrames, FileFrames, resolve_youtube

    if source.get("type") == "youtube":
        def open_youtube():
            info = resolve_youtube(source["url"], max_height=int(source.get("max_height") or 1080))
            return info, FfmpegFrames(info["url"], info["width"], info["height"])
        return open_youtube
    if source.get("type") == "file":
        path = Path(source["path"])

        def open_file():
            import cv2
            cap = cv2.VideoCapture(str(path))
            try:
                info = dict(width=int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), height=int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)),
                            fps=float(cap.get(cv2.CAP_PROP_FPS)), video_id=path.stem)
            finally:
                cap.release()
            return info, FileFrames(path, realtime=bool(source.get("realtime")))
        return open_file
    raise ValueError("Source type must be youtube or file")


def load_models(snapshot):
    """Detector and joint OCR model, validated exactly like the upload pipeline (runner.execute)."""
    from app.recognition.registry import validate_snapshot
    from app.recognition.video_tracking import DETECTOR_CLASSES
    import ultralytics

    validate_snapshot(snapshot)
    sys.path.insert(0, snapshot["recognizer"]["module_root"])
    module, factory = snapshot["recognizer"]["factory"].split(":")
    recognizer = getattr(importlib.import_module(module), factory)({**snapshot["recognizer"], "device": snapshot["device"]})
    if not callable(recognizer):
        raise ValueError("Recognizer factory must return a callable")
    model = ultralytics.YOLO(snapshot["detector"]["checkpoint"])
    if getattr(model, "names", DETECTOR_CLASSES) != DETECTOR_CLASSES:
        raise ValueError("Detector checkpoint is not a license-plate model")
    return model, recognizer


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--payload", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--data-dir", type=Path, help="Root that evidence storage keys are relative to (default: --out)")
    parser.add_argument("--min-confidence", type=float, default=.85)
    parser.add_argument("--max-track-seconds", type=float, default=30.)
    parser.add_argument("--max-reconnects", type=int, default=10)
    parser.add_argument("--buffer-seconds", type=float, default=1.5,
                        help="Decoded frames kept while the detector is busy (1.5 s of 1080p is ~280 MB)")
    parser.add_argument("--ignore-stdin", action="store_true", help="Do not stop on stdin EOF (manual runs)")
    args = parser.parse_args(argv)
    payload = json.loads(args.payload.read_text(encoding="utf-8-sig"))  # tolerate a Windows BOM
    snapshot = payload["pipeline_snapshot"]
    if snapshot.get("device") == "cpu":
        os.environ["CUDA_VISIBLE_DEVICES"] = ""
    out = args.out.resolve()
    data_dir = (args.data_dir or args.out).resolve()
    if out != data_dir and data_dir not in out.parents:
        parser.error("--out must be inside --data-dir")
    if (out / "tracks").exists() and any((out / "tracks").iterdir()):
        parser.error("--out already holds tracks from another run; use a new directory")
    out.mkdir(parents=True, exist_ok=True)
    stop = threading.Event()
    emit = Emitter(stop)
    signal.signal(signal.SIGINT, lambda *_: stop.set())  # Ctrl+C stops gracefully
    try:
        from app.live.runner import LiveRunner
        open_source = source_factory(payload["source"])
        model, recognizer = load_models(snapshot)
        runner = LiveRunner(snapshot, out, open_source, emit, model, recognizer, data_dir=data_dir,
                            min_confidence=args.min_confidence, max_track_seconds=args.max_track_seconds,
                            max_reconnects=args.max_reconnects, buffer_seconds=args.buffer_seconds,
                            exclude_zones=payload["source"].get("exclude_zones") or ())
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        code = getattr(exc, "code", "PIPELINE_FAILED")
        emit(dict(type="error", code=code if code in STARTUP_CODES else "PIPELINE_FAILED", message=str(exc)))
        emit(dict(type="status", status="failed", reason="startup"))
        return 1
    if not args.ignore_stdin:  # after the heavy imports, see watch_stdin
        threading.Thread(target=watch_stdin, args=(stop,), name="stdin-control", daemon=True).start()
    status = runner.run(stop)
    return 0 if status in ("ended", "stopped") else 1


if __name__ == "__main__":
    raise SystemExit(main())
