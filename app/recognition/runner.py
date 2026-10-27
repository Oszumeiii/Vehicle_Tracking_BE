"""ML subprocess: YOLO + BoT-SORT five-frame tracking (PBL6 notebook) + a trained OCR plugin.

Heavy imports intentionally stay here, not in the HTTP process. No checkpoint is
downloaded, no contact sheet is recognized, and no prediction is fabricated.
"""
import argparse
from collections import defaultdict
import importlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import sys
import time
import traceback

from app.recognition.fusion import fuse_predictions, merge_tracks, normalize_plate
from app.recognition.registry import validate_snapshot


def write_json(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    # Windows refuses the rename while the Node worker is reading the target.
    for attempt in range(20):
        try:
            temporary.replace(path)
            return
        except PermissionError:
            if attempt == 19:
                raise
            time.sleep(.05)


def _key(path, data_dir):
    return path.resolve().relative_to(data_dir.resolve()).as_posix()


def _predict(recognizer, path, data_dir):
    from PIL import Image
    start = time.perf_counter()
    with Image.open(path) as picture:
        value = recognizer(picture.convert("RGB"))
    if not isinstance(value, dict) or not isinstance(value.get("raw_text"), str):
        raise ValueError("Recognizer must return a mapping with a raw_text string")
    score = value.get("ocr_score")
    characters = value.get("character_scores")
    if score is not None and (not isinstance(score, (int, float)) or not math.isfinite(score) or not 0 <= score <= 1):
        raise ValueError("OCR confidence must be a probability or null")
    if characters is not None and (not isinstance(characters, list) or any(
            not isinstance(v, (int, float)) or not math.isfinite(v) or not 0 <= v <= 1 for v in characters)):
        raise ValueError("Character confidence must be a list of probabilities or null")
    return dict(variant="original", raw_text=value["raw_text"], normalized_text=normalize_plate(value["raw_text"]),
                ocr_score=score, character_scores=characters, input_storage_key=_key(path, data_dir),
                latency_ms=(time.perf_counter() - start) * 1000)


def _predict_joint(recognizer, paths, data_dir):
    """Run the joint model once over five real, temporally ordered crops."""
    from PIL import Image
    if len(paths) != 5 or len(set(paths)) != 5:
        raise ValueError("Joint OCR requires five distinct crop evidence files")
    start = time.perf_counter()
    images = []
    try:
        for path in paths:
            with Image.open(path) as picture:
                images.append(picture.convert("RGB"))
        value = recognizer(images)
    finally:
        for image in images:
            image.close()
    if not isinstance(value, dict) or not isinstance(value.get("raw_text"), str):
        raise ValueError("Joint recognizer must return a mapping with a raw_text string")
    score, characters, weights = value.get("ocr_score"), value.get("character_scores"), value.get("frame_weights")
    decoding = value.get("decoding")
    if decoding is not None and not isinstance(decoding, dict):
        raise ValueError("Joint decoding details must be a mapping or null")
    if score is not None and (not isinstance(score, (int, float)) or not math.isfinite(score) or not 0 <= score <= 1):
        raise ValueError("OCR confidence must be a probability or null")
    if characters is not None and (not isinstance(characters, list) or any(
            not isinstance(v, (int, float)) or not math.isfinite(v) or not 0 <= v <= 1 for v in characters)):
        raise ValueError("Character confidence must be a list of probabilities or null")
    if weights is not None and (not isinstance(weights, list) or len(weights) != 5 or any(
            not isinstance(v, (int, float)) or not math.isfinite(v) or not 0 <= v <= 1 for v in weights)
            or abs(sum(weights) - 1) > .005):
        raise ValueError("Joint frame weights must be five normalized probabilities or null")
    return dict(variant="joint", raw_text=value["raw_text"], normalized_text=normalize_plate(value["raw_text"]),
                ocr_score=score, character_scores=characters, input_storage_keys=[_key(path, data_dir) for path in paths],
                frame_weights=weights, decoding=decoding, latency_ms=(time.perf_counter() - start) * 1000)


def _image_detections(payload, model, folder, data_dir):
    from PIL import Image
    with Image.open(payload["input_path"]) as source:
        picture = source.convert("RGB")
    width, height = picture.size
    frame = folder / "frame.png"
    picture.save(frame)
    if payload["input_mode"] == "plate_crop":
        boxes = [([0, 0, width, height], None)]
    else:
        import cv2
        import numpy as np
        from app.recognition.video_tracking import detect_plates
        config = payload["pipeline_snapshot"]
        image = cv2.cvtColor(np.asarray(picture), cv2.COLOR_RGB2BGR)
        found = detect_plates(model, [image], dict(imgsz=config["tracking"]["imgsz"],
                              device="cpu" if config["device"] == "cpu" else 0))[0]
        boxes = [(row[:4].tolist(), float(row[4])) for row in found.data
                 if float(row[4]) >= config["tracking"]["crop_confidence"]]
    appearances = []
    for index, (box, confidence) in enumerate(boxes, 1):
        if not all(math.isfinite(v) for v in box):
            raise ValueError("Nonfinite detector box")
        box = [max(0., min(float(v), float(width if i % 2 == 0 else height))) for i, v in enumerate(box)]
        if box[2] <= box[0] or box[3] <= box[1]:
            continue
        padding = payload["pipeline_snapshot"]["tracking"]["crop_padding"]
        dx, dy = (box[2] - box[0]) * padding, (box[3] - box[1]) * padding
        bounds = [max(0, math.floor(box[0] - dx)), max(0, math.floor(box[1] - dy)),
                  min(width, math.ceil(box[2] + dx)), min(height, math.ceil(box[3] + dy))]
        path = folder / f"crop_{index:06d}.png"
        crop = picture.crop(bounds)
        crop.save(path)
        detection = dict(selected_order=1, frame_index=None, timestamp_seconds=None, timestamp_source="still_image",
                         bbox=box, crop_bbox=bounds, detection_score=confidence, crop_storage_key=_key(path, data_dir),
                         frame_storage_key=_key(frame, data_dir), crop_width=crop.width, crop_height=crop.height)
        appearances.append(dict(source_track_id=None, first_frame=None, last_frame=None,
                                start_seconds=None, end_seconds=None, detections=[detection]))
    return appearances, {"total_detections": len(appearances), "rejected_tracks": {}, "selected_frames": 1}


def build_appearance(candidate, manifest_rows, out, data_dir, start_seconds, end_seconds, timestamp_source):
    """One track's appearance from its five manifest rows (evidence files under out)."""
    rows = sorted(manifest_rows, key=lambda row: row["selected_order"])
    frame_indices = [row["frame_index"] for row in rows]
    if len(rows) != 5 or len(set(frame_indices)) != 5 or frame_indices != sorted(frame_indices):
        raise ValueError("Five-frame tracking produced invalid selection")
    detections = [dict(selected_order=row["selected_order"], frame_index=row["frame_index"],
        timestamp_seconds=row["timestamp_seconds"], timestamp_source=timestamp_source,
        bbox=[float(row[key]) for key in ("x1", "y1", "x2", "y2")],
        crop_bbox=[int(row[key]) for key in ("crop_x1", "crop_y1", "crop_x2", "crop_y2")],
        detection_score=row["confidence"], crop_storage_key=_key(out / row["crop_path"], data_dir),
        frame_storage_key=_key(out / row["sampled_frame_path"], data_dir),
        crop_width=row["crop_width"], crop_height=row["crop_height"]) for row in rows]
    return dict(source_track_id=str(candidate["track_id"]), first_frame=candidate["first_frame"],
                last_frame=candidate["last_frame"], start_seconds=start_seconds, end_seconds=end_seconds,
                detections=detections)


def _video_detections(payload, model, folder, data_dir, stop=None, throttle=None):
    from app.recognition.video_tracking import export_crops, track_video, video_config, write_json as dump
    video = Path(payload["input_path"])
    cfg = video_config(video, payload["pipeline_snapshot"])
    out = folder / "tracking"
    out.mkdir(exist_ok=False)
    dump(out / "config.json", cfg)
    pts, frames, candidates, summary = track_video(video, model, cfg, out, stop=stop, throttle=throttle)
    manifest = export_crops(video, cfg, out, pts, frames, candidates)
    grouped = defaultdict(list)
    for row in manifest:
        grouped[str(row["track_id"])].append(row)
    appearances = []
    for candidate in candidates:
        track_id = str(candidate["track_id"])
        first, last = candidate["first_frame"], candidate["last_frame"]
        appearances.append(build_appearance(candidate, grouped[track_id], out, data_dir,
                                            pts[first - 1], pts[last - 1], "video_pts"))
    rejected = summary["rejected"]
    return appearances, {"decoded_frames": len(pts), "selected_frames": len(frames),
                         "accepted_tracks": len(appearances), "total_detections": len(manifest),
                         "rejected_tracks": rejected, "rejected_track_count": sum(rejected.values()),
                         "frame_gate": summary["frame_gate"]}


def load_models(payload):
    """Detector (None for plate crops) and recognizer (None for prepare) of a job's pinned snapshot."""
    snapshot = payload["pipeline_snapshot"]
    recognizer = None
    if snapshot.get("task") != "prepare":
        module, factory = snapshot["recognizer"]["factory"].split(":")
        recognizer = getattr(importlib.import_module(module), factory)({**snapshot["recognizer"], "device": snapshot["device"]})
        if not callable(recognizer):
            raise ValueError("Recognizer factory must return a callable")
    model = None
    if payload["input_mode"] != "plate_crop":
        import ultralytics
        from app.recognition.video_tracking import DETECTOR_CLASSES
        model = ultralytics.YOLO(snapshot["detector"]["checkpoint"])
        names = getattr(model, "names", DETECTOR_CLASSES)
        if names != DETECTOR_CLASSES:
            raise ValueError(f"Detector checkpoint is not a license-plate model: {names}")
    return model, recognizer


def error_result(exc):
    """recognition-result.json for a failed job: only codes the worker knows are passed on."""
    code = getattr(exc, "code", "PIPELINE_FAILED")
    allowed = {"ENVIRONMENT_ERROR", "CUDA_UNAVAILABLE", "CUDA_ERROR", "CHECKPOINT_MISSING",
               "INVALID_VIDEO", "PIPELINE_FAILED", "RESULT_INVALID", "JOB_TIMEOUT", "WORKER_INTERRUPTED"}
    return {"ok": False, "error_code": code if code in allowed else "PIPELINE_FAILED"}


def execute(payload, models=None, stop=None, throttle=None):
    """Run one job. models=(detector, recognizer) already loaded (the shared live host passes
    its own); stop is an Event checked between frames and OCR calls; throttle(timestamp)
    is called before each video frame and may sleep."""
    from app.recognition.video_tracking import check_stop
    prepare = payload["pipeline_snapshot"].get("task") == "prepare"
    snapshot = payload["pipeline_snapshot"]
    validate_snapshot(snapshot)
    joint = not prepare and snapshot["recognizer"].get("input_mode", "single_crop") == "five_frame_joint"
    if joint and (payload["media_type"] != "video" or payload["input_mode"] != "scene"):
        raise ValueError("Joint five-frame OCR supports scene video only")
    if not prepare and snapshot["recognizer"]["module_root"] not in sys.path:
        sys.path.insert(0, snapshot["recognizer"]["module_root"])
    folder, data_dir = Path(payload["output_dir"]), Path(payload["data_dir"])
    def stage(name):
        write_json(folder / "progress.json", {"stage": name})
    stage("validating")
    # Runtime versions are evidence; they are not replaced with claimed config versions.
    versions = {}
    for package in ("torch", "ultralytics", "Pillow", "numpy", "opencv-python"):
        try:
            versions[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            versions[package] = None
    model, recognizer = models if models is not None else load_models(payload)
    stage("detection_tracking")
    if payload["media_type"] == "image":
        appearances, statistics = _image_detections(payload, model, folder, data_dir)
    else:
        appearances, statistics = _video_detections(payload, model, folder, data_dir, stop=stop, throttle=throttle)
    if not prepare:
        stage("recognition")
    for appearance in appearances:
        check_stop(stop)
        appearance["predictions"] = []
        if joint:
            detections = appearance["detections"]
            frames = [d["frame_index"] for d in detections]
            if len(frames) != 5 or len(set(frames)) != 5 or frames != sorted(frames):
                raise ValueError("Joint OCR requires five ordered, distinct video frames")
            prediction = _predict_joint(recognizer, [data_dir / d["crop_storage_key"] for d in detections], data_dir)
            for detection in detections:
                detection["predictions"] = []
            text = prediction["normalized_text"]
            appearance.update(machine_text=text or None, machine_status="readable" if text else "unreadable",
                              agreement_count=None, recognition_method="joint_multiframe", predictions=[prediction])
            continue
        predictions = []
        for detection in appearance["detections"]:
            if prepare:
                detection["predictions"] = []
                continue
            prediction = _predict(recognizer, data_dir / detection["crop_storage_key"], data_dir)
            detection["predictions"] = [prediction]
            predictions.append(prediction["raw_text"])
        appearance.update(dict(machine_text=None, machine_status="not_run", agreement_count=0)
                          if prepare else fuse_predictions(predictions))
        appearance["recognition_method"] = None if prepare else (
            "single_image" if payload["media_type"] == "image" else "per_crop_majority")
    if joint:
        # Notebook merge_tracks(): advisory grouping of tracks split from one vehicle.
        tracks = []
        for appearance in appearances:
            prediction, detections = appearance["predictions"][0], appearance["detections"]
            decoding = prediction.get("decoding") or {}
            confidence = decoding.get("beam_confidence_proxy")
            if confidence is None:
                confidence = decoding.get("greedy_symbol_confidence", 0.0)
            tracks.append(dict(track_id=appearance["source_track_id"], plate_text=prediction["normalized_text"],
                               confidence=float(confidence), first_seen=detections[0]["timestamp_seconds"],
                               last_seen=detections[-1]["timestamp_seconds"]))
        statistics["vehicle_groups"] = merge_tracks(tracks)
    statistics["runtime_versions"] = versions
    stage("persisting")
    return {"appearances": appearances, "statistics": statistics}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--payload", type=Path, required=True)
    parser.add_argument("--wait-for-parent", action="store_true")
    args = parser.parse_args()
    if args.wait_for_parent and sys.stdin.readline().strip() != "go":
        return 1
    payload = json.loads(args.payload.read_text(encoding="utf-8"))
    if payload.get("device", payload["pipeline_snapshot"].get("device")) == "cpu":
        os.environ["CUDA_VISIBLE_DEVICES"] = ""
    try:
        result = execute(payload)
        write_json(args.payload.parent / "recognition-result.json", {"ok": True, **result})
        return 0
    except Exception as exc:
        traceback.print_exc()
        write_json(args.payload.parent / "recognition-result.json", error_result(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
