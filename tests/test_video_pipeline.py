import csv
import json

import cv2
import numpy as np
import pytest

from app.ai.pipelines.config import (
    CROP_CONFIDENCE,
    CROP_PADDING,
    DETECTOR_BATCH_SIZE,
    EMPTY_CONFIRMATIONS,
    EMPTY_SCENE_GATE,
    GATE_MOTION_FRACTION,
    GATE_WARMUP_FRAMES,
    HIGH_FPS,
    IDLE_PROBE_SECONDS,
    LOW_FPS,
    MAX_SECONDS,
    MED_FPS,
    THRESHOLD_HIGH,
    THRESHOLD_LOW,
)
from app.ai.pipelines.video_pipeline import run_video_pipeline
from app.ai.recognition.errors import NoValidPlateCandidate


class FakeDetector:
    def detect(self, images):
        return [
            np.array([[10, 20, 50, 35, 0.95, 0]], dtype=np.float32)
            for _ in images
        ]


class FakeTracker:
    def update(self, boxes, image, timestamp):
        return np.array([[10, 20, 50, 35, 7, 0.95, 0, 0]], dtype=np.float32)


class FakeRecognizer:
    def __init__(self, no_candidate=False):
        self.calls = []
        self.no_candidate = no_candidate

    def predict_bgr(self, frames):
        self.calls.append(frames)
        if self.no_candidate:
            raise NoValidPlateCandidate("No plate candidate matched.")
        return {"text": "ABC1234"}


@pytest.mark.parametrize("no_candidate", [False, True])
def test_video_pipeline_detects_tracks_selects_five_and_predicts(tmp_path, no_candidate):
    video_path = tmp_path / "input.avi"
    writer = cv2.VideoWriter(
        str(video_path), cv2.VideoWriter_fourcc(*"MJPG"), 10, (64, 64)
    )
    assert writer.isOpened()
    for frame_number in range(6):
        frame = np.zeros((64, 64, 3), dtype=np.uint8)
        cv2.putText(frame, str(frame_number), (5, 15), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255))
        writer.write(frame)
    writer.release()

    recognizer = FakeRecognizer(no_candidate)
    options = {
        "MAX_SECONDS": MAX_SECONDS,
        "DETECTOR_BATCH_SIZE": DETECTOR_BATCH_SIZE,
        "LOW_FPS": LOW_FPS,
        "MED_FPS": MED_FPS,
        "HIGH_FPS": HIGH_FPS,
        "THRESHOLD_LOW": THRESHOLD_LOW,
        "THRESHOLD_HIGH": THRESHOLD_HIGH,
        "TRACK_BUFFER_SECONDS": 1.5,
        "CROP_CONFIDENCE": CROP_CONFIDENCE,
        "CROP_PADDING": CROP_PADDING,
        "EMPTY_SCENE_GATE": EMPTY_SCENE_GATE,
        "IDLE_PROBE_SECONDS": IDLE_PROBE_SECONDS,
        "EMPTY_CONFIRMATIONS": EMPTY_CONFIRMATIONS,
        "GATE_MOTION_FRACTION": GATE_MOTION_FRACTION,
        "GATE_WARMUP_FRAMES": GATE_WARMUP_FRAMES,
    }
    result = run_video_pipeline(
        video_path,
        FakeDetector(),
        FakeTracker(),
        recognizer,
        output_root=tmp_path / "runs",
        model="yolo11n",
        options=options,
    )

    report = json.loads(result.report_path.read_text(encoding="utf-8"))
    assert report["status"] == "complete"
    assert report["frame_count"] == result.frame_count == 6
    assert report["models"]["yolo11n"]["total_detections"] == 6
    assert report["recognized_track_count"] == (0 if no_candidate else 1)
    assert recognizer.calls
    assert len(recognizer.calls[0]) == 5
    assert all(frame.shape[2] == 3 for frame in recognizer.calls[0])
    expected_status = "unrecognized" if no_candidate else "predicted"
    assert report["tracks"][0]["status"] == expected_status

    with (result.run_dir / "ocr_crop_manifest.csv").open(encoding="utf-8-sig", newline="") as manifest:
        rows = list(csv.DictReader(manifest))
    assert len(rows) == 6
    assert all((result.run_dir / row["crop_path"]).is_file() for row in rows)
