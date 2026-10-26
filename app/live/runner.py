"""LiveRunner: connections (epochs) -> TrackSession -> per-track evidence + joint OCR -> events.

Each finished track gets its own folder OUT/tracks/e{epoch}-t{track}/ holding its
keyframes, crops and track.json (one appearance in the shape the Node validator
expects, timestamp_source "live_pts"). Confidence status and duplicate links are
advisory: every track is still recorded.
"""
from datetime import datetime, timedelta, timezone
import math
import time

from PIL import Image

from app.live import DEFAULT_MIN_CONFIDENCE
from app.live.source import TIMEOUT, LiveReader, SourceError, StreamEnded
from app.recognition.fusion import levenshtein
from app.recognition.runner import _predict_joint, build_appearance, write_json
from app.recognition.video_tracking import TrackSession, export_retained, tracking_config, warm_up_detector


def utc(value):
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def plate_confidence(prediction):
    decoding = prediction.get("decoding") or {}
    value = decoding.get("beam_confidence_proxy")
    return decoding.get("greedy_symbol_confidence") if value is None else value


def classify(text, confidence, threshold):
    if not text:
        return "unreadable"
    return "readable" if confidence is not None and confidence >= threshold else "low_confidence"


def box_iou(a, b):
    x1, y1, x2, y2 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0., x2 - x1) * max(0., y2 - y1)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.


def capture_times(clock, first, last):
    """Wall-clock interval of a track: the broadcast's own clock when the source provides one
    (HLS program date-time), else receive time of the epoch's first frame plus PTS offsets."""
    stream_time = clock["stream_time"]
    if stream_time is not None:
        start, end = stream_time(first), stream_time(last)
        received = clock["started_at"] + timedelta(seconds=first - clock["first_pts"])
        # A broadcast clock is trusted only if it lags receive time plausibly (YouTube: ~5-60 s).
        if start is not None and end is not None and -5 <= (received - start).total_seconds() <= 180:
            return "stream", utc(start), utc(end)

    def received_at(pts):
        return utc(clock["started_at"] + timedelta(seconds=pts - clock["first_pts"]))

    return "received", received_at(first), received_at(last)


class DuplicateLinker:
    """Link a track to an earlier one in the same epoch that is probably the same vehicle.

    Same vehicle: the new track starts within max_gap seconds of the earlier one's
    last observation, and either the plates differ by <= max_edit characters or the
    earlier track's last box overlaps the new track's first box (a queued car whose
    ID switched). Links point at the first track of the chain.
    """

    def __init__(self, max_gap=3.0, max_edit=1, min_iou=.5, window=10.0):
        self.max_gap, self.max_edit, self.min_iou, self.window = max_gap, max_edit, min_iou, window
        self.recent = []

    def reset(self):
        self.recent = []

    def link(self, key, text, first_seconds, last_seconds, first_box, last_box):
        self.recent = [r for r in self.recent if r["last_seconds"] >= first_seconds - self.window]
        match = None
        for earlier in self.recent:
            gap = first_seconds - earlier["last_seconds"]
            if not -self.max_gap <= gap <= self.max_gap or earlier["first_seconds"] >= first_seconds:
                continue
            same_text = (text and earlier["text"] and min(len(text), len(earlier["text"])) >= 5
                         and levenshtein(text, earlier["text"]) <= self.max_edit)
            if same_text or box_iou(earlier["last_box"], first_box) >= self.min_iou:
                match = earlier["root"]
                break
        self.recent.append(dict(key=key, root=match or key, text=text, first_seconds=first_seconds,
                                last_seconds=last_seconds, last_box=last_box))
        return match


