"""Executed in the configured ML interpreter, independent of the API dependencies."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import traceback

MODELS = ("yolov8", "yolo11n", "yolo11m", "yolo26n")


class RunnerError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def write_json(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, allow_nan=False), encoding="utf-8")
    temporary.replace(path)


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def check_environment(device, model):
    try:
        import torch
        from plate_pipeline.environment import validate_detector_environment
        validate_detector_environment(model)
    except Exception as exc:
        raise RunnerError("ENVIRONMENT_ERROR", str(exc)) from exc
    if device == "cuda" and not torch.cuda.is_available():
        raise RunnerError("CUDA_UNAVAILABLE", "CUDA is not available in the configured interpreter.")


def prepare(cache, device):
    from plate_pipeline.detectors import load_detector
    from PIL import Image
    import numpy as np

    cache.mkdir(parents=True, exist_ok=True)
    # Check inference, not just loading weights (including device compatibility).
    sample = cache / "preflight.jpg"
    Image.fromarray(np.zeros((128, 256, 3), dtype=np.uint8)).save(sample)
    for model in MODELS:
        check_environment(device, model)
        detector = load_detector(model, cache, device == "cuda")
        with Image.open(sample) as picture:
            detector.predict(sample, picture.convert("RGB"), 0.25)
        weight_hash = detector.info["weight_sha256"]
        candidates = [p for p in cache.rglob("*") if p.is_file() and p.stat().st_size > 1024 * 1024]
        matches = [p for p in candidates if digest(p) == weight_hash]
        if not matches:
            raise RuntimeError(f"Cannot locate cached checkpoint for {model}")
        write_json(cache / f"ready-{model}.json", {
            "model": model, "device": device, "python": str(Path(sys.executable).resolve()),
            "weights": [{"path": p.relative_to(cache).as_posix(), "sha256": weight_hash} for p in matches],
        })
        print(f"READY {model} on {device}", flush=True)
        del detector
        if device == "cuda":
            import torch
            torch.cuda.empty_cache()


def check_checkpoint(cache, model, device):
    from plate_pipeline.io import resolve_relative
    try:
        manifest = json.loads((cache / f"ready-{model}.json").read_text(encoding="utf-8"))
        if manifest["device"] != device or manifest["python"] != str(Path(sys.executable).resolve()):
            raise ValueError("Preparation interpreter/device differs; prepare models again.")
        if not manifest["weights"]:
            raise ValueError("Checkpoint manifest is empty.")
        for item in manifest["weights"]:
            path = resolve_relative(cache, item["path"])
            if not path.is_file() or digest(path) != item["sha256"]:
                raise ValueError("Missing or changed checkpoint.")
    except Exception as exc:
        raise RunnerError("CHECKPOINT_MISSING", str(exc)) from exc


def execute(payload):
    model, device = payload["model"], payload["device"]
    if model not in MODELS or device not in ("cpu", "cuda"):
        raise RunnerError("CONFIGURATION_ERROR", "Unsupported model or device.")
    check_environment(device, model)
    cache = Path(payload["cache_dir"])
    check_checkpoint(cache, model, device)
    import cv2
    video = cv2.VideoCapture(payload["input_path"])
    try:
        fps = video.get(cv2.CAP_PROP_FPS)
        if not video.isOpened() or not math.isfinite(fps) or fps <= 0 or not video.read()[0]:
            raise RunnerError("INVALID_VIDEO", "Cannot decode video or invalid FPS.")
    finally:
        video.release()

    from plate_pipeline import PipelineConfig, SamplingConfig, run_pipeline
    cfg = PipelineConfig(video_path=payload["input_path"], output_root=payload["output_root"],
                         cache_dir=str(cache), detector=model, confidence=payload["confidence"],
                         require_gpu=device == "cuda", mode="pipeline",
                         interpreters={model: sys.executable}, sampling=SamplingConfig(show_progress=False))
    try:
        result = run_pipeline(cfg)
    except Exception as exc:
        code = "INVALID_VIDEO" if "failed at sampling" in str(exc) else "PIPELINE_FAILED"
        raise RunnerError(code, str(exc)) from exc
    if result.status != "complete":
        report = json.loads(result.report_path.read_text(encoding="utf-8"))
        detail = json.dumps(report)
        code = "CUDA_ERROR" if "cuda" in detail.lower() or "out of memory" in detail.lower() else "PIPELINE_FAILED"
        raise RunnerError(code, detail)
    return {"run_dir": str(result.run_dir), "selected_frames": result.frame_count}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--payload", type=Path)
    parser.add_argument("--prepare", action="store_true")
    parser.add_argument("--cache-dir", type=Path)
    parser.add_argument("--device", choices=["cpu", "cuda"], default="cpu")
    parser.add_argument("--wait-for-parent", action="store_true")
    args = parser.parse_args()
    if args.wait_for_parent and sys.stdin.readline().strip() != "go":
        return 1
    if args.prepare:
        if args.device == "cpu":
            os.environ["CUDA_VISIBLE_DEVICES"] = ""
        prepare(args.cache_dir.resolve(), args.device)
        return 0
    payload = json.loads(args.payload.read_text(encoding="utf-8"))
    if payload["device"] == "cpu":
        os.environ["CUDA_VISIBLE_DEVICES"] = ""
    result_path = args.payload.parent / "runner-result.json"
    try:
        result = execute(payload)
        write_json(result_path, {"ok": True, **result})
        return 0
    except Exception as exc:
        traceback.print_exc()
        write_json(result_path, {"ok": False, "error_code": getattr(exc, "code", "PIPELINE_FAILED")})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
