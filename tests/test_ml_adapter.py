"""Pipeline protocol integration only: synthetic boxes, never model accuracy claims."""
import json
from pathlib import Path
import sys
from types import SimpleNamespace

import cv2
import numpy as np
import pytest

from app.recognition.runner import _video_detections
from app.recognition.video_tracking import check_frame_count, video_config

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


def _plate_video(path, frames, fps=10.):
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"), fps, (320, 180))
    assert writer.isOpened()
    for index in range(frames):
        frame = np.full((180, 320, 3), 80 + index % 100, np.uint8)
        frame[40:70, 40:140] = 220
        writer.write(frame)
    writer.release()


def test_streamed_session_matches_file_tracking(tmp_path):
    """A live source pushing decoded frames gets exactly the file pipeline's result."""
    from app.recognition.video_tracking import TrackSession, read_frames, track_video
    video = tmp_path / "input.avi"
    _plate_video(video, 30)
    cfg = video_config(video, {"device": "cpu", "sampling": SAMPLING, "tracking": TRACKING, "empty_scene_gate": GATE})
    _, file_frames, file_candidates, _ = track_video(video, BoxFixture(), cfg, tmp_path)
    streamed = []
    with TrackSession(BoxFixture(), cfg) as session:
        for index, timestamp, image, _ in read_frames(video):
            streamed += session.push(index, timestamp, image)  # gray computed by the session
        streamed += session.close()
    assert streamed == file_candidates and len(streamed) == 1
    assert session.frames == file_frames
    assert all(len(frame["sampled_jpeg_sha256"]) == 64 for frame in session.frames)


def test_max_track_seconds_finishes_a_parked_track_once(tmp_path):
    from app.recognition.video_tracking import TrackSession, read_frames
    video = tmp_path / "parked.avi"
    _plate_video(video, 40)  # the same plate stays in view for 4 s
    cfg = {**video_config(video, {"device": "cpu", "sampling": SAMPLING, "tracking": {**TRACKING, "batch": 1},
                                  "empty_scene_gate": GATE}), "max_track_seconds": 1.0}
    emitted_at = []
    with TrackSession(BoxFixture(), cfg) as session:
        for index, timestamp, image, gray in read_frames(video):
            emitted_at += [(timestamp, c) for c in session.push(index, timestamp, image, gray)]
        assert session.close() == []  # the closed track is not finished a second time
    assert len(emitted_at) == 1
    timestamp, candidate = emitted_at[0]
    assert timestamp == pytest.approx(1.0)  # emitted while the stream is still running
    assert candidate["first_frame"] == 1 and candidate["last_frame"] == 11
    assert session.active == {}
    with pytest.raises(ValueError, match="max_track_seconds"):
        TrackSession(BoxFixture(), {**cfg, "max_track_seconds": -1})


def test_retained_images_export_the_same_evidence_as_a_second_decode(tmp_path):
    from app.recognition.video_tracking import (TrackSession, export_crops, export_retained, read_frames,
                                                track_video)
    video = tmp_path / "input.avi"
    _plate_video(video, 30)
    cfg = video_config(video, {"device": "cpu", "sampling": SAMPLING, "tracking": TRACKING, "empty_scene_gate": GATE})
    file_out, live_out = tmp_path / "file", tmp_path / "live"
    file_out.mkdir()
    live_out.mkdir()
    pts, frames, candidates, _ = track_video(video, BoxFixture(), cfg, file_out)
    expected = export_crops(video, cfg, file_out, pts, frames, candidates)
    retained = []
    with TrackSession(BoxFixture(), cfg, retain_images=True) as session:
        for index, timestamp, image, gray in read_frames(video):
            retained += session.push(index, timestamp, image, gray)
            assert session.retained_frames <= index
        retained += session.close()
    assert session.frames == [] and session.retained_frames == 0
    assert [sorted(c["jpeg"]) for c in retained] == [[r["frame_index"] for r in c["rows"]] for c in retained]
    assert export_retained(retained, cfg, live_out) == expected
    for row in expected:
        for key in ("crop_path", "sampled_frame_path"):
            assert (live_out / row[key]).read_bytes() == (file_out / row[key]).read_bytes()


def test_retained_images_are_released_once_a_parked_track_is_finished(tmp_path):
    from app.recognition.video_tracking import TrackSession, read_frames
    video = tmp_path / "parked.avi"
    _plate_video(video, 40)
    cfg = {**video_config(video, {"device": "cpu", "sampling": SAMPLING, "tracking": {**TRACKING, "batch": 1},
                                  "empty_scene_gate": GATE}), "max_track_seconds": 1.0}
    after_finish = []
    with TrackSession(BoxFixture(), cfg, retain_images=True) as session:
        for index, timestamp, image, gray in read_frames(video):
            emitted = session.push(index, timestamp, image, gray)
            if emitted or after_finish:
                after_finish.append(session.retained_frames)
            if emitted:
                assert len(emitted[0]["jpeg"]) == 5
        session.close()
    assert len(after_finish) == 30 and set(after_finish) == {0}  # the closed track keeps nothing


def test_read_frames_stops_decoder_when_consumer_leaves_early(tmp_path):
    import threading
    from app.recognition.video_tracking import read_frames
    video = tmp_path / "long.avi"
    _plate_video(video, 60)
    frames = read_frames(video, prefetch=2)
    first = next(frames)
    assert first[0] == 1 and first[1] == 0 and first[3].shape == (180, 320)
    frames.close()
    assert not any(t.name == "video-decode" for t in threading.enumerate())
    with pytest.raises(ValueError, match="Cannot open video"):
        next(read_frames(tmp_path / "missing.avi"))


def test_frame_count_tolerates_only_a_short_missing_tail():
    check_frame_count(49584, 49584, 27.5)
    check_frame_count(49567, 49584, 27.5)  # stream-copied cut: 17 trailing frames never decode
    check_frame_count(30, 0, 10.)  # container without a frame count
    for decoded in (49585, 49000):  # surplus, or a gap beyond max(1%, 2 s)
        with pytest.raises(RuntimeError, match="frame count"):
            check_frame_count(decoded, 49584, 27.5)


def test_four_crop_tracks_are_kept_when_the_pipeline_allows_them(tmp_path):
    from app.recognition.runner import build_appearance

    video = tmp_path / "short.avi"
    _plate_video(video, 4)
    payload = {"input_path": str(video), "pipeline_snapshot": {"device": "cpu", "sampling": SAMPLING,
               "tracking": {**TRACKING, "min_frames": 4}, "empty_scene_gate": GATE}}
    folder = tmp_path / "recognition"
    folder.mkdir()
    appearances, stats = _video_detections(payload, BoxFixture(), folder, tmp_path)
    assert stats["rejected_tracks"] == {} and stats["total_detections"] == 4
    detections = appearances[0]["detections"]
    assert [d["selected_order"] for d in detections] == [1, 2, 3, 4]
    assert len({d["crop_storage_key"] for d in detections}) == 4
    with pytest.raises(ValueError, match="invalid selection"):
        build_appearance({"track_id": "1", "first_frame": 1, "last_frame": 3}, [
            {"selected_order": i, "frame_index": i} for i in (1, 2, 3)], folder, tmp_path, 0, 1, "video_pts")
