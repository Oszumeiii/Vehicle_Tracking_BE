"""Pipeline protocol integration only: synthetic boxes, never model accuracy claims."""
import json
from pathlib import Path
import sys
from types import SimpleNamespace

import cv2
import numpy as np
import pytest

from app.recognition.runner import _video_detections
from app.recognition.video_tracking import video_config

SAMPLING = {"low_fps": 10., "med_fps": 10., "high_fps": 10., "threshold_low": 2., "threshold_high": 6.}
TRACKING = {"imgsz": 320, "batch": 4, "track_buffer_seconds": 1.5, "crop_padding": .15, "crop_confidence": .25}
GATE = {"enabled": True, "probe_seconds": .25, "empty_confirmations": 3, "motion_fraction": .003, "warmup_frames": 60}


class BoxFixture:
    def predict(self, images, **kwargs):
        from ultralytics.engine.results import Boxes
        return [SimpleNamespace(boxes=Boxes(np.asarray([[40, 40, 140, 70, .95, 0]], dtype=np.float32), im.shape[:2])) for im in images]


def test_real_tracking_exports_five_ordered_pts_crops_without_camera_defaults(tmp_path):
    video = tmp_path / "input.avi"
    writer = cv2.VideoWriter(str(video), cv2.VideoWriter_fourcc(*"MJPG"), 10., (320, 180))
    assert writer.isOpened()
    for index in range(30):
        frame = np.full((180, 320, 3), 80 + index, np.uint8)
        frame[40:70, 40:140] = 220
        writer.write(frame)
    writer.release()
    snapshot = {"device": "cpu", "sampling": SAMPLING, "tracking": TRACKING, "empty_scene_gate": GATE}
    payload = {"input_path": str(video), "pipeline_snapshot": snapshot}
    cfg = video_config(video, snapshot)
    assert (cfg["width"], cfg["height"], cfg["declared_frames"]) == (320, 180, 30)
    assert cfg["device"] == "cpu" and cfg["botsort"]["track_buffer"] == 15
    folder = tmp_path / "recognition"
    folder.mkdir()
    appearances, statistics = _video_detections(payload, BoxFixture(), folder, tmp_path)
    assert statistics["decoded_frames"] == 30
    assert statistics["accepted_tracks"] == 1
    assert statistics["total_detections"] == 5
    appearance = appearances[0]
    assert appearance["first_frame"] == 1 and appearance["last_frame"] == 30
    assert appearance["start_seconds"] == 0
    assert appearance["end_seconds"] == pytest.approx(2.9)
    detections = appearance["detections"]
    assert len({d["frame_index"] for d in detections}) == 5
    assert all(d["timestamp_source"] == "video_pts" for d in detections)
    for detection in detections:
        assert detection["timestamp_seconds"] == pytest.approx((detection["frame_index"] - 1) / 10)
        assert cv2.imread(str(tmp_path / detection["crop_storage_key"])).shape[:2] == (detection["crop_height"], detection["crop_width"])
        assert (tmp_path / detection["frame_storage_key"]).is_file()
    config = json.loads((folder / "tracking/config.json").read_text())
    assert config["sampling"] == SAMPLING and config["empty_scene_gate"] == GATE
    assert statistics["frame_gate"]["detector_frames"] == 30  # warm-up never skips YOLO


def test_track_with_only_four_valid_frames_is_reported_and_not_duplicated(tmp_path):
    video = tmp_path / "short.avi"
    writer = cv2.VideoWriter(str(video), cv2.VideoWriter_fourcc(*"MJPG"), 10., (320, 180))
    for _ in range(4):
        writer.write(np.full((180, 320, 3), 180, np.uint8))
    writer.release()
    payload = {"input_path": str(video), "pipeline_snapshot": {"device": "cpu",
        "sampling": SAMPLING, "tracking": TRACKING, "empty_scene_gate": GATE}}
    folder = tmp_path / "recognition"
    folder.mkdir()
    appearances, stats = _video_detections(payload, BoxFixture(), folder, tmp_path)
    assert appearances == []
    assert stats["rejected_tracks"] == {"fewer_than_five_valid_frames": 1}
    assert stats["rejected_track_count"] == 1


