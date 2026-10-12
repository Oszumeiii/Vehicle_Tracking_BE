"""Video frame sampling, detection, tracking, cropping, and recognition."""

import csv
from dataclasses import dataclass
import json
import math
from pathlib import Path
import time
from typing import Any
import uuid

import cv2
import numpy as np

from app.ai.detect_tracking_boundingbox.botsort_tracker import crop_bounds, crop_quality, select_five
from app.ai.detect_tracking_boundingbox.empty_scene_gate import EmptySceneGate
from app.ai.pipelines import config as defaults
from app.ai.recognition.errors import NoValidPlateCandidate
from app.ai.recognition.track_predictor import predict_track_crops
from app.ai.video.frame_extractor import FrameExtractor, extract_frames

MANIFEST_FIELDS = (
    "model", "track_id", "crop_path", "frame_index", "timestamp_seconds", "confidence",
    "x1", "y1", "x2", "y2", "crop_x1", "crop_y1", "crop_x2", "crop_y2",
)


@dataclass(frozen=True)
class PipelineResult:
    run_dir: Path
    report_path: Path
    frame_count: int
    source_frame_count: int
    detection_count: int


def _video_fps(video_path: Path) -> float:
    capture = cv2.VideoCapture(str(video_path))
    try:
        fps = capture.get(cv2.CAP_PROP_FPS)
        if not capture.isOpened() or not math.isfinite(fps) or fps <= 0:
            raise ValueError(f"Cannot open video or determine a valid frame rate: {video_path}")
        return fps
    finally:
        capture.release()


def _tracked_rows(tracks: Any) -> np.ndarray:
    if tracks is None:
        return np.empty((0, 8), dtype=np.float32)
    rows = np.asarray(tracks)
    if rows.size == 0:
        return np.empty((0, 8), dtype=np.float32)
    if rows.ndim != 2 or rows.shape[1] < 7:
        raise ValueError("BoT-SORT must return rows containing bbox, track ID, confidence, and class.")
    return rows


def _record_track_crops(
    tracks: np.ndarray,
    image: np.ndarray,
    frame_index: int,
    timestamp: float,
    model: str,
    padding: float,
    run_dir: Path,
    crop_rows: list[dict[str, Any]],
    crops_by_track: dict[str, list[dict[str, Any]]],
) -> None:
    height, width = image.shape[:2]
    for track in tracks:
        box = [float(value) for value in track[:4]]
        track_id = str(int(track[4]))
        bounds = crop_bounds(box, width, height, padding)
        x1, y1, x2, y2 = bounds
        crop = image[y1:y2, x1:x2]
        if crop.size == 0:
            continue
        crop_path = Path("crops") / f"{len(crop_rows) + 1:08d}.jpg"
        if not cv2.imwrite(str(run_dir / crop_path), crop):
            raise OSError(f"Could not write crop image: {crop_path}")
        row = {
            "model": model,
            "track_id": track_id,
            "crop_path": crop_path.as_posix(),
            "frame_index": frame_index,
            "timestamp_seconds": timestamp,
            "confidence": float(track[5]),
            "x1": box[0], "y1": box[1], "x2": box[2], "y2": box[3],
            "crop_x1": x1, "crop_y1": y1, "crop_x2": x2, "crop_y2": y2,
            "image": crop.copy(),
            **crop_quality(image, box, padding),
        }
        crop_rows.append(row)
        crops_by_track.setdefault(track_id, []).append(row)


def _process_batch(
    pending: list[tuple[int, float, np.ndarray]],
    detector: Any,
    tracker: Any,
    gate: EmptySceneGate,
    model: str,
    padding: float,
    run_dir: Path,
    crop_rows: list[dict[str, Any]],
    crops_by_track: dict[str, list[dict[str, Any]]],
) -> int:
    if not pending:
        return 0
    detections = detector.detect([image for _, _, image in pending])
    if len(detections) != len(pending):
        raise RuntimeError("Detector returned a different number of results than input frames.")
    for (frame_index, timestamp, image), boxes in zip(pending, detections, strict=True):
        tracks = _tracked_rows(tracker.update(boxes, image, timestamp))
        gate.observe_detection(len(boxes), len(tracks) > 0)
        _record_track_crops(
            tracks, image, frame_index, timestamp, model, padding,
            run_dir, crop_rows, crops_by_track,
        )
    return len(pending)


