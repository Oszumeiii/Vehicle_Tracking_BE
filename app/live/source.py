"""Live frame sources: YouTube Live via yt-dlp + ffmpeg, recorded files for replay and tests.

A source connection is an iterable of (pts_seconds, bgr_image) with close(). LiveReader
consumes one connection on a background thread, numbers the frames, and keeps only
the newest ones when the consumer falls behind.
"""
from collections import deque
from contextlib import closing
from datetime import datetime, timedelta, timezone
import io
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


def resolve_youtube(url, ydl_class=None, max_height=1080):
    """Current HLS URL and video geometry of a YouTube broadcast that is live now.

    max_height trades plate detail for bitrate: 1080p needs ~4 Mbit/s sustained.

    Errors yt-dlp marks as expected (removed, private, region-blocked) are final and
    raise StreamEnded; anything else (network, extractor hiccup) may be retried.
    """
    from yt_dlp.utils import DownloadError
    if ydl_class is None:
        from yt_dlp import YoutubeDL as ydl_class
    options = dict(quiet=True, no_warnings=True, noplaylist=True, format=f"bv*[height<={int(max_height)}]",
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
OPENING = re.compile(rb"Opening '[^']*/sq/(\d+)/")


class Pacer:
    """Release frames at native rate and bound catch-up after a stall.

    Frames that were already buffered (backlog after a stall) are released at most
    `catchup` x real time, below the pipeline's ~1.5x capacity, so the reader does not
    drop frames all over its tracks. Beyond `max_lag` a buffered stretch is skipped in
    one piece. When the source itself is slow (frames had to be waited for) there is
    nothing to catch up from and the schedule restarts; a forward PTS jump (expired
    segments skipped by ffmpeg) restarts it too.
    """

    def __init__(self, catchup=1.3, max_lag=20.0, clock=time.monotonic, sleep=time.sleep):
        self.catchup, self.max_lag, self.clock, self.sleep = catchup, max_lag, clock, sleep
        self.anchor = self.last = None  # (wall, pts)
        self.lag = self.skipped_seconds = 0.0
        self.skipped = 0
        self._previous = None

    def admit(self, pts, waited):
        """True to deliver the frame (after pacing), False to skip it. waited: seconds spent reading it."""
        now, previous, self._previous = self.clock(), self._previous, pts
        if self.anchor is None or self.anchor[0] + (pts - self.anchor[1]) - now > 2.0:
            self.anchor = self.last = (now, pts)
            self.lag = 0.0
            return True
        self.lag = now - (self.anchor[0] + (pts - self.anchor[1]))
        if self.lag > self.max_lag:
            if waited < 0.01 and previous is not None:
                self.skipped += 1
                self.skipped_seconds += pts - previous
                return False
            self.anchor = self.last = (now, pts)  # source-limited: accept the delay
            self.lag = 0.0
            return True
        release = max(self.anchor[0] + (pts - self.anchor[1]),
                      self.last[0] + (pts - self.last[1]) / self.catchup)
        if release > now:
            self.sleep(release - now)
        self.last = (max(release, now), pts)
        return True


def parse_playlist(text):
    """(media sequence, program date-time of its first segment, segment durations) of an HLS media playlist."""
    sequence = re.search(r"#EXT-X-MEDIA-SEQUENCE:(\d+)", text)
    start = re.search(r"#EXT-X-PROGRAM-DATE-TIME:(\S+)", text)
    if not sequence or not start:
        return None
    durations = [float(d) for d in re.findall(r"#EXTINF:([\d.]+)", text)]
    target = re.search(r"#EXT-X-TARGETDURATION:(\d+)", text)
    return dict(sequence=int(sequence.group(1)), start=datetime.fromisoformat(start.group(1).replace("Z", "+00:00")),
                durations=durations, target=float(target.group(1)) if target else (durations or [5.0])[-1])


def segment_start(playlist, sequence):
    """Program date-time when a segment starts; segments past the list are extrapolated."""
    index = sequence - playlist["sequence"]
    if index < 0:
        return None
    known = playlist["durations"]
    seconds = sum(known[:index]) + max(0, index - len(known)) * playlist["target"]
    return playlist["start"] + timedelta(seconds=seconds)


class FfmpegFrames:
    """Decode a network stream with ffmpeg: raw BGR frames on stdout, their PTS from showinfo on stderr.

    -copyts keeps the segments' own timestamps, which map to the playlist's
    #EXT-X-PROGRAM-DATE-TIME with a constant offset: the first segment ffmpeg opens
    (logged with its /sq/ number) anchors stream_time(), the broadcast's wall clock.
    """

    finite = False

    def __init__(self, url, width, height, ffmpeg=None, rw_timeout_seconds=15, pacer=None, fetch=None,
                 hwaccel=None, threads=None):
        if ffmpeg is None:
            import imageio_ffmpeg
            ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        self.url, self.size, self.shape = url, width * height * 3, (height, width, 3)
        # -re keeps reading at native rate at the live edge (HLS delivers ~5 s segments at
        # once). After a stall -re bursts to catch up (~4x measured), faster than the
        # pipeline; Pacer caps that catch-up so the reader does not drop frames mid-track.
        # HLS starts at the newest segment instead of three behind the live edge.
        hls = ["-live_start_index", "-1"] if url.startswith(("http://", "https://")) else []
        # Decoding is the main CPU cost per camera: ffmpeg's default (one decoder thread
        # per core in every process) oversubscribes the CPU with several cameras, and
        # -hwaccel cuda moves decoding to the GPU's NVDEC unit.
        decode = (["-hwaccel", hwaccel] if hwaccel else []) + (["-threads", str(threads)] if threads else [])
        # showinfo's default per-frame checksum and plane statistics are never used.
        self.command = [ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "info", "-re", "-copyts", *hls,
                        "-rw_timeout", str(int(rw_timeout_seconds * 1e6)), *decode, "-i", url, "-an",
                        "-vf", "showinfo=checksum=0", "-fps_mode", "passthrough", "-f", "rawvideo",
                        "-pix_fmt", "bgr24", "pipe:1"]
        self.pacer = pacer or Pacer()
        self.fetch = fetch or _fetch_text
        self.process = self.job = None
        self.pts, self.errors = deque(), deque(maxlen=20)
        self._pts_ready, self._stderr_done = threading.Condition(), False
        self.first_sequence = self.first_pts = self._segment_time = None

    def stream_time(self, pts):
        """Broadcast wall clock (UTC) of a frame, or None until the playlist anchored it."""
        if self._segment_time is None or self.first_pts is None:
            return None
        return self._segment_time + timedelta(seconds=pts - self.first_pts)

    def _anchor(self, sequence):
        try:
            playlist = parse_playlist(self.fetch(self.url))
            self._segment_time = playlist and segment_start(playlist, sequence)
        except Exception:  # noqa: BLE001 - without an anchor captures fall back to receive time
            self._segment_time = None

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
            started = time.monotonic()
            frame = self._read_frame()
            waited = time.monotonic() - started
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
            if self.first_pts is None:
                self.first_pts = pts
            if self.pacer.admit(pts, waited):
                yield pts, frame

    def _read_frame(self):
        frame = np.empty(self.shape, np.uint8)  # not zero-filled: every byte is read below
        view, got = memoryview(frame.reshape(-1)), 0
        while got < self.size:
            count = self.process.stdout.readinto(view[got:])
            if not count:
                return None
            got += count
        return frame

    def _read_stderr(self):
        # The pipes are unbuffered for the frame reads; readline on a raw pipe reads one
        # byte per system call, hundreds per showinfo line, all holding the GIL.
        stderr = self.process.stderr
        if isinstance(stderr, io.RawIOBase):
            stderr = io.BufferedReader(stderr, 1 << 16)
        for line in stderr:
            match = SHOWINFO.search(line)
            opening = None if match else OPENING.search(line)
            if opening and self.first_sequence is None:
                self.first_sequence = int(opening.group(1))
                threading.Thread(target=self._anchor, args=(self.first_sequence,), name="hls-anchor",
                                 daemon=True).start()
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


def _fetch_text(url):
    import urllib.request
    with urllib.request.urlopen(url, timeout=10) as response:
        return response.read().decode("utf-8", errors="replace")


class FileFrames:
    """A recorded video as a live source; realtime=True paces frames at their PTS.

    Without pacing the file is replayed losslessly: the reader waits for the
    consumer instead of dropping frames, so results match the file pipeline.
    loop=True replays the file forever (demo cameras); PTS keep increasing across
    passes, so tracking and capture times see one continuous stream.
    """

    def __init__(self, path, realtime=False, clock=time.monotonic, loop=False):
        self.path, self.realtime, self.clock, self.loop = path, realtime, clock, loop
        self.lossless = not realtime
        self.finite = not loop
        self._closed = threading.Event()

    def __iter__(self):
        start, offset = None, 0.
        while True:
            last, step = None, 0.
            with closing(read_frames(self.path)) as frames:
                for _, pts, image, gray in frames:
                    if self._closed.is_set():
                        return
                    if last is not None:
                        step = pts - last
                    last = pts
                    pts += offset
                    if self.realtime:
                        start = self.clock() - pts if start is None else start
                        delay = start + pts - self.clock()
                        if delay > 0 and self._closed.wait(delay):
                            return
                    yield pts, image, gray  # the decoder thread already made the small gray
            if not self.loop or last is None:
                return
            offset += last + (step or 1 / 30)

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
            for item in frames:
                if self._stop.is_set():
                    break
                # Connections yield (pts, image) or (pts, image, small gray) when already computed.
                pts, image = item[0], item[1]
                gray = item[2] if len(item) > 2 else small_gray(image)
                if previous is not None and not pts > previous:
                    raise SourceError(f"Timestamps went backwards ({previous:.3f} -> {pts:.3f} s)")
                previous = pts
                frame = (self.read + 1, pts, image, gray, datetime.now(timezone.utc))
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