def test_prepare_runs_real_video_tracking_without_loading_ocr(tmp_path, monkeypatch):
    """Synthetic detector isolates the adapter contract; this is not accuracy testing."""
    import hashlib
    import ultralytics
    from app.recognition.runner import execute

    video = tmp_path / "prepare.avi"
    writer = cv2.VideoWriter(str(video), cv2.VideoWriter_fourcc(*"MJPG"), 10., (320, 180))
    assert writer.isOpened()
    for _ in range(30):
        writer.write(np.full((180, 320, 3), 180, np.uint8))
    writer.release()
    checkpoint = tmp_path / "test-detector.pt"
    checkpoint.write_bytes(b"synthetic-detector-test")
    monkeypatch.setattr(ultralytics, "YOLO", lambda _: BoxFixture())
    folder = tmp_path / "prepared"
    folder.mkdir()
    snapshot = {
        "task": "prepare", "device": "cpu",
        "detector": {"checkpoint": str(checkpoint), "sha256": hashlib.sha256(checkpoint.read_bytes()).hexdigest()},
        "code_files": [],
        "sampling": SAMPLING, "tracking": TRACKING, "empty_scene_gate": GATE,
    }
    result = execute({"job_kind": "detect_only", "input_mode": "scene", "media_type": "video",
                      "input_path": str(video), "pipeline_snapshot": snapshot, "output_dir": str(folder), "data_dir": str(tmp_path)})
    assert result["statistics"]["accepted_tracks"] == 1
    appearance = result["appearances"][0]
    assert appearance["machine_status"] == "not_run"
    assert appearance["machine_text"] is None and appearance["agreement_count"] == 0
    assert len(appearance["detections"]) == 5
    assert all(d["predictions"] == [] for d in appearance["detections"])
    assert len({d["frame_index"] for d in appearance["detections"]}) == 5
    assert json.loads((folder / "progress.json").read_text())["stage"] == "persisting"


@pytest.mark.parametrize("raw_text, expected_status", [("abc-1234", "readable"), ("", "unreadable")])
def test_joint_model_runs_once_on_five_real_ordered_crops(tmp_path, monkeypatch, raw_text, expected_status):
    decoding = {"decoder": "beam_filter", "beam_width": 8, "use_tta": False, "plate_text": raw_text,
                "greedy_text": raw_text, "format_valid": False, "greedy_symbol_confidence": .9,
                "beam_log_score": -1.0, "beam_confidence_proxy": .85}
    import hashlib
    import ultralytics
    from app.recognition.runner import execute

    video = tmp_path / "joint.avi"
    writer = cv2.VideoWriter(str(video), cv2.VideoWriter_fourcc(*"MJPG"), 10., (320, 180))
    assert writer.isOpened()
    for index in range(30):
        writer.write(np.full((180, 320, 3), 80 + index, np.uint8))
    writer.release()
    checkpoint = tmp_path / "fixture.pt"
    checkpoint.write_bytes(b"synthetic-model-protocol-test")
    monkeypatch.setattr(ultralytics, "YOLO", lambda _: BoxFixture())
    calls = []

    def create_recognizer(spec):
        def predict(images):
            assert isinstance(images, list) and len(images) == 5
            assert all(image.mode == "RGB" for image in images)
            means = [np.asarray(image).mean() for image in images]
            assert means == sorted(means) and len(set(means)) == 5
            calls.append(means)
            return {"raw_text": raw_text, "frame_weights": [.1, .2, .3, .25, .15], "decoding": decoding}
        return predict

    monkeypatch.setitem(sys.modules, "joint_fixture_adapter", SimpleNamespace(create=create_recognizer))
    snapshot = {
        "task": "recognize", "device": "cpu",
        "detector": {"checkpoint": str(checkpoint), "sha256": hashlib.sha256(checkpoint.read_bytes()).hexdigest()},
        "recognizer": {"checkpoint": str(checkpoint), "sha256": hashlib.sha256(checkpoint.read_bytes()).hexdigest(),
                       "input_mode": "five_frame_joint", "module_root": str(tmp_path), "factory": "joint_fixture_adapter:create"},
        "code_files": [],
        "sampling": SAMPLING, "tracking": TRACKING, "empty_scene_gate": GATE,
    }
    folder = tmp_path / "joint"
    folder.mkdir()
    payload = {"job_kind": "recognize", "input_mode": "scene", "media_type": "video", "input_path": str(video),
               "pipeline_snapshot": snapshot, "output_dir": str(folder), "data_dir": str(tmp_path)}
    result = execute(payload)
    assert len(calls) == 1
    appearance = result["appearances"][0]
    assert appearance["recognition_method"] == "joint_multiframe"
    assert appearance["agreement_count"] is None
    assert appearance["machine_status"] == expected_status
    assert appearance["machine_text"] == ("ABC1234" if raw_text else None)
    assert all(d["predictions"] == [] for d in appearance["detections"])
    assert len(appearance["predictions"]) == 1
    prediction = appearance["predictions"][0]
    assert prediction["variant"] == "joint" and prediction["ocr_score"] is None
    assert prediction["frame_weights"] == [.1, .2, .3, .25, .15]
    assert prediction["input_storage_keys"] == [d["crop_storage_key"] for d in appearance["detections"]]
    assert prediction["decoding"] == decoding
    track = appearance["source_track_id"]
    # merge_tracks ignores texts shorter than five characters, as in the notebook.
    assert result["statistics"]["vehicle_groups"] == ([{
        "plate_text": "ABC1234", "best_track_id": track, "track_ids": [track], "variants": ["ABC1234"],
        "n_tracks": 1, "confidence": .85, "first_seen": appearance["detections"][0]["timestamp_seconds"],
        "last_seen": appearance["detections"][-1]["timestamp_seconds"]}] if raw_text else [])
    with pytest.raises(ValueError, match="scene video only"):
        execute({**payload, "media_type": "image"})
    assert len(calls) == 1