def _sample_and_detect(
    video_path: Path,
    selector: FrameExtractor,
    gate: EmptySceneGate,
    detector: Any,
    tracker: Any,
    cfg: dict[str, Any],
    model: str,
    run_dir: Path,
    crop_rows: list[dict[str, Any]],
    crops_by_track: dict[str, list[dict[str, Any]]],
) -> tuple[int, int]:
    pending: list[tuple[int, float, np.ndarray]] = []
    selected_frame_count = 0
    source_frame_count = 0
    for frame_index, timestamp, image in extract_frames(video_path, cfg["MAX_SECONDS"]):
        source_frame_count = frame_index
        gate.observe_image(image)
        if selector.select(image, frame_index) is None:
            continue
        keep, _ = gate.decide(timestamp)
        if not keep:
            continue
        pending.append((frame_index, timestamp, image))
        if len(pending) >= cfg["DETECTOR_BATCH_SIZE"]:
            selected_frame_count += _process_batch(
                pending, detector, tracker, gate, model, cfg["CROP_PADDING"],
                run_dir, crop_rows, crops_by_track,
            )
            pending.clear()
    selected_frame_count += _process_batch(
        pending, detector, tracker, gate, model, cfg["CROP_PADDING"],
        run_dir, crop_rows, crops_by_track,
    )
    return selected_frame_count, source_frame_count


def _predict_tracks(
    recognizer: Any,
    crops_by_track: dict[str, list[dict[str, Any]]],
    confidence: float,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    valid_tracks: dict[str, list[dict[str, Any]]] = {}
    summaries: list[dict[str, Any]] = []
    for track_id, rows in crops_by_track.items():
        selected, reason = select_five(rows, {"crop_confidence": confidence})
        if selected is None:
            summaries.append({
                "track_id": track_id,
                "observation_count": len(rows),
                "status": "insufficient_frames",
                "reason": reason,
            })
            continue
        valid_tracks[track_id] = selected

    predictions: dict[str, Any] = {}
    for track_id, selected in valid_tracks.items():
        try:
            prediction = predict_track_crops(recognizer, {track_id: selected})[track_id]
        except NoValidPlateCandidate as exc:
            summaries.append({
                "track_id": track_id,
                "observation_count": len(crops_by_track[track_id]),
                "selected_frame_indices": [row["frame_index"] for row in selected],
                "status": "unrecognized",
                "reason": str(exc),
            })
            continue
        predictions[track_id] = prediction
        summaries.append({
            "track_id": track_id,
            "observation_count": len(crops_by_track[track_id]),
            "selected_frame_indices": [row["frame_index"] for row in selected],
            "status": "predicted",
            "prediction": prediction,
        })
    return predictions, summaries


def run_video_pipeline(
    video_path: Path,
    detector: Any,
    tracker: Any,
    recognizer: Any,
    *,
    output_root: Path,
    model: str,
    options: dict[str, Any] | None = None,
) -> PipelineResult:
    """Run the video pipeline and persist crop manifest and recognition report."""
    cfg = options or vars(defaults)
    fps = _video_fps(video_path)
    selector = FrameExtractor(
        fps,
        cfg["LOW_FPS"],
        cfg["MED_FPS"],
        cfg["HIGH_FPS"],
        cfg["THRESHOLD_LOW"],
        cfg["THRESHOLD_HIGH"],
    )
    gate = EmptySceneGate(
        enabled=cfg["EMPTY_SCENE_GATE"],
        probe_seconds=cfg["IDLE_PROBE_SECONDS"],
        empty_confirmations=cfg["EMPTY_CONFIRMATIONS"],
        motion_fraction=cfg["GATE_MOTION_FRACTION"],
        warmup_frames=cfg["GATE_WARMUP_FRAMES"],
    )
    run_dir = output_root / f"run-{time.time_ns()}-{uuid.uuid4().hex[:8]}"
    crops_dir = run_dir / "crops"
    crops_dir.mkdir(parents=True, exist_ok=False)

    crop_rows: list[dict[str, Any]] = []
    crops_by_track: dict[str, list[dict[str, Any]]] = {}
    selected_frame_count, source_frame_count = _sample_and_detect(
        video_path, selector, gate, detector, tracker, cfg, model, run_dir,
        crop_rows, crops_by_track,
    )
    if selected_frame_count == 0:
        raise RuntimeError("Video produced no frames selected for detection.")

    predictions, track_summaries = _predict_tracks(
        recognizer, crops_by_track, cfg["CROP_CONFIDENCE"]
    )

    for row in crop_rows:
        row.pop("image")
        for field in ("sharpness", "box_height", "box_area", "edge_ok"):
            row.pop(field, None)
    manifest_path = run_dir / "ocr_crop_manifest.csv"
    with manifest_path.open("w", encoding="utf-8-sig", newline="") as manifest:
        writer = csv.DictWriter(manifest, fieldnames=MANIFEST_FIELDS)
        writer.writeheader()
        writer.writerows(crop_rows)

    report = {
        "status": "complete",
        "frame_count": selected_frame_count,
        "source_frame_count": source_frame_count,
        "models": {
            model: {"status": "complete", "total_detections": len(crop_rows)},
        },
        "track_count": len(crops_by_track),
        "recognized_track_count": len(predictions),
        "tracks": track_summaries,
        "adaptive_sampling": gate.summary(),
    }
    report_path = run_dir / "report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, allow_nan=False, indent=2), encoding="utf-8")
    return PipelineResult(
        run_dir=run_dir,
        report_path=report_path,
        frame_count=selected_frame_count,
        source_frame_count=source_frame_count,
        detection_count=len(crop_rows),
    )
