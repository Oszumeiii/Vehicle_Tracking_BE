"""Shared live host: python -m app.live --host --data-dir DIR [--sampling-scale S]

Runs several live sessions in one process so they share a single copy of the
detector and OCR model (two processes each loading them overcommit an 8 GB GPU).
Each session is a LiveRunner on its own thread; model calls take turns on one GPU
thread, while decoding, tracking and evidence writing overlap.

Commands are JSON lines on stdin:
  {"cmd": "start", "session": ID, "payload": PATH, "out": DIR,
   "min_confidence": 0.96, "max_track_seconds": 30}
  {"cmd": "stop", "session": ID}
  {"cmd": "job", "job": ID, "payload": PATH}   an upload job (recognition-input.json)
  {"cmd": "stop_job", "job": ID}
EOF (or {"cmd": "shutdown"}) stops every session; open tracks are finished first.
A job runs app.recognition.runner.execute with the shared models and writes
progress.json / recognition-result.json next to its payload, like the job subprocess;
its end is {"type": "exit", "job": ID, "code": 0|1}.
Events are the single-session JSON lines plus "session": ID, and a final
{"type": "exit", "session": ID, "code": 0|1} once a session's thread is done.
Host-level events have no session: {"type": "host", "status": "ready"|"stopped"}.
"""
from concurrent.futures import Future
import itertools
import queue
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import signal
import sys
import threading
import time
import traceback

from app.live import DEFAULT_MIN_CONFIDENCE

STARTUP_CODES = {"ENVIRONMENT_ERROR", "CUDA_UNAVAILABLE", "CUDA_ERROR", "CHECKPOINT_MISSING", "PIPELINE_FAILED"}


def absolute(path):
    r"""Normalized absolute path, without touching the filesystem.

    On Windows, Path.resolve() of a missing directory can return a \\?\ path while
    another session is creating its parent, which wrongly failed the inside-data check.
    """
    return Path(os.path.abspath(path))


class HostEmitter:
    """Thread-safe JSON lines; a closed pipe (parent died) stops every session."""

    def __init__(self, stop_all):
        self.lock, self.closed, self.stop_all = threading.Lock(), False, stop_all

    def __call__(self, event):
        line = json.dumps({"time": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                           **event}, ensure_ascii=False, allow_nan=False)
        with self.lock:
            if self.closed:
                return
            try:
                sys.stdout.write(line + "\n")
                sys.stdout.flush()
            except OSError:
                self.closed = True
                sys.stdout = open(os.devnull, "w")
                self.stop_all()


class GpuThread:
    """One thread that runs every model call; live sessions go before upload jobs.

    A job's detector batch (~0.5 s) queued ahead of a camera's would stall that camera
    past its frame buffer. Calls from job threads (named job-*) wait behind any call
    from a live session; calls of the same kind keep their order.
    """

    def __init__(self, name="live-gpu"):
        self.queue, self.order = queue.PriorityQueue(), itertools.count()
        threading.Thread(target=self._run, name=name, daemon=True).start()

    def submit(self, fn, *args, **kwargs):
        future = Future()
        rank = 1 if threading.current_thread().name.startswith("job-") else 0
        self.queue.put((rank, next(self.order), future, fn, args, kwargs))
        return future

    def _run(self):
        while True:
            _, _, future, fn, args, kwargs = self.queue.get()
            if not future.set_running_or_notify_cancel():
                continue
            try:
                future.set_result(fn(*args, **kwargs))
            except BaseException as exc:  # noqa: BLE001 - handed to the caller
                future.set_exception(exc)


class RealTime:
    """Hold a job to the video's own pace while live sessions run in the host.

    A job decodes and tracks as fast as it can, and in the same process that competes
    with the cameras for CPU and the GIL (measured: 2-5% of camera frames dropped
    during a job). At real time the job adds about one more camera's load. Without
    sessions the job runs at full speed.
    """

    def __init__(self, busy, clock=time.monotonic, sleep=time.sleep):
        self.busy, self.clock, self.sleep = busy, clock, sleep
        self.anchor = None  # (wall, video timestamp)

    def __call__(self, timestamp):
        if not self.busy():
            self.anchor = None
            return
        now = self.clock()
        if self.anchor is None:
            self.anchor = (now, timestamp)
            return
        ahead = (timestamp - self.anchor[1]) - (now - self.anchor[0])
        if ahead > 0:
            self.sleep(ahead)