def test_joint_predict_rejects_duplicated_input_and_invalid_fusion_weights(tmp_path):
    from PIL import Image
    from app.recognition.runner import _predict_joint
    paths = []
    for index in range(5):
        path = tmp_path / f"crop-{index}.png"
        Image.new("RGB", (10, 5), (index, index, index)).save(path)
        paths.append(path)
    with pytest.raises(ValueError, match="distinct crop"):
        _predict_joint(lambda _: {"raw_text": "A"}, [paths[0]] * 5, tmp_path)
    with pytest.raises(ValueError, match="normalized probabilities"):
        _predict_joint(lambda _: {"raw_text": "A", "frame_weights": [.5] * 5}, paths, tmp_path)


def test_merge_tracks_joins_broken_ids_and_votes_per_character():
    from app.recognition.fusion import merge_tracks
    tracks = [dict(track_id="1", plate_text="ABC1234", confidence=.9, first_seen=0., last_seen=1.),
              dict(track_id="2", plate_text="ABC1284", confidence=.5, first_seen=2., last_seen=3.),
              dict(track_id="3", plate_text="ABC1234", confidence=.7, first_seen=3.5, last_seen=4.),
              dict(track_id="4", plate_text="XYZ9876", confidence=.8, first_seen=1., last_seen=2.),
              dict(track_id="5", plate_text="ABC1234", confidence=.6, first_seen=20., last_seen=21.),
              dict(track_id="6", plate_text="AB12", confidence=.99, first_seen=0., last_seen=1.)]
    groups = merge_tracks(tracks)
    assert [g["track_ids"] for g in groups] == [["1", "3", "2"], ["4"], ["5"]]
    assert groups[0]["plate_text"] == "ABC1234" and groups[0]["variants"] == ["ABC1234", "ABC1284"]
    assert groups[0]["first_seen"] == 0. and groups[0]["last_seen"] == 4.


def test_quality_selection_prefers_sharp_large_crops_and_keeps_time_order():
    from app.recognition.video_tracking import select_five
    rows = [dict(frame_index=i, timestamp_seconds=i / 10, confidence=.9, sharpness=1. if i < 10 else 500.,
                 box_height=10. if i < 10 else 30., edge_ok=1) for i in range(1, 21)]
    chosen, reason = select_five(rows, {"crop_confidence": .25})
    frames = [r["frame_index"] for r in chosen]
    assert reason is None and frames == sorted(frames) and len(set(frames)) == 5
    assert min(frames) >= 10  # the blurry/small first half is outside the quality pool
    assert select_five(rows[:4], {"crop_confidence": .25}) == (None, "fewer_than_five_valid_frames")


def test_empty_scene_gate_skips_quiet_frames_only_after_confirmations():
    from app.recognition.video_tracking import EmptySceneGate
    gate = EmptySceneGate(probe_seconds=.25, empty_confirmations=2, warmup_frames=1)
    still = np.zeros((180, 320, 3), np.uint8)
    for _ in range(3):
        gate.observe_image(still)
    assert gate.decide(0.0) == (True, "confirm_scene")
    gate.observe_detection(0, False)
    gate.observe_detection(0, False)
    assert gate.idle
    assert gate.decide(0.1) == (False, "idle_skip")  # last kept frame was at 0.0s
    assert gate.decide(0.3) == (True, "periodic_probe")
    assert gate.decide(0.4) == (False, "idle_skip")
    gate.observe_detection(1, True)
    assert gate.decide(0.5) == (True, "live_track")
