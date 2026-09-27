"""Real video acceptance check. Run with: python -m scripts.smoke_local --video ..."""
import argparse
import csv
from dataclasses import replace
import json
import os
from pathlib import Path
import subprocess
import sys
import time

from fastapi.testclient import TestClient

from app.core.config import MODELS, Settings
from main import create_app


def run():
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", type=Path, required=True)
    args = parser.parse_args()
    configured = Settings.from_env()
    settings = replace(configured, data_dir=configured.data_dir / f"smoke-{time.time_ns()}")
    env = dict(os.environ, PLATE_DATA_DIR=str(settings.data_dir), PLATE_CACHE_DIR=str(settings.cache_dir),
               PLATE_PIPELINE_PYTHON=str(settings.pipeline_python), PLATE_DEVICE=settings.device)
    evidence = {"video": str(args.video.resolve()), "device": settings.device, "models": {}}
    with TestClient(create_app(settings)) as client:
        for model in MODELS:
            started = time.monotonic()
            with args.video.open("rb") as source:
                response = client.post("/api/v1/plate-jobs", files={"file": (args.video.name, source, "video/mp4")},
                                       data={"model": model})
            assert response.status_code == 202, response.text
            url = response.json()["status_url"]
            job_id = response.json()["job_id"]
            with (settings.data_dir / f"{model}-worker.log").open("w") as log:
                worker = subprocess.Popen([sys.executable, "-m", "app.worker", "--once"], env=env,
                                          stdout=log, stderr=subprocess.STDOUT)
                polls = 0
                try:
                    while worker.poll() is None:
                        assert client.get("/health").status_code == 200
                        assert client.get(url).status_code == 200
                        polls += 1
                        if time.monotonic() - started > settings.job_timeout_seconds + 60:
                            raise TimeoutError("Worker did not finish")
                        time.sleep(2)
                    assert worker.returncode == 0
                finally:
                    if worker.poll() is None:
                        worker.terminate()
                    worker.wait()
            status = client.get(url).json()
            assert status["status"] == "succeeded", status
            folder = client.app.state.jobs.job_dir(job_id)
            result = json.loads((folder / "runner-result.json").read_text())
            root = Path(result["run_dir"])
            with (root / "ocr_crop_manifest.csv").open(encoding="utf-8-sig", newline="") as source:
                manifest = list(csv.DictReader(source))
            assert len(manifest) == status["total_crops"]
            items = []
            for offset in range(0, len(manifest), 200):
                page = client.get(url + f"/plates?limit=200&offset={offset}")
                assert page.status_code == 200
                items.extend(page.json()["items"])
            for item, row in zip(items, manifest, strict=True):
                assert item["frame_index"] == int(row["frame_index"])
                assert item["timestamp_seconds"] == float(row["timestamp_seconds"])
                assert item["confidence"] == float(row["confidence"])
                assert item["bbox"] == [float(row[k]) for k in ("x1", "y1", "x2", "y2")]
                assert item["crop_bbox"] == [int(row[k]) for k in ("crop_x1", "crop_y1", "crop_x2", "crop_y2")]
                assert client.get(item["crop_url"]).content == (root / row["crop_path"]).read_bytes()
            evidence["models"][model] = {"job_id": job_id, "status": status["status"],
                                          "selected_frames": status["selected_frames"], "crops": len(items),
                                          "health_polls": polls, "elapsed_seconds": round(time.monotonic() - started, 2)}
            (settings.data_dir / "verification.json").write_text(json.dumps(evidence, indent=2), encoding="utf-8")
            print(model, evidence["models"][model], flush=True)
    print("Evidence:", settings.data_dir / "verification.json", flush=True)


if __name__ == "__main__":
    run()
