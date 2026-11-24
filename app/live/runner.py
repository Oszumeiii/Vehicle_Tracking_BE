"""LiveRunner: connections (epochs) -> TrackSession -> per-track evidence + joint OCR -> events.

Each finished track gets its own folder OUT/tracks/e{epoch}-t{track}/ holding its
keyframes, crops and track.json (one appearance in the shape the Node validator
expects, timestamp_source "live_pts"). Confidence status and duplicate links are
advisory: every track is still recorded. Finished tracks are written and read on a
second thread (TrackWorker), so the frame loop never waits for OCR.
"""
from datetime import datetime, timedelta, timezone
import math
import queue
import threading
import time
import traceback

from PIL import Image

from app.live import DEFAULT_MIN_CONFIDENCE
from app.live.recorder import ClipMaker, Recorder
from app.live.source import TIMEOUT, LiveReader, SourceError, StreamEnded
from app.recognition.fusion import PlateFusion
from app.recognition.runner import PredictionRunner, AppearanceBuilder, ResultWriter
from app.recognition.video_tracking import TrackSession, EvidenceWriter, TrackingConfig, PlateDetector


def utc(value):
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def plate_confidence(prediction):
    decoding = prediction.get("decoding") or {}
    value = decoding.get("beam_confidence_proxy")
    return decoding.get("greedy_symbol_confidence") if value is None else value


# A track read from four crops (one repeated) needs this much more confidence: on ICPR
# four frames at 0.97 matched the precision of five at 0.96.
SHORT_TRACK_MARGIN = 0.01


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
    if stream_time is not None and clock.get("recorded"):
        # An uploaded video's filming time (recorded_at + PTS): its own clock, not compared
        # with receive time since the footage may be days old.
        return "recorded", utc(stream_time(first)), utc(stream_time(last))
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
                         and PlateFusion.levenshtein(text, earlier["text"]) <= self.max_edit)
            if same_text or box_iou(earlier["last_box"], first_box) >= self.min_iou:
                match = earlier["root"]
                break
        self.recent.append(dict(key=key, root=match or key, text=text, first_seconds=first_seconds,
                                last_seconds=last_seconds, last_box=last_box))
        return match


class TrackWorker:
    """Finishes tracks on its own thread, one at a time and in the order they were handed over.

    Writing a track's evidence and reading it took 100-270 ms with two cameras on one GPU;
    done inside the frame loop, frames piled up meanwhile and 1.4-5.9% were dropped
    (docs/EVALUATION.md, R14). The queue is bounded: if OCR falls that far behind, the frame
    loop waits as it used to instead of holding the frames of ever more tracks.
    handle(item, waited_seconds) must report its own errors; anything it raises is printed
    and the thread goes on with the next track.
    """

    def __init__(self, handle, capacity=32, name="live-tracks"):
        self.handle, self.queue = handle, queue.Queue(maxsize=capacity)
        self.thread = threading.Thread(target=self._run, name=name, daemon=True)
        self.thread.start()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    @property
    def pending(self):
        """Tracks handed over and not finished yet (waiting or being read)."""
        return self.queue.unfinished_tasks

    def submit(self, item):
        self.queue.put((item, time.perf_counter()))

    def close(self):
        """Finish every track handed over, then stop the thread."""
        self.queue.put(None)
        self.thread.join()

    def _run(self):
        while True:
            entry = self.queue.get()
            try:
                if entry is None:
                    return
                item, submitted = entry
                self.handle(item, time.perf_counter() - submitted)
            except Exception:  # noqa: BLE001 - one track never stops the others
                traceback.print_exc()
            finally:
                self.queue.task_done()


