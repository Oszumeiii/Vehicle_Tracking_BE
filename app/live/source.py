"""Live frame sources: YouTube Live via yt-dlp + ffmpeg, recorded files for replay and tests.

A source connection is an iterable of (pts_seconds, bgr_image) with close(). LiveReader
consumes one connection on a background thread, numbers the frames, and keeps only
the newest ones when the consumer falls behind.
"""
from collections import deque
from contextlib import closing
from datetime import datetime, timezone
import re
import subprocess
import threading
import time

import numpy as np

from app.recognition.video_tracking import read_frames, small_gray


class StreamEnded(Exception):
    """The source is over (broadcast ended or file exhausted); do not reconnect."""


class SourceError(Exception):
    """A connection failed or stalled; reconnecting may help."""


def resolve_youtube(url, ydl_class=None):
    """Current HLS URL and video geometry of a YouTube broadcast that is live now.

    Errors yt-dlp marks as expected (removed, private, region-blocked) are final and
    raise StreamEnded; anything else (network, extractor hiccup) may be retried.
    """
    from yt_dlp.utils import DownloadError
    if ydl_class is None:
        from yt_dlp import YoutubeDL as ydl_class
    options = dict(quiet=True, no_warnings=True, noplaylist=True, format="bv*[height<=1080]",
                   js_runtimes={"node": {}})
    try:
        with ydl_class(options) as ydl:
            info = ydl.extract_info(url, download=False)
    except DownloadError as exc:
        cause = (exc.exc_info or (None, None, None))[1]
        if getattr(cause, "expected", False):
            raise StreamEnded(str(cause)) from exc
        raise SourceError(str(exc)) from exc
    status = info.get("live_status")
    if status != "is_live":
        raise StreamEnded(f"YouTube video is not live (live_status={status})")
    selected = info if info.get("url") else (info.get("requested_formats") or [{}])[0]
    width, height, fps = selected.get("width"), selected.get("height"), selected.get("fps")
    if not selected.get("url") or not width or not height or not fps:
        raise SourceError("YouTube did not return a playable video format")
    return dict(url=selected["url"], width=int(width), height=int(height), fps=float(fps),
                video_id=str(info.get("id") or "live"), title=info.get("title") or "")


SHOWINFO = re.compile(rb"Parsed_showinfo.*?\bn:\s*(\d+).*?\bpts_time:\s*(-?[\d.]+)")


class FfmpegFrames:
    """Decode a network stream with ffmpeg: raw BGR frames on stdout, their PTS from showinfo on stderr."""

    finite = False

    def __init__(self, url, width, height, ffmpeg=None, rw_timeout_seconds=15):
        if ffmpeg is None:
            import imageio_ffmpeg
            ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        self.size, self.shape = width * height * 3, (height, width, 3)
        # -re: HLS delivers whole segments (~5 s) at once; decoding them at native rate
        # instead of in bursts keeps the bounded reader buffer from dropping frames.
        self.command = [ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "info", "-re",
                        "-rw_timeout", str(int(rw_timeout_seconds * 1e6)), "-i", url, "-an",
                        "-vf", "showinfo", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "bgr24",
                        "pipe:1"]
        self.process = self.job = None
        self.pts, self.errors = deque(), deque(maxlen=20)
        self._pts_ready, self._stderr_done = threading.Condition(), False

    def __iter__(self):
        import os
        from app.core.processes import WindowsJob
        self.job = WindowsJob() if os.name == "nt" else None
        self.process = subprocess.Popen(self.command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, bufsize=0)
        if self.job:
            self.job.assign(self.process)  # ffmpeg dies with this process
        threading.Thread(target=self._read_stderr, name="ffmpeg-stderr", daemon=True).start()
        expected = 0
        while True:
            frame = self._read_frame()
            if frame is None:
                code = self.process.wait()
                raise SourceError(f"ffmpeg stopped (exit {code}): {' | '.join(self.errors) or 'no output'}")
            with self._pts_ready:
                self._pts_ready.wait_for(lambda: self.pts or self._stderr_done, timeout=5)
                if not self.pts:
                    raise SourceError("ffmpeg produced a frame without its timestamp")
                number, pts = self.pts.popleft()
            if number != expected:
                raise SourceError("Frame and timestamp streams are out of step")
            expected += 1
            yield pts, frame

    def _read_frame(self):
        buffer = bytearray(self.size)
        view, got = memoryview(buffer), 0
        while got < self.size:
            count = self.process.stdout.readinto(view[got:])
            if not count:
                return None
            got += count
        return np.frombuffer(buffer, np.uint8).reshape(self.shape)

    def _read_stderr(self):
        for line in self.process.stderr:
            match = SHOWINFO.search(line)
            if match:
                with self._pts_ready:
                    self.pts.append((int(match.group(1)), float(match.group(2))))
                    self._pts_ready.notify_all()
            elif b"rror" in line or b"failed" in line.lower():
                self.errors.append(line.decode(errors="replace").strip()[:300])
        with self._pts_ready:
            self._stderr_done = True
            self._pts_ready.notify_all()

    def close(self):
        if self.process and self.process.poll() is None:
            self.process.kill()
        if self.process:
            self.process.wait()
        if self.job:
            self.job.close()
            self.job = None


