from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
import csv
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

from fastapi.testclient import TestClient
from filelock import FileLock, Timeout
import pytest

from app.core.config import Settings
from app.core.processes import run_process
from app.services.plate_jobs import JobService, safe_path
from app.worker import JobFailure, process_one
from main import create_app

BASE = "/api/v1/plate-jobs"


@pytest.fixture
def settings(tmp_path):
    return Settings(tmp_path / "data", tmp_path / "cache", Path(sys.executable), max_upload_bytes=1024)


@pytest.fixture
def client(settings):
    with TestClient(create_app(settings)) as client:
        yield client


def upload(client, data=b"video", **fields):
    return client.post(BASE, files={"file": ("camera.mp4", data, "video/mp4")}, data=fields)


def fake_runner(settings, job, folder, count=2):
    root = folder / "runs" / "fake"
    root.mkdir(parents=True)
    (root / "report.json").write_text(json.dumps({
        "status": "complete", "frame_count": 3,
        "models": {job["model"]: {"status": "complete", "total_detections": count}},
    }))
    fields = ["model", "crop_path", "frame_index", "timestamp_seconds", "confidence",
              "x1", "y1", "x2", "y2", "crop_x1", "crop_y1", "crop_x2", "crop_y2"]
    with (root / "ocr_crop_manifest.csv").open("w", newline="") as output:
        writer = csv.DictWriter(output, fields)
        writer.writeheader()
        for i in range(count):
            (root / f"{i}.jpg").write_bytes(b"\xff\xd8\xff\xd9")
            writer.writerow(dict(zip(fields, [job["model"], f"{i}.jpg", i + 1, i / 25, 0.9,
                                                10.5, 20.5, 40.5, 50.5, 5, 15, 46, 56])))
    return {"run_dir": str(root), "selected_frames": 3}


def test_complete_lifecycle_and_pagination(client):
    response = upload(client, model="yolo11m")
    assert response.status_code == 202
    url = response.json()["status_url"]
    job_id = response.json()["job_id"]
    service = client.app.state.jobs
    assert client.get(url).json()["status"] == "queued"
    assert client.get(url + "/plates").status_code == 409
    assert client.delete(url).status_code == 409
    assert process_one(service, fake_runner)
    status = client.get(url).json()
    assert status["status"] == "succeeded" and status["total_crops"] == 2
    assert status["selected_frames"] == 3 and status["finished_at"]
    assert "input_path" not in status
    page = client.get(url + "/plates?limit=1&offset=1").json()
    assert page["total"] == 2 and len(page["items"]) == 1
    plate = page["items"][0]
    assert plate["frame_index"] == 2 and plate["timestamp_seconds"] == 0.04
    assert plate["bbox"] == [10.5, 20.5, 40.5, 50.5]
    assert plate["crop_bbox"] == [5, 15, 46, 56]
    assert "path" not in plate and "job_id" not in plate
    image = client.get(plate["crop_url"])
    assert image.status_code == 200 and image.headers["content-type"] == "image/jpeg"
    assert client.get(url + "/plates?offset=10").json()["items"] == []
    assert client.delete(url).status_code == 204
    assert client.get(url).status_code == 404
    assert not service.job_dir(job_id).exists()
    assert service.repo.plates(job_id, 50, 0) == []


@pytest.mark.parametrize("fields", [{"model": "bad"}, {"confidence": "0"},
                                   {"confidence": "1.1"}, {"confidence": "nan"}, {"confidence": "inf"}])
def test_invalid_parameters(client, fields):
    assert upload(client, **fields).status_code == 422


def test_upload_limits_and_formats(client):
    assert upload(client, b"x" * 1025).status_code == 413
    assert upload(client, b"").status_code == 422
    assert client.post(BASE, files={"file": ("x.exe", b"x")}).status_code == 415
    folders = client.app.state.jobs.settings.data_dir / "jobs"
    assert not folders.exists() or not list(folders.iterdir())
    assert upload(client, b"x" * 1024).status_code == 202


