"""Rolling recording of a live epoch: index the segments ffmpeg writes and drop old ones.

FfmpegFrames(record_dir=...) makes ffmpeg also copy the stream (no re-encoding) into
10-second MP4 segments (indexed, so cuts seek exactly) and list each closed one in segments.csv
("file,pts_start,pts_end", the same PTS timeline as the decoded frames). The recorder
adds the wall-clock span of every closed segment (the tracks' own clock, see
runner.capture_times) and its keyframes to index.jsonl, which clips.py cuts from.
"""
import json
from pathlib import Path
import threading
import time
from datetime import datetime, timedelta, timezone

from app.live.clips import keyframes


class Recorder:
    def __init__(self, folder, to_utc, keep_minutes=240, ffmpeg=None, interval=1.0, now=None):
        self.folder, self.to_utc, self.keep = Path(folder), to_utc, timedelta(minutes=keep_minutes)
        self.ffmpeg, self.interval = ffmpeg, interval
        self.now = now or (lambda: datetime.now(timezone.utc))
        self.entries, self.seen = [], 0
        self.covered = None  # PTS up to which closed segments exist
        self.lock, self._stop = threading.Lock(), threading.Event()
        self._thread = None

    def start(self):
        self._thread = threading.Thread(target=self._run, name="recorder", daemon=True)
        self._thread.start()
        return self

    def stop(self):
        """Index what ffmpeg closed before it stopped."""
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=30)
        self.scan()

    def _run(self):
        while not self._stop.wait(self.interval):
            try:
                self.scan()
            except Exception:  # noqa: BLE001 - recording must never stop recognition
                pass

    def scan(self):
        """Index newly closed segments and delete those older than keep_minutes."""
        listing = self.folder / "segments.csv"
        try:
            lines = listing.read_text(encoding="utf-8").splitlines()
        except OSError:
            return
        added = []
        for line in lines[self.seen:]:
            parts = line.strip().split(",")
            if len(parts) < 3:
                break  # a line ffmpeg is still writing
            name, start, end = parts[0], float(parts[1]), float(parts[2])
            first, times = keyframes(self.folder / name, self.ffmpeg)
            # With -copyts ffmpeg lists the first segment of an HLS stream from 0, not from the
            # stream's PTS; the segment's own first keyframe is its true start.
            if start < first - .5:
                start = first
            utc_start, utc_end = self.to_utc(start, end)
            added.append(dict(file=name, pts_start=start, pts_end=end, utc_start=utc_start, utc_end=utc_end,
                              first_ts=first, keyframes=times))
            self.seen += 1
        with self.lock:
            self.entries += added
            if added:
                self.covered = added[-1]["pts_end"]
            cutoff = self.now() - self.keep
            old = [e for e in self.entries
                   if datetime.fromisoformat(e["utc_end"].replace("Z", "+00:00")) < cutoff]
            for entry in old:
                (self.folder / entry["file"]).unlink(missing_ok=True)
            self.entries = [e for e in self.entries if e not in old]
            if added or old:
                partial = self.folder / "index.jsonl.tmp"
                partial.write_text("".join(json.dumps(e) + "\n" for e in self.entries), encoding="utf-8")
                partial.replace(self.folder / "index.jsonl")

    def snapshot(self):
        with self.lock:
            return [{**e, "dir": str(self.folder)} for e in self.entries]


class ClipMaker:
    """Cut each requested track's clip once the epoch's recording covers it (own thread).

    source is a Recorder (network stream) or a demo video (path, duration): a looped
    file plays PTS p at p mod duration. finish() cuts what is left with what was recorded.
    """

    def __init__(self, out, emit, pad=3.0, recorder=None, video=None, ffmpeg=None, interval=0.5):
        from collections import deque
        self.out, self.emit, self.pad, self.ffmpeg = Path(out), emit, pad, ffmpeg
        self.recorder, self.video, self.interval = recorder, video, interval
        self.pending, self.lock, self._stop = deque(), threading.Lock(), threading.Event()
        self._finishing = False
        self._file_entry = None
        self._thread = threading.Thread(target=self._run, name="clips", daemon=True)
        self._thread.start()

    def request(self, key, first, last):
        with self.lock:
            if all(item[0] != key for item in self.pending):
                self.pending.append((key, first, last))

    def finish(self, timeout=60):
        """Cut the remaining requests (the stream has ended), then stop."""
        self._finishing = True
        deadline = time.monotonic() + timeout
        while self.pending and time.monotonic() < deadline and self._thread.is_alive():
            time.sleep(.1)
        self._stop.set()
        self._thread.join(timeout=5)

    def _run(self):
        while not self._stop.wait(self.interval):
            with self.lock:
                ready = [item for item in self.pending if self._ready(item)]
            for item in ready:
                self._cut(*item)
                with self.lock:
                    self.pending.remove(item)
            if self._finishing and not self.pending:
                return

    def _ready(self, item):
        if self.video is not None or self._finishing:
            return True
        covered = self.recorder.covered if self.recorder else None
        return covered is not None and covered >= item[2] + self.pad

    def _cut(self, key, first, last):
        from app.live.clips import NotRecorded, cut, cut_demo, file_entry
        target = self.out / "clips" / f"{key}.mp4"
        try:
            if self.video is not None:
                path, duration = self.video
                if self._file_entry is None:
                    self._file_entry = file_entry(path, duration, self.ffmpeg)
                info = cut_demo(path, first, last, target, pad=self.pad, duration=duration,
                                entry=self._file_entry, ffmpeg=self.ffmpeg)
            else:
                start = first - self.pad
                info = cut(self.recorder.snapshot(), start, last + self.pad, target, clock="pts", ffmpeg=self.ffmpeg)
                info = dict(first_seen_offset=round(info["first_seen_offset"] + first - start, 3),
                            seconds=info["seconds"])
        except NotRecorded:
            return
        except Exception as exc:  # noqa: BLE001 - a missing clip never stops recognition
            self.emit(dict(type="clip_failed", track=key, message=str(exc)[:300]))
            return
        self.emit(dict(type="clip", track=key, path=target.relative_to(self.out).as_posix(),
                       # where the plate first shows up inside the clip
                       first_seen_offset=info["first_seen_offset"], seconds=info["seconds"]))