class LiveRunner:
    def __init__(self, snapshot, out, open_source, emit, model, recognizer, *, data_dir=None,
                 min_confidence=DEFAULT_MIN_CONFIDENCE, max_track_seconds=30., max_reconnects=10, read_timeout=15.,
                 stats_interval=1., buffer_seconds=1.5, reader_capacity=None, backoff_max=30., exclude_zones=(), detect_roi=None,
                 sampling_scale=1., recording=None, track_capacity=32):
        if snapshot.get("recognizer", {}).get("input_mode") != "five_frame_joint":
            raise ValueError("Live recognition supports five_frame_joint pipelines only")
        self.exclude_zones = [list(map(float, zone)) for zone in exclude_zones]
        self.detect_roi = list(map(float, detect_roi)) if detect_roi else None
        if self.detect_roi and (len(self.detect_roi) != 4 or not (
                0 <= self.detect_roi[0] < self.detect_roi[2] <= 1 and 0 <= self.detect_roi[1] < self.detect_roi[3] <= 1)):
            raise ValueError("detect_roi must be [x1, y1, x2, y2] with 0 <= x1 < x2 <= 1 and 0 <= y1 < y2 <= 1")
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
        # recording: {"minutes", "clip_policy" (readable|all|none), "pad"} records the stream in
        # rolling segments (OUT/record/eNNN) and cuts clips of tracks (OUT/clips); None: off.
        self.recording = recording
        self.clips, self.spans = None, {}
        # OCR work of the whole session, for the pipeline view (stats.stages.ocr). The track
        # thread adds to it while the frame loop reports it, hence the lock.
        self.ocr = dict(tracks=0, seconds=0., readable=0, low_confidence=0, unreadable=0, duplicates=0)
        self.ocr_lock = threading.Lock()
        self.track_capacity, self.peak_pending = track_capacity, 0

    def _warm_up(self, cfg):
        """First CUDA calls take seconds; make them before frames start to arrive.

        A shared model (app/live/host.py) remembers what any session already warmed up.
        """
        key = (cfg["width"], cfg["height"], cfg["batch"], cfg["imgsz"])
        warmed = getattr(self.model, "warmed", self.warmed)
        if key in warmed:
            return
        PlateDetector.warm_up_detector(self.model, cfg)
        self.recognizer([Image.new("RGB", (192, 48), (shade, shade, shade)) for shade in range(0, 250, 50)])
        warmed.add(key)

    def run(self, stop):
        """Run until the source ends, stop is set, or reconnecting keeps failing. Returns the final status."""
        self.emit(dict(type="status", status="starting"))
        epoch, failures = 0, 0
        while not stop.is_set():
            self.emit(dict(type="status", status="connecting", epoch=epoch))
            try:
                info, connection = (self.open_source(record_dir=self.out / "record" / f"e{epoch:03d}")
                                    if self.recording else self.open_source())
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
        cfg = {**TrackingConfig.tracking_config(info["width"], info["height"], info["fps"], 0, self.tracking_snapshot,
                                 info.get("video_id", "live")), "max_track_seconds": self.max_track_seconds,
               "exclude_zones": self.exclude_zones, "detect_roi": self.detect_roi}
        self._warm_up(cfg)
        capacity = self.reader_capacity or max(8, math.ceil(self.buffer_seconds * info["fps"]))
        reader = LiveReader(connection, capacity).start()
        self.linker.reset()
        clock = dict(started_at=None, first_pts=None, stream_time=getattr(connection, "stream_time", None),
                     recorded=bool(getattr(connection, "recorded_clock", False)))
        recorder, self.clips = self._start_recording(info, connection, clock)
        outcome, reason, frames = "error", None, 0
        last_frame = last_stats = time.monotonic()
        processed_since = 0
        position = None  # PTS of the newest processed frame (where a viewer of the source should be)
        # Named after the session thread: never "job-*", so its OCR keeps the camera priority
        # on the shared GPU thread (app/live/host.py).
        worker = TrackWorker(lambda candidate, waited: self._record(epoch, candidate, cfg, clock, waited),
                             self.track_capacity, name=f"{threading.current_thread().name}-tracks")
        # Leaving the block records every track handed over, so their events always come
        # before the next status (reconnecting, ended, stopped, failed).
        with worker, TrackSession(self.model, cfg, retain_images=True) as session:
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
                        position = pts
                        last_frame = now
                        for candidate in session.push(index, pts, image, gray):
                            self._hand_over(worker, candidate)
                        self._report_rejections(epoch, session)
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
                                       position_seconds=None if position is None else round(position, 3),
                                       source_duration=info.get("duration"),
                                       fps=round(processed_since / (now - last_stats), 2),
                                       stages=self._stages(reader, session, frames, worker)))
                        last_stats, processed_since = now, 0
                if stop.is_set():
                    outcome, reason = "stopped", None
            except (SourceError, StreamEnded) as exc:
                outcome, reason = ("ended" if isinstance(exc, StreamEnded) else "error"), str(exc)
            finally:
                reader.stop()
            # Tracks seen before a failure or stop are still finished and recognized.
            for candidate in session.close():
                self._hand_over(worker, candidate)
            self._report_rejections(epoch, session)
        if recorder:
            recorder.stop()
        if self.clips:
            self.clips.finish()
            self.clips = None
        return outcome, reason, frames

    def _hand_over(self, worker, candidate):
        worker.submit(candidate)
        self.peak_pending = max(self.peak_pending, worker.pending)

    def _report_rejections(self, epoch, session):
        """A trace event per track that crop selection dropped (too few usable frames)."""
        while session.rejections:
            item = session.rejections.popleft()
            self.emit(dict(type="trace", stage="track_rejected", epoch=epoch, **item))

    def _stages(self, reader, session, frames, worker=None):
        """Counters of each pipeline step for this epoch (OCR: the whole session; pending: tracks
        handed to the track thread and not recorded yet, peak_pending: the most at once)."""
        with self.ocr_lock:
            ocr = dict(self.ocr)
        gate, detect = session.gate.counts, session.detect
        return dict(
            decode=dict(read=reader.read, dropped=reader.dropped, processed=frames),
            sampling=dict(candidates=gate["adaptive_candidates"], kept=gate["kept"], skipped=gate["skipped"],
                          reasons={k: gate[k] for k in ("warmup", "live_track", "confirm_scene", "motion",
                                                        "periodic_probe", "idle_skip", "disabled") if gate[k]}),
            detect=dict(batches=detect["batches"], frames=detect["frames"], boxes=detect["boxes"],
                        roi=self.detect_roi is not None,
                        frames_without_plate=gate["detector_frames_without_plate"],
                        ms_per_frame=round(1000 * detect["seconds"] / detect["frames"], 1) if detect["frames"] else None),
            tracking=dict(active=len(session.active), finished=self.tracks,
                          rejected=dict(session.rejected)),
            ocr=dict(tracks=ocr["tracks"], readable=ocr["readable"], low_confidence=ocr["low_confidence"],
                     unreadable=ocr["unreadable"], duplicates=ocr["duplicates"], threshold=self.min_confidence,
                     ms_per_track=round(1000 * ocr["seconds"] / ocr["tracks"], 1) if ocr["tracks"] else None,
                     pending=worker.pending if worker else 0, peak_pending=self.peak_pending))

    def _start_recording(self, info, connection, clock):
        """Recorder and clip maker of an epoch: a network stream records itself; a demo video is its own recording."""
        if not self.recording:
            return None, None
        pad = float(self.recording.get("pad", 3.))
        record_dir = getattr(connection, "record_dir", None)
        if record_dir is not None:
            def to_utc(start, end):
                if clock["started_at"] is None:
                    now = utc(datetime.now(timezone.utc))
                    return now, now
                return capture_times(clock, start, end)[1:]
            recorder = Recorder(record_dir, to_utc, keep_minutes=float(self.recording.get("minutes", 240))).start()
            return recorder, ClipMaker(self.out, self.emit, pad, recorder=recorder)
        if getattr(connection, "path", None) is not None and info.get("duration"):
            return None, ClipMaker(self.out, self.emit, pad, video=(connection.path, info["duration"]))
        return None, None

    def request_clip(self, key):
        """Clip a track of the current epoch outside the clip policy (e.g. a watchlist alert)."""
        clips, span = self.clips, self.spans.get(key)
        if clips is not None and span is not None:
            clips.request(key, *span)

    def _record(self, epoch, candidate, cfg, clock, waited=0.):
        """One failed track (evidence or OCR) is reported without stopping the stream. Runs on
        the track thread; waited is how long the track queued there."""
        try:
            self._track(epoch, candidate, cfg, clock, waited)
        except Exception as exc:  # noqa: BLE001
            self.emit(dict(type="error", code="TRACK_FAILED", epoch=epoch, track_id=candidate["track_id"],
                           message=str(exc) or repr(exc)))

    def _track(self, epoch, candidate, cfg, clock, waited=0.):
        key = f"e{epoch:03d}-t{int(candidate['track_id']):06d}"
        folder = self.out / "tracks" / key
        folder.mkdir(parents=True, exist_ok=False)
        manifest = EvidenceWriter.export_retained([candidate], cfg, folder)
        appearance = AppearanceBuilder.build_appearance(candidate, manifest, folder, self.data_dir, candidate["first_seconds"],
                                      candidate["last_seconds"], "live_pts")
        detections = appearance["detections"]
        started = time.perf_counter()
        paths, boxes = PredictionRunner.detection_inputs(detections, self.data_dir, cfg.get("ocr_padding"),
                                                       cfg.get("ocr_deskew_degrees"))
        prediction = PredictionRunner.predict_joint(self.recognizer, paths, self.data_dir, boxes)
        ocr_seconds = time.perf_counter() - started
        for detection in detections:
            detection["predictions"] = []
        text = prediction["normalized_text"] or None
        appearance.update(machine_text=text, machine_status="readable" if text else "unreadable",
                          agreement_count=None, recognition_method="joint_multiframe", predictions=[prediction])
        confidence = plate_confidence(prediction)
        threshold = self.min_confidence + (SHORT_TRACK_MARGIN if len(detections) < 5 else 0)
        status = classify(text, confidence, min(round(threshold, 6), 1.))
        duplicate_of = self.linker.link(key, text, candidate["first_seconds"], candidate["last_seconds"],
                                        candidate["first_box"], candidate["last_box"])

        capture_clock, captured_from, captured_to = capture_times(clock, candidate["first_seconds"],
                                                                  candidate["last_seconds"])
        record = dict(track=key, epoch=epoch, status=status, confidence=confidence, duplicate_of=duplicate_of,
                      frames=len(detections), observations=candidate["observations"], captured_from=captured_from,
                      captured_to=captured_to, capture_clock=capture_clock, sampling_scale=self.sampling_scale,
                      appearance=appearance)
        ResultWriter.write_json(folder / "track.json", record)
        self.tracks += 1
        if self.recording:
            self.spans[key] = (candidate["first_seconds"], candidate["last_seconds"])
            if len(self.spans) > 5000:
                self.spans.pop(next(iter(self.spans)))
            policy = self.recording.get("clip_policy", "readable")
            if self.clips is not None and (policy == "all" or (policy == "readable" and status == "readable")):
                self.clips.request(key, candidate["first_seconds"], candidate["last_seconds"])
        with self.ocr_lock:
            self.ocr["tracks"] += 1
            self.ocr["seconds"] += ocr_seconds
            self.ocr[status] = self.ocr.get(status, 0) + 1
            self.ocr["duplicates"] += duplicate_of is not None
        self.emit(dict(type="trace", stage="track_ocr", epoch=epoch, track=key, observations=candidate["observations"],
                       seconds=round(candidate["last_seconds"] - candidate["first_seconds"], 2), frames=len(detections),
                       text=text, confidence=confidence, status=status, threshold=round(threshold, 6),
                       duplicate_of=duplicate_of, ocr_ms=round(1000 * ocr_seconds, 1), queued_ms=round(1000 * waited, 1)))
        self.emit(dict(type="track", track=key, epoch=epoch, text=text, status=status, confidence=confidence,
                       frames=len(detections), duplicate_of=duplicate_of, captured_from=record["captured_from"],
                       captured_to=record["captured_to"],
                       path=(folder / "track.json").relative_to(self.out).as_posix()))
