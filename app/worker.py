import argparse
import csv
import json
import logging
import math
import os
from pathlib import Path
import subprocess
import time
import traceback

from filelock import FileLock, Timeout

from app.core.config import PROJECT_ROOT, Settings
from app.core.processes import run_process
from app.services.plate_jobs import JobService, safe_path

logger = logging.getLogger("plate-worker")
ERRORS = {
    "ENVIRONMENT_ERROR": "Pipeline environment is unavailable or incompatible; see worker.log.",
    "CUDA_UNAVAILABLE": "CUDA is unavailable in the configured pipeline interpreter.",
    "CUDA_ERROR": "CUDA inference failed; see worker.log.",
    "CHECKPOINT_MISSING": "Model checkpoint is missing or changed; run model preparation.",
    "INVALID_VIDEO": "Video cannot be decoded consistently or has invalid frame timing.",
    "PIPELINE_FAILED": "Pipeline did not complete; see worker.log.",
    "RESULT_INVALID": "Pipeline artifacts failed validation; see worker.log.",
    "JOB_TIMEOUT": "Video processing exceeded the configured timeout.",
    "WORKER_INTERRUPTED": "Worker stopped before the job completed.",
}


class JobFailure(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def pipeline_environment():
    env = dict(os.environ, PYTHONUNBUFFERED="1", PYTHONIOENCODING="utf-8", HF_HUB_OFFLINE="1")
    env["PYTHONPATH"] = str(PROJECT_ROOT) + os.pathsep + env.get("PYTHONPATH", "")
    return env


def execute_pipeline(settings, job, folder):
    payload = {**job, "device": settings.device, "cache_dir": str(settings.cache_dir),
               "output_root": str(folder / "runs")}
    input_file = folder / "runner-input.json"
    input_file.write_text(json.dumps(payload), encoding="utf-8")
    with (folder / "worker.log").open("w", encoding="utf-8") as log:
        try:
            code = run_process([str(settings.pipeline_python), "-m", "app.pipeline_runner", "--wait-for-parent",
                                "--payload", str(input_file)], env=pipeline_environment(), log=log,
                               timeout=settings.job_timeout_seconds)
        except subprocess.TimeoutExpired as exc:
            raise JobFailure("JOB_TIMEOUT") from exc
        except OSError as exc:
            logger.exception("Cannot start pipeline interpreter")
            log.write(str(exc))
            raise JobFailure("ENVIRONMENT_ERROR") from exc
    result_file = folder / "runner-result.json"
    if not result_file.is_file():
        raise JobFailure("PIPELINE_FAILED")
    result = json.loads(result_file.read_text(encoding="utf-8"))
    if code or not result.get("ok"):
        raise JobFailure(result.get("error_code", "PIPELINE_FAILED"))
    return result


def collect_results(folder, model, result):
    run_dir = Path(result["run_dir"]).resolve()
    runs = (folder / "runs").resolve()
    if not run_dir.is_relative_to(runs) or run_dir == runs:
        raise ValueError("Run directory outside job")
    report = json.loads((run_dir / "report.json").read_text(encoding="utf-8"))
    if report["status"] != "complete" or report["models"][model]["status"] != "complete":
        raise ValueError("Incomplete pipeline output")
    frame_count = int(result["selected_frames"])
    if frame_count < 1 or frame_count != report["frame_count"]:
        raise ValueError("Frame count mismatch")
    crops = []
    with (run_dir / "ocr_crop_manifest.csv").open(encoding="utf-8-sig", newline="") as source:
        for index, row in enumerate(csv.DictReader(source)):
            if row["model"] != model:
                raise ValueError("Unexpected model in crop manifest")
            path = safe_path(run_dir, row["crop_path"])
            if not path.is_file() or path.suffix.lower() not in (".jpg", ".jpeg"):
                raise ValueError("Missing JPEG crop")
            crop = {
                "crop_id": f"{index + 1:08d}", "frame_index": int(row["frame_index"]),
                "timestamp_seconds": float(row["timestamp_seconds"]), "confidence": float(row["confidence"]),
                "bbox": [float(row[k]) for k in ("x1", "y1", "x2", "y2")],
                "crop_bbox": [int(row[k]) for k in ("crop_x1", "crop_y1", "crop_x2", "crop_y2")],
                "path": path.relative_to(folder.resolve()).as_posix(),
            }
            values = [crop["timestamp_seconds"], crop["confidence"], *crop["bbox"]]
            if not all(math.isfinite(value) for value in values) or not 0 <= crop["confidence"] <= 1:
                raise ValueError("Invalid numeric metadata")
            if crop["frame_index"] < 1 or crop["timestamp_seconds"] < 0:
                raise ValueError("Invalid frame metadata")
            for box in (crop["bbox"], crop["crop_bbox"]):
                if box[0] < 0 or box[1] < 0 or box[2] <= box[0] or box[3] <= box[1]:
                    raise ValueError("Invalid bounding box")
            crops.append(crop)
    if len(crops) != report["models"][model]["total_detections"]:
        raise ValueError("Crop count mismatch")
    return frame_count, crops


def process_one(service, runner=execute_pipeline):
    job = service.repo.claim()
    if job is None:
        return False
    folder = service.job_dir(job["job_id"])
    logger.info("Processing %s (%s)", job["job_id"], job["model"])
    stage = "pipeline"
    try:
        result = runner(service.settings, job, folder)
        stage = "results"
        frame_count, crops = collect_results(folder, job["model"], result)
        service.repo.succeed(job["job_id"], frame_count, crops)
    except BaseException as exc:
        code = getattr(exc, "code", "RESULT_INVALID" if stage == "results" else "PIPELINE_FAILED")
        if isinstance(exc, (KeyboardInterrupt, SystemExit)):
            code = "WORKER_INTERRUPTED"
        logger.exception("Job %s failed: %s", job["job_id"], code)
        try:
            with (folder / "worker.log").open("a", encoding="utf-8") as log:
                traceback.print_exc(file=log)
        except OSError:
            logger.exception("Could not append job log")
        service.repo.fail(job["job_id"], code if code in ERRORS else "PIPELINE_FAILED",
                          ERRORS.get(code, ERRORS["PIPELINE_FAILED"]))
        if isinstance(exc, (KeyboardInterrupt, SystemExit)):
            raise
    return True


def main():
    parser = argparse.ArgumentParser(description="Single local plate extraction worker")
    parser.add_argument("--once", action="store_true", help="Process at most one queued job")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    settings = Settings.from_env()
    service = JobService(settings)
    service.repo.initialize()
    try:
        with FileLock(str(settings.data_dir / "worker.lock"), timeout=0):
            service.repo.recover()
            while True:
                worked = process_one(service)
                if args.once:
                    return
                if not worked:
                    time.sleep(settings.poll_seconds)
    except Timeout:
        raise SystemExit("Another worker already owns this data directory.")
    except KeyboardInterrupt:
        logger.info("Worker stopped")


if __name__ == "__main__":
    main()