def test_multipart_spooling_limit(client):
    assert upload(client, b"x" * (70 * 1024)).status_code == 413
    body = (b'--test\r\nContent-Disposition: form-data; name="file"; filename="x.mp4"\r\n'
            b'Content-Type: video/mp4\r\n\r\n' + b'x' * (70 * 1024) + b'\r\n--test--\r\n')
    response = client.post(BASE, content=iter([body[:500], body[500:]]),
                           headers={"Content-Type": "multipart/form-data; boundary=test"})
    assert response.status_code == 413
    assert response.json() == {"detail": "Video exceeds the upload limit."}


def test_result_insert_is_atomic(client):
    job_id = upload(client).json()["job_id"]
    repo = client.app.state.jobs.repo
    repo.claim()
    crop = {"crop_id": "same", "frame_index": 1, "timestamp_seconds": 0,
            "confidence": 0.9, "bbox": [0, 0, 10, 10], "crop_bbox": [0, 0, 10, 10], "path": "crop.jpg"}
    import sqlite3
    with pytest.raises(sqlite3.IntegrityError):
        repo.succeed(job_id, 1, [crop, crop])
    assert repo.plates(job_id, 50, 0) == []
    assert repo.get(job_id)["status"] == "running"


def test_not_found_and_pagination_validation(client):
    assert client.get(BASE + "/unknown").status_code == 404
    assert client.delete(BASE + "/unknown").status_code == 404
    url = upload(client).json()["status_url"]
    assert client.get(url + "/plates?limit=201").status_code == 422
    assert client.get(url + "/plates?offset=-1").status_code == 422


@pytest.mark.parametrize("model", ["yolov8", "yolo11n", "yolo11m", "yolo26n"])
def test_supported_models_and_empty_detection(client, model):
    url = upload(client, model=model).json()["status_url"]
    process_one(client.app.state.jobs, lambda *args: fake_runner(*args, count=0))
    assert client.get(url).json()["status"] == "succeeded"
    assert client.get(url + "/plates").json()["total"] == 0


def test_restart_preserves_history_and_recovers_only_running(client, settings):
    first = upload(client).json()["job_id"]
    second = upload(client).json()["job_id"]
    repo = client.app.state.jobs.repo
    assert repo.claim()["job_id"] == first
    with TestClient(create_app(settings)) as restarted:
        assert restarted.get(BASE + "/" + first).json()["status"] == "running"
        restarted.app.state.jobs.repo.recover()
        failed = restarted.get(BASE + "/" + first).json()
        assert failed["error_code"] == "WORKER_INTERRUPTED"
        assert restarted.get(BASE + "/" + second).json()["status"] == "queued"
        assert restarted.delete(BASE + "/" + first).status_code == 204


@pytest.mark.parametrize("code", ["INVALID_VIDEO", "CHECKPOINT_MISSING", "CUDA_UNAVAILABLE", "JOB_TIMEOUT"])
def test_failure_mapping(client, code):
    url = upload(client).json()["status_url"]
    def fail(*args):
        raise JobFailure(code)
    process_one(client.app.state.jobs, fail)
    status = client.get(url).json()
    assert status["status"] == "failed" and status["error_code"] == code
    assert client.get(url + "/plates").status_code == 409


def test_health_responsive_while_job_running_and_next_job_waits(client):
    first = upload(client).json()["status_url"]
    second = upload(client).json()["status_url"]
    entered, release = threading.Event(), threading.Event()
    def slow(*args):
        entered.set()
        assert release.wait(10)
        return fake_runner(*args)
    with ThreadPoolExecutor(1) as pool:
        task = pool.submit(process_one, client.app.state.jobs, slow)
        try:
            assert entered.wait(5)
            assert client.get("/health").status_code == 200
            assert client.get(first).json()["status"] == "running"
            assert client.get(second).json()["status"] == "queued"
        finally:
            release.set()
        task.result()
    process_one(client.app.state.jobs, fake_runner)
    assert client.get(second).json()["status"] == "succeeded"
    assert client.get(first + "/plates").json()["items"][0]["crop_url"] != client.get(second + "/plates").json()["items"][0]["crop_url"]


def test_atomic_claim_no_duplicates(client):
    ids = {upload(client).json()["job_id"] for _ in range(8)}
    with ThreadPoolExecutor(4) as pool:
        results = list(pool.map(lambda _: client.app.state.jobs.repo.claim(), range(10)))
    claimed = [r["job_id"] for r in results if r]
    assert len(claimed) == len(set(claimed)) == 8
    assert set(claimed) == ids