class LiveRunner:
    def __init__(self, snapshot, out, open_source, emit, model, recognizer, *, data_dir=None,
                 min_confidence=DEFAULT_MIN_CONFIDENCE, max_track_seconds=30., max_reconnects=10, read_timeout=15.,
                 stats_interval=1., buffer_seconds=1.5, reader_capacity=None, backoff_max=30., exclude_zones=(),
                 sampling_scale=1.):
        if snapshot.get("recognizer", {}).get("input_mode") != "five_frame_joint":
            raise ValueError("Live recognition supports five_frame_joint pipelines only")
        self.exclude_zones = [list(map(float, zone)) for zone in exclude_zones]
        if any(len(z) != 4 or not 0 <= z[0] < z[2] <= 1 or not 0 <= z[1] < z[3] <= 1 for z in self.exclude_zones):
            raise ValueError("Exclude zones must be normalized [x1, y1, x2, y2] rectangles")
        self.snapshot, self.out, self.open_source, self.emit = snapshot, out, open_source, emit
        # Sessions sharing one GPU sample fewer frames for the detector; recorded with each track.
        if not 0 < sampling_scale <= 1:
            raise ValueError("sampling_scale must be in (0, 1]")
        self.sampling_scale = sampling_scale
        self.tracking_snapshot = snapshot if sampling_scale == 1 else {
            **snapshot, "sampling": {key: value * sampling_scale if key.endswith("_fps") else value
                                     for key, value in snapshot["sampling"].items()}}
        self.model, self.recognizer = model, recognizer
        self.data_dir = data_dir or out
        self.min_confidence, self.max_track_seconds = min_confidence, max_track_seconds
        self.max_reconnects, self.read_timeout = max_reconnects, read_timeout
        # The buffer must absorb one detector batch (~0.5 s for 16 frames at 1280 px):
        # frames dropped mid-track change which five crops are chosen and hurt OCR.
        self.buffer_seconds, self.reader_capacity = buffer_seconds, reader_capacity
        self.stats_interval, self.backoff_max = stats_interval, backoff_max
        self.linker = DuplicateLinker()
        self.tracks, self.warmed = 0, set()

    def _warm_up(self, cfg):
        """First CUDA calls take seconds; make them before frames start to arrive.

        A shared model (app/live/host.py) remembers what any session already warmed up.
        """
        key = (cfg["width"], cfg["height"], cfg["batch"], cfg["imgsz"])
        warmed = getattr(self.model, "warmed", self.warmed)
        if key in warmed:
            return
        warm_up_detector(self.model, cfg)
        self.recognizer([Image.new("RGB", (192, 48), (shade, shade, shade)) for shade in range(0, 250, 50)])
        warmed.add(key)

    def run(self, stop):
        """Run until the source ends, stop is set, or reconnecting keeps failing. Returns the final status."""
        self.emit(dict(type="status", status="starting"))
        epoch, failures = 0, 0
        while not stop.is_set():
            self.emit(dict(type="status", status="connecting", epoch=epoch))
            try:
                info, connection = self.open_source()
            except StreamEnded as exc:
                return self._final("ended", str(exc))
            except Exception as exc:  # noqa: BLE001 - network/extractor failures are retried
                outcome, reason, frames = "error", str(exc) or repr(exc), 0
            else:
                outcome, reason, frames = self._run_epoch(epoch, info, connection, stop)
                epoch += 1
            if outcome == "ended":
                return self._final("ended", reason)
            if stop.is_set():
                break
            failures = 0 if frames else failures + 1
            if failures > self.max_reconnects:
                return self._final("failed", reason)
            delay = min(self.backoff_max, 2 ** max(0, failures - 1))
            self.emit(dict(type="status", status="reconnecting", epoch=epoch, reason=reason, delay_seconds=delay))
            stop.wait(delay)
        return self._final("stopped", None)

    def _final(self, status, reason):
        self.emit(dict(type="status", status=status, reason=reason, tracks=self.tracks))
        return status

    def _run_epoch(self, epoch, info, connection, stop):
        cfg = {**tracking_config(info["width"], info["height"], info["fps"], 0, self.tracking_snapshot,
                                 info.get("video_id", "live")), "max_track_seconds": self.max_track_seconds,
               "exclude_zones": self.exclude_zones}
        self._warm_up(cfg)
        capacity = self.reader_capacity or max(8, math.ceil(self.buffer_seconds * info["fps"]))
        reader = LiveReader(connection, capacity).start()
        self.linker.reset()
        clock = dict(started_at=None, first_pts=None, stream_time=getattr(connection, "stream_time", None))
        outcome, reason, frames = "error", None, 0
        last_frame = last_stats = time.monotonic()
        processed_since = 0
        with TrackSession(self.model, cfg, retain_images=True) as session:
            try:
                while True:
                    # After stop, frames already received are still processed, then the epoch ends.
                    stopping = stop.is_set()
                    item = reader.get(timeout=0 if stopping else .5)
                    now = time.monotonic()
                    if stopping and (item is TIMEOUT or item is None):
                        break
                    if item is TIMEOUT:
                        if now - last_frame > self.read_timeout:
                            raise SourceError(f"No frames for {self.read_timeout:.0f} s")
                    elif item is None:
                        outcome, reason = ("ended", "source exhausted") if connection.finite else (
                            "error", "connection closed")
                        break
                    else:
                        index, pts, image, gray, received_at = item
                        if clock["started_at"] is None:
                            clock.update(started_at=received_at, first_pts=pts)
                            self.emit(dict(type="status", status="running", epoch=epoch,
                                           width=info["width"], height=info["height"], fps=info["fps"]))
                        frames += 1
                        processed_since += 1
                        last_frame = now
                        for candidate in session.push(index, pts, image, gray):
                            self._record(epoch, candidate, cfg, clock)
                    if now - last_stats >= self.stats_interval:
                        lag = (datetime.now(timezone.utc) - item[4]).total_seconds() if isinstance(item, tuple) else None
                        pacer = getattr(connection, "pacer", None)
                        self.emit(dict(type="stats", epoch=epoch, frames_read=reader.read,
                                       frames_dropped=reader.dropped, frames_processed=frames,
                                       sampled=session.sampled, active_tracks=len(session.active),
                                       tracks=self.tracks, rejected_tracks=sum(session.rejected.values()),
                                       excluded_zones=len(self.exclude_zones),
                                       retained_frames=session.retained_frames,
                                       retained_mib=round(session.retained_bytes / 2**20, 1),
                                       lag_seconds=None if lag is None else round(lag, 2),
                                       source_lag_seconds=pacer and round(pacer.lag, 2),
                                       skipped_seconds=pacer and round(pacer.skipped_seconds, 1),
                                       sampling_scale=self.sampling_scale,
                                       fps=round(processed_since / (now - last_stats), 2)))
                        last_stats, processed_since = now, 0
                if stop.is_set():
                    outcome, reason = "stopped", None
            except (SourceError, StreamEnded) as exc:
                outcome, reason = ("ended" if isinstance(exc, StreamEnded) else "error"), str(exc)
            finally:
                reader.stop()
            # Tracks seen before a failure or stop are still finished and recognized.
            for candidate in session.close():
                self._record(epoch, candidate, cfg, clock)
        return outcome, reason, frames

    def _record(self, epoch, candidate, cfg, clock):
        """One failed track (evidence or OCR) is reported without stopping the stream."""
        try:
            self._track(epoch, candidate, cfg, clock)
        except Exception as exc:  # noqa: BLE001
            self.emit(dict(type="error", code="TRACK_FAILED", epoch=epoch, track_id=candidate["track_id"],
                           message=str(exc) or repr(exc)))

    def _track(self, epoch, candidate, cfg, clock):
        key = f"e{epoch:03d}-t{int(candidate['track_id']):06d}"
        folder = self.out / "tracks" / key
        folder.mkdir(parents=True, exist_ok=False)
        manifest = export_retained([candidate], cfg, folder)
        appearance = build_appearance(candidate, manifest, folder, self.data_dir, candidate["first_seconds"],
                                      candidate["last_seconds"], "live_pts")
        detections = appearance["detections"]
        prediction = _predict_joint(self.recognizer, [self.data_dir / d["crop_storage_key"] for d in detections],
                                    self.data_dir)
        for detection in detections:
            detection["predictions"] = []
        text = prediction["normalized_text"] or None
        appearance.update(machine_text=text, machine_status="readable" if text else "unreadable",
                          agreement_count=None, recognition_method="joint_multiframe", predictions=[prediction])
        confidence = plate_confidence(prediction)
        status = classify(text, confidence, self.min_confidence)
        duplicate_of = self.linker.link(key, text, candidate["first_seconds"], candidate["last_seconds"],
                                        candidate["first_box"], candidate["last_box"])

        capture_clock, captured_from, captured_to = capture_times(clock, candidate["first_seconds"],
                                                                  candidate["last_seconds"])
        record = dict(track=key, epoch=epoch, status=status, confidence=confidence, duplicate_of=duplicate_of,
                      observations=candidate["observations"], captured_from=captured_from,
                      captured_to=captured_to, capture_clock=capture_clock, sampling_scale=self.sampling_scale,
                      appearance=appearance)
        write_json(folder / "track.json", record)
        self.tracks += 1
        self.emit(dict(type="track", track=key, epoch=epoch, text=text, status=status, confidence=confidence,
                       duplicate_of=duplicate_of, captured_from=record["captured_from"],
                       captured_to=record["captured_to"],
                       path=(folder / "track.json").relative_to(self.out).as_posix()))
