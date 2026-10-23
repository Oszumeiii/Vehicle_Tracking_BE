"""Live process protocol: synthetic sources and boxes, never network or model accuracy."""
import json
import threading

import cv2
import numpy as np
import pytest

from app.live.runner import DuplicateLinker, LiveRunner, classify
from app.live.source import FfmpegFrames, FileFrames, LiveReader, SourceError, StreamEnded, resolve_youtube
from test_ml_adapter import GATE, SAMPLING, TRACKING, BoxFixture, _plate_video

SNAPSHOT = {"device": "cpu", "sampling": SAMPLING, "tracking": TRACKING, "empty_scene_gate": GATE,
            "recognizer": {"input_mode": "five_frame_joint"}}
INFO = dict(width=320, height=180, fps=10., video_id="synthetic")


def recognizer(images):
    assert len(images) == 5
    return {"raw_text": "ABC-1234", "decoding": {"decoder": "beam_filter", "beam_width": 8, "use_tta": False,
            "plate_text": "ABC-1234", "greedy_text": "ABC1234", "format_valid": True,
            "greedy_symbol_confidence": .7, "beam_log_score": -1., "beam_confidence_proxy": .9}}


class Frames:
    """A connection yielding given frames, then optionally failing; records close()."""

    def __init__(self, frames, error=None, finite=False, after=None):
        self.frames, self.error, self.finite, self.after, self.closed = frames, error, finite, after, False

    def __iter__(self):
        for i, frame in enumerate(self.frames):
            yield frame
            if self.after:
                self.after(i)
        if self.error:
            raise self.error

    def close(self):
        self.closed = True


def video_frames(path):
    cap = cv2.VideoCapture(str(path))
    frames = []
    while True:
        ok, image = cap.read()
        if not ok:
            break
        frames.append((len(frames) / 10, image))
    cap.release()
    return frames


def run(tmp_path, sources, stop=None, **options):
    events, calls = [], iter(sources)

    def open_source():
        source = next(calls)
        if isinstance(source, Exception):
            raise source
        return INFO, source

    runner = LiveRunner(SNAPSHOT, tmp_path / "live", open_source, events.append, BoxFixture(), recognizer,
                        backoff_max=.01, **options)
    status = runner.run(stop or threading.Event())
    return status, events


def test_live_reader_keeps_newest_frames_and_counts_drops():
    image = np.zeros((180, 320, 3), np.uint8)
    reader = LiveReader(Frames([(i / 10, image) for i in range(50)]), capacity=4).start()
    reader._thread.join()
    got = []
    while (item := reader.get(timeout=.1)) is not None:
        got.append(item)
    assert [g[0] for g in got] == [47, 48, 49, 50]  # indexes count dropped frames too
    assert [g[1] for g in got] == pytest.approx([4.6, 4.7, 4.8, 4.9])
    assert reader.read == 50 and reader.dropped == 46
    assert got[0][3].shape == (180, 320) and got[0][4].tzinfo is not None
    reader.stop()


def test_unpaced_file_replay_never_drops_frames(tmp_path):
    video = tmp_path / "input.avi"
    _plate_video(video, 40)
    reader = LiveReader(FileFrames(video), capacity=2).start()
    got = []
    while (item := reader.get(timeout=2)) is not None:
        got.append(item[0])
    assert got == list(range(1, 41)) and reader.dropped == 0
    reader.stop()
    paced = LiveReader(FileFrames(video, realtime=True), capacity=2)
    assert not paced.lossless


def test_live_reader_raises_when_timestamps_go_backwards():
    image = np.zeros((180, 320, 3), np.uint8)
    reader = LiveReader(Frames([(0., image), (.1, image), (.05, image)])).start()
    assert reader.get(timeout=1)[1] == 0 and reader.get(timeout=1)[1] == .1
    with pytest.raises(SourceError, match="backwards"):
        reader.get(timeout=1)
    reader.stop()
    assert LiveReader(Frames([])).start().get(timeout=1) is None


def test_ffmpeg_frames_pair_each_frame_with_its_timestamp(tmp_path):
    video = tmp_path / "input.avi"
    _plate_video(video, 30)
    expected = video_frames(video)
    source = FfmpegFrames(str(video), 320, 240 - 60)
    got = []
    with pytest.raises(SourceError, match="ffmpeg stopped"):  # end of a file looks like a dropped stream
        for pts, image in source:
            got.append((pts, image))
    source.close()
    assert [pts for pts, _ in got] == pytest.approx([pts for pts, _ in expected])
    assert all(np.abs(a.astype(int) - b.astype(int)).max() <= 2 for (_, a), (_, b) in zip(got, expected))