class FileFrames:
    """A recorded video as a live source; realtime=True paces frames at their PTS.

    Without pacing the file is replayed losslessly: the reader waits for the
    consumer instead of dropping frames, so results match the file pipeline.
    """

    finite = True

    def __init__(self, path, realtime=False, clock=time.monotonic):
        self.path, self.realtime, self.clock = path, realtime, clock
        self.lossless = not realtime
        self._closed = threading.Event()

    def __iter__(self):
        with closing(read_frames(self.path)) as frames:
            start = None
            for _, pts, image, _ in frames:
                if self._closed.is_set():
                    return
                if self.realtime:
                    start = self.clock() - pts if start is None else start
                    delay = start + pts - self.clock()
                    if delay > 0 and self._closed.wait(delay):
                        return
                yield pts, image

    def close(self):
        self._closed.set()


class LiveReader:
    """Read one connection on a background thread into a bounded, drop-oldest buffer.

    get() returns (index, pts, image, gray, received_at), None once the connection
    ended, or raises the connection's error. Every frame read gets the next index,
    including dropped ones, so sampling and tracker timing still see real gaps.
    A connection with lossless=True (unpaced file replay) is never dropped from.
    """

    def __init__(self, connection, capacity=8):
        if capacity < 1:
            raise ValueError("capacity must be >= 1")
        self.connection, self.capacity = connection, capacity
        self.lossless = bool(getattr(connection, "lossless", False))
        self.frames, self.done, self.error = deque(), False, None
        self.read = self.dropped = 0
        self._ready, self._stop = threading.Condition(), threading.Event()
        self._thread = threading.Thread(target=self._run, name="live-reader", daemon=True)

    def start(self):
        self._thread.start()
        return self

    def _run(self):
        previous = None
        frames = iter(self.connection)
        try:
            for pts, image in frames:
                if self._stop.is_set():
                    break
                if previous is not None and not pts > previous:
                    raise SourceError(f"Timestamps went backwards ({previous:.3f} -> {pts:.3f} s)")
                previous = pts
                frame = (self.read + 1, pts, image, small_gray(image), datetime.now(timezone.utc))
                with self._ready:
                    self.read += 1
                    if self.lossless:
                        self._ready.wait_for(lambda: len(self.frames) < self.capacity or self._stop.is_set())
                    elif len(self.frames) >= self.capacity:
                        self.frames.popleft()
                        self.dropped += 1
                    self.frames.append(frame)
                    self._ready.notify_all()
        except BaseException as exc:  # noqa: BLE001 - handed to the consumer
            self.error = exc if isinstance(exc, (SourceError, StreamEnded)) else SourceError(str(exc) or repr(exc))
        finally:
            close = getattr(frames, "close", None)
            if close:
                close()  # a generator is closed on its own thread
            with self._ready:
                self.done = True
                self._ready.notify_all()

    def get(self, timeout):
        """Next frame; TIMEOUT if none arrived within timeout seconds."""
        with self._ready:
            self._ready.wait_for(lambda: self.frames or self.done, timeout=timeout)
            if self.frames:
                frame = self.frames.popleft()
                self._ready.notify_all()  # a lossless producer may be waiting for room
                return frame
            if self.done:
                if self.error is not None:
                    raise self.error
                return None
            return TIMEOUT

    def stop(self):
        with self._ready:
            self._stop.set()
            self._ready.notify_all()
        self.connection.close()
        self._thread.join(timeout=10)


TIMEOUT = object()
