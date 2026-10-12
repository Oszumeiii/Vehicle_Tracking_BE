"""Subprocess entry point for model preparation and video inference."""

import argparse
from dataclasses import replace
import json
from pathlib import Path
import sys
import traceback

from app.ai.detect_tracking_boundingbox.botsort_tracker import create_botsort_tracker
from app.ai.detect_tracking_boundingbox.yolo_detector import YoloDetector
from app.ai.pipelines import config
from app.ai.pipelines.video_pipeline import run_video_pipeline
from app.ai.recognition.inference import PlateRecognizer
from app.ai.settings import Settings as RecognitionSettings

MODELS = ("yolo11l", "yolo11n", "yolo11m", "yolo26n")


class RunnerError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _video_fps(video_path: Path) -> float:
    import cv2
    import math

    capture = cv2.VideoCapture(str(video_path))
    try:
        fps = capture.get(cv2.CAP_PROP_FPS)
        if not capture.isOpened() or not math.isfinite(fps) or fps <= 0:
            raise RunnerError("INVALID_VIDEO", f"Cannot open video or determine a valid frame rate: {video_path}")
        return fps
    finally:
        capture.release()


def write_json(path: Path, value: dict) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, allow_nan=False), encoding="utf-8")
    temporary.replace(path)


def _device_index(device: str) -> int:
    if device == "cuda":
        return 0
    if device.startswith("cuda:"):
        return int(device.partition(":")[2])
    raise ValueError(f"Unsupported CUDA device: {device}")


def check_environment(device: str) -> None:
    try:
        import torch
    except ImportError as exc:
        raise RunnerError("ENVIRONMENT_ERROR", "PyTorch is unavailable in the pipeline interpreter.") from exc
    if device == "cpu":
        return
    if not device.startswith("cuda") or not torch.cuda.is_available():
        raise RunnerError("CUDA_UNAVAILABLE", "CUDA is not available in the configured interpreter.")
    if _device_index(device) >= torch.cuda.device_count():
        raise RunnerError("CUDA_UNAVAILABLE", f"CUDA device {device} does not exist.")


def prepare(cache: Path, device: str) -> None:
    import numpy as np

    check_environment(device)
    cache.mkdir(parents=True, exist_ok=True)
    sample = np.zeros((128, 256, 3), dtype=np.uint8)
    detector_device = str(_device_index(device)) if device.startswith("cuda") else "cpu"
    for model_name in MODELS:
        detector = YoloDetector(
            cache, model_name, confidence=0.25, device=detector_device,
            imgsz=config.DETECTOR_IMGSZ,
        )
        detector.detect([sample])
        write_json(cache / f"ready-{model_name}.json", {
            "model": model_name,
            "device": device,
            "python": str(Path(sys.executable).resolve()),
            "weight_sha256": detector.spec["weight_sha256"],
        })
        print(f"READY {model_name} on {device}", flush=True)
        del detector


def _verify_prepared(cache: Path, model_name: str, device: str, weight_hash: str) -> None:
    manifest_path = cache / f"ready-{model_name}.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RunnerError("CHECKPOINT_MISSING", "Run model preparation before processing jobs.") from exc
    if (
        manifest.get("device") != device
        or manifest.get("python") != str(Path(sys.executable).resolve())
        or manifest.get("weight_sha256") != weight_hash
    ):
        raise RunnerError("CHECKPOINT_MISSING", "Prepared checkpoint or pipeline interpreter has changed.")


def run_pipeline(payload: dict) -> dict:
    model_name = payload["model"]
    device = payload["device"]
    if model_name not in MODELS or device not in ("cpu", "cuda"):
        raise RunnerError("CONFIGURATION_ERROR", "Unsupported model or device.")
    check_environment(device)
    cache_dir = Path(payload["cache_dir"])
    detector_device = str(config.DETECTOR_DEVICE) if device == "cuda" else "cpu"
    try:
        detector = YoloDetector(
            cache_dir,
            model_name,
            confidence=float(payload["confidence"]),
            device=detector_device,
            imgsz=config.DETECTOR_IMGSZ,
        )
    except (OSError, ValueError, RuntimeError) as exc:
        raise RunnerError("CHECKPOINT_MISSING", str(exc)) from exc
    _verify_prepared(cache_dir, model_name, device, detector.spec["weight_sha256"])

    try:
        tracker = create_botsort_tracker(
            fps=_video_fps(Path(payload["input_path"])),
            buffer_seconds=config.TRACK_BUFFER_SECONDS,
        )
        recognition_settings = RecognitionSettings()
        checkpoint = recognition_settings.model_path
        if not checkpoint.exists():
            raise RunnerError("CHECKPOINT_MISSING", f"Recognition checkpoint not found: {checkpoint}")
        recognition_device = config.OCR_DEVICE if device == "cuda" else "cpu"
        recognizer = PlateRecognizer(replace(
            recognition_settings,
            device=recognition_device,
            use_amp=config.OCR_USE_AMP,
            use_tta=config.OCR_USE_TTA,
            decoder=config.OCR_DECODER,
            beam_width=config.BEAM_WIDTH,
            min_beam_score=config.MIN_BEAM_SCORE,
        ))
    except RunnerError:
        raise
    except (OSError, ValueError, RuntimeError) as exc:
        raise RunnerError("CHECKPOINT_MISSING", str(exc)) from exc

    try:
        result = run_video_pipeline(
            Path(payload["input_path"]),
            detector,
            tracker,
            recognizer,
            output_root=Path(payload["output_root"]),
            model=model_name,
        )
        return {"run_dir": str(result.run_dir), "selected_frames": result.frame_count}
    finally:
        recognizer.close()


def execute(payload: dict) -> dict:
    return run_pipeline(payload)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--payload", type=Path)
    parser.add_argument("--prepare", action="store_true")
    parser.add_argument("--cache-dir", type=Path)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--wait-for-parent", action="store_true")
    args = parser.parse_args()
    if args.wait_for_parent and sys.stdin.readline().strip() != "go":
        return 1
    if args.prepare:
        if args.cache_dir is None:
            parser.error("--cache-dir is required with --prepare")
        prepare(args.cache_dir.resolve(), args.device)
        return 0
    if args.payload is None:
        parser.error("--payload is required")
    payload = json.loads(args.payload.read_text(encoding="utf-8"))
    result_path = args.payload.parent / "runner-result.json"
    try:
        result = execute(payload)
        write_json(result_path, {"ok": True, **result})
        return 0
    except Exception as exc:
        traceback.print_exc()
        write_json(result_path, {
            "ok": False,
            "error_code": getattr(exc, "code", "PIPELINE_FAILED"),
        })
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