def test_runner_records_each_track_with_evidence_ocr_and_events(tmp_path):
    video = tmp_path / "input.avi"
    _plate_video(video, 30)
    status, events = run(tmp_path, [FileFrames(video)])
    assert status == "ended"
    statuses = [e["status"] for e in events if e["type"] == "status"]
    assert statuses == ["starting", "connecting", "running", "ended"]
    tracks = [e for e in events if e["type"] == "track"]
    assert len(tracks) == 1 and tracks[0]["text"] == "ABC1234" and tracks[0]["status"] == "readable"
    record = json.loads((tmp_path / "live" / tracks[0]["path"]).read_text(encoding="utf-8"))
    folder = (tmp_path / "live" / tracks[0]["path"]).parent
    appearance = record["appearance"]
    assert record["track"] == "e000-t000001" and record["captured_from"].endswith("Z")
    assert appearance["machine_status"] == "readable" and appearance["recognition_method"] == "joint_multiframe"
    detections = appearance["detections"]
    assert len(detections) == 5 and {d["timestamp_source"] for d in detections} == {"live_pts"}
    for detection in detections:
        for key in ("crop_storage_key", "frame_storage_key"):
            path = tmp_path / "live" / detection[key]
            assert path.is_file() and folder in path.parents
    assert appearance["predictions"][0]["input_storage_keys"] == [d["crop_storage_key"] for d in detections]


def test_exclude_zones_drop_detections_centred_inside_only():
    from app.recognition.video_tracking import detect_plates
    images = [np.zeros((180, 320, 3), np.uint8)]
    cfg = {"device": "cpu", "imgsz": 320}
    assert len(detect_plates(BoxFixture(), images, cfg)[0]) == 1  # box centre (0.28, 0.31)
    assert len(detect_plates(BoxFixture(), images, {**cfg, "exclude_zones": [[.5, .5, 1, 1]]})[0]) == 1
    assert len(detect_plates(BoxFixture(), images, {**cfg, "exclude_zones": [[.5, .5, 1, 1], [.2, .2, .4, .4]]})[0]) == 0


def test_runner_applies_exclude_zones_and_rejects_invalid_ones(tmp_path):
    video = tmp_path / "input.avi"
    _plate_video(video, 30)
    status, events = run(tmp_path, [FileFrames(video)], exclude_zones=[[.2, .2, .4, .4]])
    assert status == "ended" and not [e for e in events if e["type"] == "track"]
    assert {e["excluded_zones"] for e in events if e["type"] == "stats"} <= {1}
    with pytest.raises(ValueError, match="Exclude zones"):
        LiveRunner(SNAPSHOT, tmp_path, None, None, None, None, exclude_zones=[[.4, .2, .2, .4]])


def test_reconnect_opens_a_new_epoch_after_finishing_the_old_tracks(tmp_path):
    video = tmp_path / "input.avi"
    _plate_video(video, 30)
    frames = video_frames(video)
    status, events = run(tmp_path, [Frames(frames[:20], error=SourceError("network")), ConnectionError("dns"),
                                    FileFrames(video)])
    assert status == "ended"
    kinds = [(e["type"], e["status"] if e["type"] == "status" else None)
             for e in events if e["type"] in ("status", "track")]
    assert kinds == [("status", "starting"), ("status", "connecting"), ("status", "running"), ("track", None),
                     ("status", "reconnecting"), ("status", "connecting"), ("status", "reconnecting"),
                     ("status", "connecting"), ("status", "running"), ("track", None), ("status", "ended")]
    keys = [e["track"] for e in events if e["type"] == "track"]
    assert keys == ["e000-t000001", "e001-t000001"]
    assert all((tmp_path / "live" / "tracks" / key / "track.json").is_file() for key in keys)


def test_too_many_failed_reconnects_fail_the_run(tmp_path):
    status, events = run(tmp_path, [ConnectionError("down")] * 3, max_reconnects=2)
    assert status == "failed" and events[-1]["reason"] == "down"


class StopsAfter(Frames):
    """Delivers n frames, requests stop, then blocks like a live stream until closed."""

    def __init__(self, frames, n, stop):
        super().__init__(frames[:n])
        self.stop, self.released = stop, threading.Event()

    def __iter__(self):
        yield from super().__iter__()
        self.stop.set()
        self.released.wait(10)

    def close(self):
        super().close()
        self.released.set()


def test_stop_processes_received_frames_then_finishes_the_open_track(tmp_path):
    video = tmp_path / "input.avi"
    _plate_video(video, 30)
    stop = threading.Event()
    connection = StopsAfter(video_frames(video), 13, stop)
    status, events = run(tmp_path, [connection], stop=stop, reader_capacity=64)
    assert status == "stopped" and connection.closed
    assert [e["type"] for e in events].count("track") == 1
    assert events[-1] == {**events[-1], "type": "status", "status": "stopped", "tracks": 1}


def test_stream_end_during_resolve_ends_the_run(tmp_path):
    status, events = run(tmp_path, [StreamEnded("not live")])
    assert status == "ended" and events[-1]["reason"] == "not live"


def test_duplicate_linker_links_queued_car_and_near_identical_plates_only():
    linker = DuplicateLinker()
    assert linker.link("a", "MRA4A16", 0., 7.7, [10, 10, 50, 30], [100, 100, 140, 120]) is None
    # ID switch of a queued car: new track starts where "a" was last seen.
    assert linker.link("b", "MVD4A16", 9.5, 15., [101, 100, 141, 121], [0, 0, 40, 20]) == "a"
    # One character off and right after "b": linked to the chain's first track.
    assert linker.link("c", "MVD4A18", 16., 18., [300, 300, 340, 320], [0, 0, 1, 1]) == "a"
    assert linker.link("d", "XYZ9876", 17., 19., [500, 500, 540, 520], [0, 0, 1, 1]) is None  # other car
    assert linker.link("e", "MRA4A16", 40., 41., [100, 100, 140, 120], [0, 0, 1, 1]) is None  # too late


