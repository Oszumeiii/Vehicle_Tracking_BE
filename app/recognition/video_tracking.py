"""Video -> adaptive sampling -> empty-scene gate -> YOLO -> BoT-SORT -> 5 crops/track.

Ported from the PBL6 PIPELINE notebook (https://www.kaggle.com/code/trnvnhun/pbl6-pipeline),
cells 9-20. Notebook-only outputs (contact sheets, annotated previews, HTML index)
are omitted; crops, keyframes and logs are kept as review evidence.
"""
from collections import Counter, defaultdict
import csv
import hashlib
import json
import math
from pathlib import Path
import time
from types import SimpleNamespace

import cv2
import numpy as np

DETECTOR_CLASSES = {0: "License_Plate"}


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")


def write_csv(path, rows, fields):
    with Path(path).open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def sha256_file(path):
    with Path(path).open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def jpeg_frame(image):
    """Detector and crops use the JPEG-decoded sampler pixels, as in the notebook."""
    ok, encoded = cv2.imencode(".jpg", image)
    if not ok:
        raise IOError("Cannot encode frame")
    return encoded, cv2.imdecode(encoded, cv2.IMREAD_COLOR)


class AdaptiveSelector:
    def __init__(self, fps, low_fps, med_fps, high_fps, threshold_low, threshold_high):
        values = [fps, low_fps, med_fps, high_fps, threshold_low, threshold_high]
        if not all(math.isfinite(v) for v in values) or fps <= 0:
            raise ValueError("Invalid FPS or thresholds")
        if not 0 < low_fps <= med_fps <= high_fps or not 0 <= threshold_low < threshold_high:
            raise ValueError("Sampling rates/thresholds are out of order")
        self.fps = round(fps, 2)
        self.rates = (low_fps, med_fps, high_fps)
        self.thresholds = (threshold_low, threshold_high)
        self.prev = None
        self.score = 0.
        self.last = -1.

    def select(self, image, index):
        gray = cv2.cvtColor(cv2.resize(image, (320, 180), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
        if self.prev is not None:
            motion = float(np.mean(cv2.absdiff(self.prev, gray))) / 255 * 100
            self.score = .6 * motion + .4 * self.score
        self.prev = gray
        level = 0 if self.score < self.thresholds[0] else (1 if self.score < self.thresholds[1] else 2)
        rate = min(self.rates[level], self.fps)
        timestamp = (index - 1) / self.fps
        if self.last >= 0 and timestamp - self.last < 1 / rate - .5 / self.fps:
            return None
        self.last = timestamp
        return dict(motion_score=round(self.score, 2), change_level=("Low", "Medium", "High")[level], sampling_fps=rate)


class EmptySceneGate:
    """Skip YOLO on likely-empty fixed-camera frames; skipped frames are not verified empty."""

    def __init__(self, enabled=True, probe_seconds=.25, empty_confirmations=3,
                 motion_fraction=.003, warmup_frames=60):
        if not math.isfinite(probe_seconds) or probe_seconds <= 0:
            raise ValueError("probe_seconds must be positive and finite")
        if empty_confirmations < 1 or warmup_frames < 1:
            raise ValueError("confirmations and warmup must be >= 1")
        if not math.isfinite(motion_fraction) or not 0 < motion_fraction <= 1:
            raise ValueError("motion_fraction must be in (0,1]")
        self.enabled = bool(enabled)
        self.probe_seconds = probe_seconds
        self.empty_confirmations = empty_confirmations
        self.motion_fraction = motion_fraction
        self.warmup_frames = warmup_frames
        self.background = (cv2.createBackgroundSubtractorMOG2(
            history=300, varThreshold=25, detectShadows=False) if self.enabled else None)
        self.seen_frames = 0
        self.foreground_fraction = 0.
        self.empty_streak = 0
        self.live_tracks = False
        self.last_scheduled = None
        self.previous_time = None
        self.counts = Counter()

    def observe_image(self, image):
        if not self.enabled:
            return
        gray = cv2.cvtColor(cv2.resize(image, (320, 180), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
        mask = self.background.apply(gray, learningRate=.01)
        self.foreground_fraction = float(np.count_nonzero(mask)) / mask.size
        self.seen_frames += 1

    def observe_detection(self, detection_count, live_tracks):
        self.live_tracks = bool(live_tracks)
        self.empty_streak = self.empty_streak + 1 if detection_count == 0 else 0
        self.counts["detector_frames"] += 1
        if detection_count == 0:
            self.counts["detector_frames_without_plate"] += 1

    @property
    def idle(self):
        return self.empty_streak >= self.empty_confirmations and not self.live_tracks

    def decide(self, timestamp):
        if not math.isfinite(timestamp) or (self.previous_time is not None and timestamp <= self.previous_time):
            raise ValueError("Gate timestamps must increase strictly")
        self.previous_time = timestamp
        if not self.enabled:
            reason = "disabled"
        elif self.seen_frames <= self.warmup_frames:
            reason = "warmup"
        elif self.live_tracks:
            reason = "live_track"
        elif self.empty_streak < self.empty_confirmations:
            reason = "confirm_scene"
        elif self.foreground_fraction >= self.motion_fraction:
            reason = "motion"
        elif self.last_scheduled is None or timestamp - self.last_scheduled >= self.probe_seconds:
            reason = "periodic_probe"
        else:
            reason = "idle_skip"
        keep = reason != "idle_skip"
        self.counts["adaptive_candidates"] += 1
        self.counts[reason] += 1
        self.counts["kept" if keep else "skipped"] += 1
        if keep:
            self.last_scheduled = timestamp
        return keep, reason

    def summary(self):
        total = self.counts["adaptive_candidates"]
        return dict(enabled=self.enabled, adaptive_candidates=total,
                    detector_frames=self.counts["detector_frames"],
                    detector_frames_without_plate=self.counts["detector_frames_without_plate"],
                    skipped_empty_candidates=self.counts["skipped"],
                    skip_fraction_of_candidates=self.counts["skipped"] / max(1, total),
                    probe_seconds=self.probe_seconds, reasons=dict(self.counts))


class SampledTrackerClock:
    def __init__(self, tracker, fps):
        if not math.isfinite(fps) or fps <= 0:
            raise ValueError("Invalid tracker clock FPS")
        self.tracker, self.fps = tracker, fps
        self.origin = self.previous = None

    def update(self, boxes, image, timestamp):
        if not math.isfinite(timestamp) or (self.previous is not None and timestamp <= self.previous):
            raise ValueError("Tracker PTS must increase strictly")
        if self.origin is None:
            self.origin = timestamp
        tracker = self.tracker
        tick = max(tracker.frame_id + 1, 1 + round((timestamp - self.origin) * self.fps))
        # Expire before matching: the stock tracker expires lost tracks only after
        # association, which could revive an ID across an arbitrarily long gap.
        for name in ("tracked_stracks", "lost_stracks"):
            keep = []
            for track in getattr(tracker, name):
                if tick - track.end_frame > tracker.max_frames_lost:
                    track.mark_removed()
                else:
                    keep.append(track)
            setattr(tracker, name, keep)
        pool = tracker.tracked_stracks + tracker.lost_stracks
        if pool:
            for _ in range(tick - tracker.frame_id - 1):
                tracker.multi_predict(pool)
        tracker.frame_id = tick - 1
        self.previous = timestamp
        return tracker.update(boxes, image)


def crop_bounds(box, width, height, padding):
    """Expand measured boxes without resizing; preserve the original box separately."""
    dx, dy = (box[2] - box[0]) * padding, (box[3] - box[1]) * padding
    return [max(0, math.floor(box[0] - dx)), max(0, math.floor(box[1] - dy)),
            min(width, math.ceil(box[2] + dx)), min(height, math.ceil(box[3] + dy))]


def crop_quality(image, box, padding):
    """Sharpness/size/edge metrics from the exact pixels that will be cropped."""
    h, w = image.shape[:2]
    x1, y1, x2, y2 = crop_bounds(box, w, h, padding)
    crop = image[y1:y2, x1:x2]
    if crop.size == 0:
        return dict(sharpness=0.0, box_height=0.0, box_area=0.0, edge_ok=0)
    gray = cv2.resize(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY), (192, 48), interpolation=cv2.INTER_AREA)
    sharp = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    bw, bh = box[2] - box[0], box[3] - box[1]
    margin = 2
    edge_ok = int(box[0] > margin and box[1] > margin and box[2] < w - margin and box[3] < h - margin)
    return dict(sharpness=sharp if math.isfinite(sharp) else 0.0,
                box_height=float(bh), box_area=float(bw * bh), edge_ok=edge_ok)


def _minmax(values):
    lo, hi = min(values), max(values)
    if hi - lo < 1e-9:
        return [0.5] * len(values)
    return [(v - lo) / (hi - lo) for v in values]


QUALITY_WEIGHTS = dict(sharp=0.35, height=0.30, conf=0.25, edge=0.10)
TOP_FRACTION = 0.5
MIN_POOL = 8


def score_rows(rows):
    """Quality score 0..1 per observation, normalized within the track."""
    sharp = _minmax([math.log1p(r.get("sharpness", 0.0)) for r in rows])
    height = _minmax([r.get("box_height", 0.0) for r in rows])
    conf = _minmax([r["confidence"] for r in rows])
    w = QUALITY_WEIGHTS
    return [w["sharp"] * s + w["height"] * h + w["conf"] * c + w["edge"] * r.get("edge_ok", 1)
            for r, s, h, c in zip(rows, sharp, height, conf)]


def select_five(rows, cfg):
    """Keep the better-quality pool, then spread five picks over time inside it."""
    unique = {}
    for r in rows:
        if r["confidence"] >= cfg["crop_confidence"]:
            previous = unique.get(r["frame_index"])
            if previous is None or r["confidence"] > previous["confidence"]:
                unique[r["frame_index"]] = r
    eligible = sorted(unique.values(), key=lambda r: r["frame_index"])
    if len(eligible) < 5:
        return None, "fewer_than_five_valid_frames"
    if any(b["timestamp_seconds"] <= a["timestamp_seconds"] for a, b in zip(eligible, eligible[1:])):
        raise ValueError("Track timestamps must be strictly increasing")
    scores = score_rows(eligible)
    pool_size = min(len(eligible), max(5, MIN_POOL, math.ceil(TOP_FRACTION * len(eligible))))
    top = sorted(range(len(eligible)), key=lambda i: scores[i], reverse=True)[:pool_size]
    pool = sorted(top)
    picks = np.rint(np.linspace(0, len(pool) - 1, 5)).astype(int)
    chosen = [eligible[pool[i]] for i in picks]
    if len({r["frame_index"] for r in chosen}) != 5:
        chosen = [eligible[i] for i in sorted(top[:5])]
    return chosen, None


def detect_plates(model, images, cfg):
    """Full-frame YOLO at conf .10 plus the notebook's geometric box filter."""
    cuda = cfg["device"] != "cpu"
    results = model.predict(images, imgsz=cfg["imgsz"], conf=.10, iou=.7, device=cfg["device"],
                            quantize="fp16" if cuda else None, verbose=False, max_det=100, rect=True)
    boxes = []
    for result, image in zip(results, images):
        b = result.boxes.cpu().numpy()
        if len(b):
            h, w = image.shape[:2]
            a = b.data[:, :4]
            bw, bh = a[:, 2] - a[:, 0], a[:, 3] - a[:, 1]
            ratio = bw / np.maximum(bh, 1e-9)
            keep = (np.isfinite(a).all(axis=1) & (a[:, 0] >= 0) & (a[:, 1] >= 0)
                    & (a[:, 2] <= w) & (a[:, 3] <= h) & (bw >= 12) & (bh >= 5)
                    & (ratio >= 1.1) & (ratio <= 7))
            b = b[keep]
        boxes.append(b)
    return boxes


def video_config(video, snapshot):
    """Notebook run_tracking() configuration for one video and pipeline snapshot."""
    cap = cv2.VideoCapture(str(video))
    try:
        fps = float(cap.get(cv2.CAP_PROP_FPS))
        width, height = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        declared = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        if not cap.isOpened() or width <= 0 or height <= 0 or not math.isfinite(fps) or fps <= 0 or declared < 1:
            raise ValueError("Video metadata or timing is invalid")
    finally:
        cap.release()
    tracking = snapshot["tracking"]
    return dict(video_path=str(video), video_id=video.stem, width=width, height=height, fps=fps,
                declared_frames=declared, max_seconds=0, batch=tracking["batch"], imgsz=tracking["imgsz"],
                device="cpu" if snapshot["device"] == "cpu" else 0,
                crop_confidence=tracking["crop_confidence"], crop_padding=tracking["crop_padding"],
                sampling=dict(snapshot["sampling"]), empty_scene_gate=dict(snapshot["empty_scene_gate"]),
                botsort=dict(tracker_type="botsort", track_high_thresh=.25, track_low_thresh=.10,
                             new_track_thresh=.25,
                             track_buffer=max(3, round(fps * tracking["track_buffer_seconds"])),
                             match_thresh=.8, fuse_score=False, gmc_method="none", proximity_thresh=.5,
                             appearance_thresh=.8, with_reid=False, model="auto"))


def track_video(video, model, cfg, out):
    from ultralytics.trackers.bot_sort import BOTSORT
    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        raise ValueError(f"Cannot open video: {video}")
    selector = AdaptiveSelector(cfg["fps"], **cfg["sampling"])
    gate = EmptySceneGate(**cfg["empty_scene_gate"])
    tracker = BOTSORT(SimpleNamespace(**cfg["botsort"]))
    clock = SampledTrackerClock(tracker, cfg["fps"])
    active, candidates, rejected = {}, [], Counter()
    pts, frames, pending_images, pending_info = [], [], [], []
    sampled = 0
    started = last_progress = time.perf_counter()

    with (out / "tracking_detections.csv").open("w", newline="", encoding="utf-8") as det_file, \
         (out / "frame_gate.csv").open("w", newline="", encoding="utf-8") as gate_file:
        dw = csv.DictWriter(det_file, fieldnames=["track_id", "frame_index", "timestamp_seconds", "confidence",
                                                  "x1", "y1", "x2", "y2"])
        gw = csv.DictWriter(gate_file, fieldnames=["frame_index", "timestamp_seconds", "foreground_fraction",
                                                   "keep_for_detector", "reason"])
        dw.writeheader()
        gw.writeheader()

        def finish(tid):
            rows = active.pop(tid)
            selected, reason = select_five(rows, cfg)
            if selected:
                candidates.append(dict(track_id=str(tid), rows=selected, observations=len(rows),
                                       first_frame=rows[0]["frame_index"], last_frame=rows[-1]["frame_index"]))
            else:
                rejected[reason] += 1

        def flush():
            nonlocal sampled
            detected = detect_plates(model, pending_images, cfg)
            if len(detected) != len(pending_images):
                raise RuntimeError("Detector returned a different number of frames")
            for image, info, boxes in zip(pending_images, pending_info, detected):
                tracks = clock.update(boxes, image, info["timestamp_seconds"])
                for track in tracks:
                    tid, idx = int(track[4]), int(track[-1])
                    # Use the measured detector box, never an extrapolated Kalman box.
                    raw = boxes.data[idx]
                    row = dict(info, box=list(map(float, raw[:4])), confidence=float(raw[4]))
                    row.update(crop_quality(image, row["box"], cfg["crop_padding"]))
                    active.setdefault(tid, []).append(row)
                    dw.writerow(dict(info, track_id=tid, confidence=row["confidence"],
                                     **dict(zip(("x1", "y1", "x2", "y2"), row["box"]))))
                sampled += 1
                live = {int(t.track_id) for t in tracker.tracked_stracks + tracker.lost_stracks}
                gate.observe_detection(len(boxes), bool(live))
                for tid in list(active):
                    if tid not in live:
                        finish(tid)
            det_file.flush()
            gate_file.flush()
            pending_images.clear()
            pending_info.clear()

        index = 0
        try:
            while cap.grab():
                index += 1
                timestamp = float(cap.get(cv2.CAP_PROP_POS_MSEC)) / 1000
                if cfg["max_seconds"] and timestamp >= cfg["max_seconds"]:
                    break
                if not math.isfinite(timestamp) or (pts and timestamp <= pts[-1]):
                    raise RuntimeError("Video PTS is not strictly increasing")
                pts.append(timestamp)
                ok, raw = cap.retrieve()
                if not ok:
                    raise RuntimeError(f"Cannot decode frame {index}")
                gate.observe_image(raw)
                sampled_meta = selector.select(raw, index)
                if sampled_meta is not None:
                    keep, reason = gate.decide(timestamp)
                    gw.writerow(dict(frame_index=index, timestamp_seconds=timestamp,
                                     foreground_fraction=gate.foreground_fraction,
                                     keep_for_detector=int(keep), reason=reason))
                    if keep:
                        encoded, image = jpeg_frame(raw)
                        frames.append(dict(sampled_meta, frame_index=index, timestamp_seconds=timestamp,
                                           selected_order=len(frames) + 1, frame_path="", sha256="",
                                           sampled_jpeg_sha256=hashlib.sha256(encoded.tobytes()).hexdigest()))
                        pending_images.append(image)
                        pending_info.append(dict(frame_index=index, timestamp_seconds=timestamp))
                        if len(pending_images) >= cfg["batch"] or (gate.enabled and gate.idle):
                            flush()
                now = time.perf_counter()
                if now - last_progress >= 20:
                    print(json.dumps(dict(stage="tracking", decoded_frames=len(pts),
                                          expected_frames=cfg["declared_frames"], sampled_frames=sampled,
                                          candidates=len(candidates),
                                          elapsed_seconds=round(now - started, 1))), flush=True)
                    last_progress = now
            if pending_images:
                flush()
            for tid in list(active):
                finish(tid)
        finally:
            cap.release()
    if not cfg["max_seconds"] and cfg["declared_frames"] > 0 and len(pts) != cfg["declared_frames"]:
        raise RuntimeError("Decoded frame count differs from video metadata")
    summary = dict(decoded_frames=len(pts), sampled_frames=sampled, candidates=len(candidates),
                   rejected=dict(rejected), frame_gate=gate.summary(),
                   elapsed_seconds=time.perf_counter() - started)
    write_json(out / "tracking_summary.json", summary)
    return pts, frames, candidates, summary


MANIFEST_FIELDS = ["video_id", "track_id", "selected_order", "frame_index", "timestamp_seconds",
                   "confidence", "x1", "y1", "x2", "y2", "crop_x1", "crop_y1", "crop_x2", "crop_y2",
                   "crop_width", "crop_height", "crop_path", "crop_sha256", "sampled_frame_path",
                   "sampling_selected_order"]


def export_crops(video, cfg, out, pts, frames, candidates):
    """Second decode pass: save keyframes and PNG crops from identical sampler pixels."""
    requested = defaultdict(list)
    lookup = {r["frame_index"]: r for r in frames}
    for candidate in candidates:
        for order, row in enumerate(candidate["rows"], 1):
            requested[row["frame_index"]].append((candidate["track_id"], order, row))
    for name in ("tracks", "keyframes"):
        (out / name).mkdir(exist_ok=True)
    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        raise RuntimeError("Cannot reopen video for export")
    manifest = []
    last_index = max(requested, default=0)
    index = 0
    try:
        while index < last_index and cap.grab():
            index += 1
            if index not in requested:
                continue
            ok, raw = cap.retrieve()
            timestamp = float(cap.get(cv2.CAP_PROP_POS_MSEC)) / 1000
            if not ok or abs(timestamp - pts[index - 1]) > .001:
                raise RuntimeError(f"Export PTS mismatch: {index}")
            encoded, image = jpeg_frame(raw)
            frame_meta = lookup[index]
            digest = hashlib.sha256(encoded.tobytes()).hexdigest()
            if digest != frame_meta["sampled_jpeg_sha256"]:
                raise RuntimeError(f"Sampler pixels changed at frame {index}")
            rel = f"keyframes/frame_{index:07d}.jpg"
            (out / rel).write_bytes(encoded.tobytes())
            frame_meta.update(frame_path=rel, sha256=digest)
            h, w = image.shape[:2]
            for tid, order, row in requested[index]:
                box = row["box"]
                if not np.isfinite(box).all() or not (0 <= box[0] < box[2] <= w and 0 <= box[1] < box[3] <= h):
                    raise ValueError("Invalid bounding box")
                bounds = crop_bounds(box, w, h, cfg["crop_padding"])
                x1, y1, x2, y2 = bounds
                crop = image[y1:y2, x1:x2]
                folder = out / "tracks" / f"track_{int(tid):06d}"
                folder.mkdir(exist_ok=True)
                path = folder / f"{order:02d}_frame_{index:07d}.png"
                if not crop.size or not cv2.imwrite(str(path), crop):
                    raise IOError(path)
                manifest.append(dict(
                    video_id=cfg["video_id"], track_id=tid, selected_order=order, frame_index=index,
                    timestamp_seconds=timestamp, confidence=row["confidence"],
                    **dict(zip(("x1", "y1", "x2", "y2"), box)),
                    **dict(zip(("crop_x1", "crop_y1", "crop_x2", "crop_y2"), bounds)),
                    crop_width=crop.shape[1], crop_height=crop.shape[0],
                    crop_path=path.relative_to(out).as_posix(), crop_sha256=sha256_file(path),
                    sampled_frame_path=rel, sampling_selected_order=frame_meta["selected_order"]))
    finally:
        cap.release()
    if len(manifest) != 5 * len(candidates):
        raise RuntimeError("Missing crops after export")
    for row in manifest:
        frame = cv2.imread(str(out / row["sampled_frame_path"]))
        crop = cv2.imread(str(out / row["crop_path"]))
        if frame is None or crop is None:
            raise ValueError("Cannot read exported evidence")
        x1, y1, x2, y2 = (int(row[k]) for k in ("crop_x1", "crop_y1", "crop_x2", "crop_y2"))
        if not np.array_equal(crop, frame[y1:y2, x1:x2]):
            raise ValueError("Crop pixels differ from the keyframe region")
    manifest.sort(key=lambda r: (int(r["track_id"]), r["selected_order"]))
    write_csv(out / "manifest.csv", manifest, MANIFEST_FIELDS)
    return manifest