class SharedModels:
    """One detector and recognizer for every session; model calls run on one thread.

    Ultralytics predictors keep per-call state, so two threads must not predict on
    the same model at once. CUDA also prepares fp16 kernels per batch size and per
    calling thread (about 1.8 s each), so a single GPU thread lets every session
    reuse one warm-up. Sessions must use the pipeline that was loaded first.
    """

    def __init__(self, load):
        self.load, self.lock, self.loaded = load, threading.Lock(), None
        self.gpu = GpuThread()

    @staticmethod
    def key(snapshot):
        return json.dumps([snapshot.get("id"), snapshot.get("version"), snapshot.get("device"),
                           snapshot.get("detector"), snapshot.get("recognizer")], sort_keys=True)

    def get(self, snapshot):
        with self.lock:
            if self.loaded is None:
                model, recognizer = self.load(snapshot)
                self.loaded = (self.key(snapshot), GpuModel(model, self.gpu), self._on_gpu(recognizer))
            elif self.loaded[0] != self.key(snapshot):
                raise ValueError("The shared live process already runs another pipeline; "
                                 "all concurrent live sessions must use the same pipeline")
            return self.loaded[1], self.loaded[2]

    def _on_gpu(self, recognizer):
        def recognize(images):
            return self.gpu.submit(recognizer, images).result()
        return recognize


class GpuModel:
    """Detector proxy whose predict runs on the shared GPU thread.

    warmed holds the frame shapes any session already warmed up (LiveRunner._warm_up).
    """

    def __init__(self, inner, gpu):
        self.inner, self.gpu, self.warmed = inner, gpu, set()
        self.names = getattr(inner, "names", None)

    def predict(self, *args, **kwargs):
        return self.gpu.submit(self.inner.predict, *args, **kwargs).result()