def test_confidence_status_is_advisory_only():
    assert classify("ABC1234", .9, .85) == "readable"
    assert classify("ABC1234", .84, .85) == "low_confidence"
    assert classify("ABC1234", None, .85) == "low_confidence"
    assert classify(None, .99, .85) == "unreadable"


def test_resolve_youtube_uses_node_and_rejects_finished_broadcasts():
    from yt_dlp.utils import DownloadError, ExtractorError
    seen = {}

    def fake(info):
        class YoutubeDL:
            def __init__(self, options):
                seen.update(options)

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def extract_info(self, url, download):
                assert not download
                if isinstance(info, Exception):
                    raise info
                return info
        return YoutubeDL

    def failure(message, expected):
        cause = ExtractorError(message, expected=expected)
        return DownloadError(f"ERROR: {message}", exc_info=(ExtractorError, cause, None))

    with pytest.raises(StreamEnded, match="removed by the uploader"):  # final: do not retry
        resolve_youtube("https://youtu.be/abc", fake(failure("Video unavailable. removed by the uploader", True)))
    with pytest.raises(SourceError, match="timed out"):  # transient: retry
        resolve_youtube("https://youtu.be/abc", fake(failure("Read timed out", False)))

    live = dict(id="abc", live_status="is_live", url="https://example/hls.m3u8", width=1920, height=1080, fps=30)
    assert resolve_youtube("https://youtu.be/abc", fake(live)) == dict(
        url="https://example/hls.m3u8", width=1920, height=1080, fps=30., video_id="abc", title="")
    assert seen["js_runtimes"] == {"node": {}} and seen["format"] == "bv*[height<=1080]"
    with pytest.raises(StreamEnded, match="was_live"):
        resolve_youtube("https://youtu.be/abc", fake({**live, "live_status": "was_live"}))


@pytest.mark.parametrize("chunks, stops", [([b"noise\nst", b"op\n"], True), ([b"stopping\n"], False), ([], True)])
def test_stdin_control_reads_the_raw_pipe(monkeypatch, chunks, stops):
    """A split "stop" line or EOF stops; the watcher never takes sys.stdin's buffer lock."""
    import os
    import sys
    from app.live.__main__ import watch_stdin
    read_end, write_end = os.pipe()
    monkeypatch.setattr(sys, "stdin", os.fdopen(read_end, "r"))
    stop = threading.Event()
    watcher = threading.Thread(target=watch_stdin, args=(stop,), daemon=True)
    watcher.start()
    for chunk in chunks:
        os.write(write_end, chunk)
    if not stops:
        assert not stop.wait(.3)
    os.close(write_end)  # EOF always stops
    watcher.join(5)
    assert stop.is_set() and not watcher.is_alive()
    sys.stdin.close()


def test_cli_reports_startup_failure_as_events(tmp_path, capsys):
    from app.live.__main__ import main
    payload = tmp_path / "payload.json"
    payload.write_text(json.dumps({"source": {"type": "file", "path": str(tmp_path / "x.avi")}, "pipeline_snapshot": {
        **SNAPSHOT, "task": "recognize", "code_files": [],
        "detector": {"checkpoint": str(tmp_path / "missing.pt"), "sha256": "0" * 64},
        "recognizer": {"input_mode": "five_frame_joint", "checkpoint": str(tmp_path / "missing.pt"),
                       "sha256": "0" * 64, "module_root": str(tmp_path), "factory": "x:y"}}}))
    assert main(["--payload", str(payload), "--out", str(tmp_path / "out"), "--ignore-stdin"]) == 1
    events = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert [(e["type"], e.get("code"), e.get("status")) for e in events] == [
        ("error", "CHECKPOINT_MISSING", None), ("status", None, "failed")]
    (tmp_path / "out" / "tracks" / "e000-t000001").mkdir(parents=True)
    with pytest.raises(SystemExit):  # a second run must not mix into an earlier run's tracks
        main(["--payload", str(payload), "--out", str(tmp_path / "out"), "--ignore-stdin"])
    assert "already holds tracks" in capsys.readouterr().err


def test_emitter_stops_the_run_when_the_parent_pipe_is_gone(monkeypatch, capsys):
    from app.live.__main__ import Emitter

    class Gone:
        def write(self, _):
            raise BrokenPipeError

        def flush(self):
            pass

    stop = threading.Event()
    emit = Emitter(stop)
    emit({"type": "status", "status": "running"})
    assert json.loads(capsys.readouterr().out)["status"] == "running" and not stop.is_set()
    monkeypatch.setattr("sys.stdout", Gone())
    emit({"type": "track"})  # must not raise: the track is already on disk
    emit({"type": "stats"})
    assert stop.is_set() and emit.closed