@pytest.mark.parametrize("relative", ["../outside.jpg", "C:/outside.jpg", "/outside.jpg", "..\\outside.jpg"])
def test_path_escape_rejected(tmp_path, relative):
    with pytest.raises(ValueError):
        safe_path(tmp_path, relative)


def test_corrupt_manifest_is_not_published(client):
    url = upload(client).json()["status_url"]
    def corrupt(*args):
        result = fake_runner(*args)
        manifest = Path(result["run_dir"]) / "ocr_crop_manifest.csv"
        manifest.write_text(manifest.read_text().replace("0.jpg", "../../../../outside.jpg"))
        return result
    process_one(client.app.state.jobs, corrupt)
    assert client.get(url).json()["error_code"] == "RESULT_INVALID"
    assert client.app.state.jobs.repo.plates(url.split("/")[-1], 50, 0) == []


def test_crop_cannot_escape_even_if_database_corrupt(client):
    job_id = upload(client).json()["job_id"]
    service = client.app.state.jobs
    process_one(service, fake_runner)
    with service.repo.connection() as conn:
        conn.execute("UPDATE crops SET path='../outside.jpg' WHERE job_id=?", (job_id,))
    assert client.get(f"{BASE}/{job_id}/crops/00000001").status_code == 404


def test_worker_lock_and_missing_interpreter(client):
    service = client.app.state.jobs
    with FileLock(str(service.settings.data_dir / "worker.lock")):
        with pytest.raises(Timeout):
            with FileLock(str(service.settings.data_dir / "worker.lock"), timeout=0):
                pass
    job_id = upload(client).json()["job_id"]
    service.settings = replace(service.settings, pipeline_python=service.settings.data_dir / "missing.exe")
    process_one(service)
    assert service.repo.get(job_id)["error_code"] == "ENVIRONMENT_ERROR"


def test_process_timeout_kills_descendants(tmp_path):
    marker = tmp_path / "survived.txt"
    script = tmp_path / "child.py"
    child = "import time,pathlib; time.sleep(2); pathlib.Path(" + repr(str(marker)) + ").write_text('alive')"
    script.write_text("import sys,subprocess,time\nsys.stdin.readline()\nsubprocess.Popen([sys.executable,'-c'," + repr(child) + "])\ntime.sleep(30)\n")
    with (tmp_path / "log").open("w") as log:
        with pytest.raises(subprocess.TimeoutExpired):
            run_process([sys.executable, str(script)], env=dict(os.environ), log=log, timeout=0.8)
    time.sleep(2.5)
    assert not marker.exists()


def test_openapi_documents_upload_and_models(client):
    schema = client.get("/openapi.json").json()
    assert "multipart/form-data" in schema["paths"][BASE]["post"]["requestBody"]["content"]
    assert "image/jpeg" in schema["paths"][BASE + "/{job_id}/crops/{crop_id}"]["get"]["responses"]["200"]["content"]


@pytest.mark.skipif(os.name != "nt", reason="Windows Job Object crash recovery")
def test_worker_crash_kills_descendants(tmp_path):
    ready, survived = tmp_path / "ready", tmp_path / "survived"
    child = ("import pathlib,time; pathlib.Path(" + repr(str(ready)) + ").write_text('ready'); "
             "time.sleep(2); pathlib.Path(" + repr(str(survived)) + ").write_text('alive')")
    runner = ("import sys,subprocess,time; sys.stdin.readline(); subprocess.Popen([sys.executable,'-c',"
              + repr(child) + "]); time.sleep(30)")
    parent_code = ("import os,sys; from app.core.processes import run_process; "
                   "run_process([sys.executable,'-c'," + repr(runner) + "],env=dict(os.environ),log=sys.stdout,timeout=30)")
    with (tmp_path / "parent.log").open("w") as log:
        parent = subprocess.Popen([sys.executable, "-c", parent_code], stdout=log, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 10
            while not ready.exists() and time.monotonic() < deadline and parent.poll() is None:
                time.sleep(0.1)
            assert ready.exists()
        finally:
            parent.terminate()
            parent.wait(timeout=5)
    time.sleep(2.5)
    assert not survived.exists()