class Host:
    def __init__(self, data_dir, models, emit_factory=HostEmitter, *, sampling_scale=1., buffer_seconds=1.5,
                 source_factory=None, runner_factory=None):
        if not 0 < sampling_scale <= 1:
            raise ValueError("sampling_scale must be in (0, 1]")
        self.data_dir, self.models, self.sampling_scale = absolute(data_dir), models, sampling_scale
        self.buffer_seconds = buffer_seconds
        self.sessions, self.jobs, self.lock = {}, {}, threading.Lock()
        self.emit = emit_factory(self.stop_all)
        if source_factory is None:
            from app.live.__main__ import source_factory
        if runner_factory is None:
            from app.live.runner import LiveRunner as runner_factory
        self.source_factory, self.runner_factory = source_factory, runner_factory

    def stop_all(self):
        with self.lock:
            for stop, _ in [*self.sessions.values(), *self.jobs.values()]:
                stop.set()

    def command(self, message):
        cmd, session = message.get("cmd"), message.get("session")
        if cmd == "shutdown":
            return False
        if cmd in ("job", "stop_job"):
            job = message.get("job")
            if not isinstance(job, str) or not job:
                self.emit(dict(type="host", status="error", message=f"Command without job: {message}"))
            elif cmd == "job":
                self.start_job(job, message)
            else:
                with self.lock:
                    entry = self.jobs.get(job)
                if entry:
                    entry[0].set()
            return True
        if not isinstance(session, str) or not session:
            self.emit(dict(type="host", status="error", message=f"Command without session: {message}"))
        elif cmd == "start":
            self.start(session, message)
        elif cmd == "stop":
            with self.lock:
                entry = self.sessions.get(session)
            if entry:
                entry[0].set()
        else:
            self.emit(dict(type="host", status="error", message=f"Unknown command: {cmd}"))
        return True

    def start(self, session, message):
        emit = lambda event: self.emit({**event, "session": session})  # noqa: E731
        with self.lock:
            if session in self.sessions:
                emit(dict(type="error", code="PIPELINE_FAILED", message="Session already running"))
                return
            stop = threading.Event()
            thread = threading.Thread(target=self.run, args=(session, message, stop, emit), daemon=True,
                                      name=f"live-{session[:8]}")
            self.sessions[session] = (stop, thread)
        thread.start()

    def run(self, session, message, stop, emit):
        code = 1
        try:
            try:
                payload = json.loads(Path(message["payload"]).read_text(encoding="utf-8-sig"))
                out = absolute(message["out"])
                if out != self.data_dir and self.data_dir not in out.parents:
                    raise ValueError("out must be inside the host data directory")
                if (out / "tracks").exists() and any((out / "tracks").iterdir()):
                    raise ValueError("out already holds tracks from another run")
                out.mkdir(parents=True, exist_ok=True)
                snapshot = payload["pipeline_snapshot"]
                model, recognizer = self.models.get(snapshot)
                runner = self.runner_factory(
                    snapshot, out, self.source_factory(payload["source"]), emit, model, recognizer,
                    data_dir=self.data_dir, min_confidence=float(message.get("min_confidence", DEFAULT_MIN_CONFIDENCE)),
                    max_track_seconds=float(message.get("max_track_seconds", 30.)),
                    buffer_seconds=self.buffer_seconds, exclude_zones=payload["source"].get("exclude_zones") or (),
                    sampling_scale=self.sampling_scale)
            except Exception as exc:  # noqa: BLE001 - reported to this session only
                traceback.print_exc()
                error_code = getattr(exc, "code", "PIPELINE_FAILED")
                emit(dict(type="error", code=error_code if error_code in STARTUP_CODES else "PIPELINE_FAILED",
                          message=str(exc)))
                emit(dict(type="status", status="failed", reason="startup"))
                return
            try:
                status = runner.run(stop)
                code = 0 if status in ("ended", "stopped") else 1
            except Exception as exc:  # noqa: BLE001 - one session failing never stops the others
                traceback.print_exc()
                emit(dict(type="error", code="PIPELINE_FAILED", message=str(exc) or repr(exc)))
                emit(dict(type="status", status="failed", reason=str(exc) or repr(exc)))
        finally:
            with self.lock:
                self.sessions.pop(session, None)
            emit(dict(type="exit", code=code))

    def start_job(self, job, message):
        emit = lambda event: self.emit({**event, "job": job})  # noqa: E731
        with self.lock:
            if job in self.jobs:
                emit(dict(type="exit", code=1))
                return
            stop = threading.Event()
            thread = threading.Thread(target=self.run_job, args=(job, message, stop, emit), daemon=True,
                                      name=f"job-{job[:8]}")
            self.jobs[job] = (stop, thread)
        thread.start()

    def run_job(self, job, message, stop, emit):
        """One upload job on the shared models; results go to files exactly as the job subprocess writes them."""
        from app.recognition.runner import error_result, execute, write_json
        code, folder = 1, None
        try:
            payload_file = absolute(message["payload"])
            if self.data_dir not in payload_file.parents:
                raise ValueError("payload must be inside the host data directory")
            folder = payload_file.parent
            payload = json.loads(payload_file.read_text(encoding="utf-8"))
            if absolute(payload["output_dir"]) != folder:
                raise ValueError("output_dir must be the payload's folder")
            models = self.models.get(payload["pipeline_snapshot"])
            result = execute(payload, models=models, stop=stop, throttle=RealTime(lambda: bool(self.sessions)))
            write_json(folder / "recognition-result.json", {"ok": True, **result})
            code = 0
        except Exception as exc:  # noqa: BLE001 - reported through the job's result file
            traceback.print_exc()
            if folder is not None:
                try:
                    write_json(folder / "recognition-result.json", error_result(exc))
                except OSError:
                    traceback.print_exc()
        finally:
            with self.lock:
                self.jobs.pop(job, None)
            emit(dict(type="exit", code=code))

    def serve(self, lines):
        """Handle commands until EOF or shutdown, then stop and wait for every session."""
        self.emit(dict(type="host", status="ready", sampling_scale=self.sampling_scale))
        for line in lines:
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except ValueError:
                self.emit(dict(type="host", status="error", message=f"Not JSON: {line[:200]}"))
                continue
            if not self.command(message):
                break
        self.stop_all()
        with self.lock:
            threads = [thread for _, thread in [*self.sessions.values(), *self.jobs.values()]]
        for thread in threads:
            thread.join()
        self.emit(dict(type="host", status="stopped"))


def stdin_lines():
    """Read the raw descriptor (see __main__.watch_stdin) and yield decoded lines."""
    pending, fd = b"", sys.stdin.fileno()
    while True:
        chunk = os.read(fd, 4096)
        if not chunk:
            break
        *lines, pending = (pending + chunk).split(b"\n")
        for line in lines:
            yield line.decode("utf-8", "replace")
    if pending.strip():
        yield pending.decode("utf-8", "replace")


def main_host(args):
    from app.live.__main__ import load_models

    host = Host(args.data_dir, SharedModels(load_models), sampling_scale=args.sampling_scale,
                buffer_seconds=args.buffer_seconds)
    signal.signal(signal.SIGINT, lambda *_: host.stop_all())
    host.serve(stdin_lines())
    return 0
