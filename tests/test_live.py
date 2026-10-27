"""Live process protocol: synthetic sources and boxes, never network or model accuracy."""
import itertools
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
            "greedy_symbol_confidence": .7, "beam_log_score": -1., "beam_confidence_proxy": .97}}


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


def test_looped_file_replays_with_increasing_timestamps(tmp_path):
    video = tmp_path / "input.avi"
    _plate_video(video, 10)
    frames = FileFrames(video, loop=True)
    assert not frames.finite
    pts = [p for p, *_ in itertools.islice(iter(frames), 25)]
    frames.close()
    steps = np.diff(pts)
    assert len(pts) == 25 and steps.min() > 0
    assert steps == pytest.approx([steps[0]] * len(steps))  # no jump or gap at the wrap


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


def test_sampling_scale_lowers_detector_rates_and_is_recorded(tmp_path):
    video = tmp_path / "input.avi"
    _plate_video(video, 30)
    status, events = run(tmp_path, [FileFrames(video)], sampling_scale=.5)
    assert status == "ended"
    record = json.loads((tmp_path / "live" / next(e for e in events if e["type"] == "track")["path"])
                        .read_text(encoding="utf-8"))
    assert record["sampling_scale"] == .5
    assert all(e["sampling_scale"] == .5 for e in events if e["type"] == "stats")
    runner = LiveRunner(SNAPSHOT, tmp_path / "x", None, print, BoxFixture(), recognizer, sampling_scale=.5)
    assert runner.tracking_snapshot["sampling"]["high_fps"] == SNAPSHOT["sampling"]["high_fps"] * .5
    assert runner.snapshot is SNAPSHOT, "the pinned snapshot itself is unchanged"
    with pytest.raises(ValueError):
        LiveRunner(SNAPSHOT, tmp_path / "x", None, print, BoxFixture(), recognizer, sampling_scale=0)


def test_exclude_zones_drop_detections_centred_inside_only():
    from app.recognition.video_tracking import detect_plates
    images = [np.zeros((180, 320, 3), np.uint8)]
    cfg = {"device": "cpu", "imgsz": 320}
    assert len(detect_plates(BoxFixture(), images, cfg)[0]) == 1  # box centre (0.28, 0.31)
    assert len(detect_plates(BoxFixture(), images, {**cfg, "exclude_zones": [[.5, .5, 1, 1]]})[0]) == 1
    assert len(detect_plates(BoxFixture(), images, {**cfg, "exclude_zones": [[.5, .5, 1, 1], [.2, .2, .4, .4]]})[0]) == 0


class SizeRecorder(BoxFixture):
    def __init__(self):
        self.sizes = []

    def predict(self, images, **kwargs):
        self.sizes.append(len(images))
        return super().predict(images, **kwargs)


def test_cuda_batches_are_padded_to_a_few_sizes_and_trimmed_back():
    from app.recognition.video_tracking import detect_plates, detector_batch_sizes
    assert detector_batch_sizes(16) == [1, 4, 16] and detector_batch_sizes(4) == [1, 4]
    assert detector_batch_sizes(1) == [1]
    model, image = SizeRecorder(), np.zeros((180, 320, 3), np.uint8)
    cfg = {"device": "cuda", "imgsz": 320, "batch": 16}
    for count in (1, 2, 4, 5, 16):
        assert len(detect_plates(model, [image] * count, cfg)) == count
    assert model.sizes == [1, 4, 4, 16, 16]
    detect_plates(model, [image] * 3, {**cfg, "device": "cpu"})
    assert model.sizes[-1] == 3, "CPU batches are never padded"


def test_warm_up_runs_each_batch_size_once_per_frame_shape(tmp_path):
    model, ocr_calls = SizeRecorder(), []
    model.warmed = set()  # a shared model (app/live/host.GpuModel) carries this set

    def ocr(images):
        ocr_calls.append(len(images))
        return recognizer(images)

    cfg = {"width": 320, "height": 180, "batch": 16, "imgsz": 320, "device": "cuda"}
    first = LiveRunner(SNAPSHOT, tmp_path / "a", None, print, model, ocr)
    first._warm_up(cfg)
    assert model.sizes == [1, 4, 16] and ocr_calls == [5]
    first._warm_up(cfg)
    LiveRunner(SNAPSHOT, tmp_path / "b", None, print, model, ocr)._warm_up(cfg)
    assert model.sizes == [1, 4, 16], "another session on the shared model skips warm-up"
    LiveRunner(SNAPSHOT, tmp_path / "c", None, print, model, ocr)._warm_up({**cfg, "width": 640, "height": 360})
    assert model.sizes[3:] == [1, 4, 16], "a new frame shape is warmed up again"


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


class FakeClock:
    def __init__(self):
        self.now, self.slept = 100.0, []

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.slept.append(seconds)
        self.now += seconds


def test_pacer_releases_native_rate_bounds_catch_up_and_skips_long_backlogs():
    from app.live.source import Pacer
    clock = FakeClock()
    pacer = Pacer(catchup=1.25, max_lag=10, clock=clock, sleep=clock.sleep)
    for i in range(10):  # a burst of buffered frames is spread out at native rate (10 fps)
        assert pacer.admit(i / 10, waited=0)
    assert clock.now == pytest.approx(100.9)
    clock.now += 5  # a 5 s stall, then 5 s of backlog arrives at once
    started = clock.now
    for i in range(10, 160):
        assert pacer.admit(i / 10, waited=0)
    assert clock.now - started == pytest.approx(15 / 1.25, abs=0.2), "caught up at 1.25x, not as a burst"
    assert pacer.lag < 3
    clock.now += 30  # long stall with a full backlog: one buffered stretch is skipped
    admitted = [pacer.admit(16 + i / 10, waited=0) for i in range(300)]
    assert not all(admitted) and pacer.skipped > 0 and pacer.skipped_seconds > 15
    assert admitted.index(False) == 0 and all(admitted[admitted.index(True):]), "skipped in one piece"


def test_pacer_restarts_when_the_source_itself_is_slow_or_jumps_ahead():
    from app.live.source import Pacer
    clock = FakeClock()
    pacer = Pacer(max_lag=10, clock=clock, sleep=clock.sleep)
    pacer.admit(0.0, waited=0)
    clock.now += 30  # the network delivered nothing for 30 s: nothing to catch up from
    assert pacer.admit(0.1, waited=30) and pacer.lag == 0 and pacer.skipped == 0
    assert pacer.admit(60.0, waited=0)
    assert max(clock.slept, default=0) < 1, "no 60 s sleep after a forward jump"


def test_hls_playlist_anchors_the_broadcast_clock():
    from datetime import datetime, timezone
    from app.live.source import FfmpegFrames, OPENING, parse_playlist, segment_start
    text = ("#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXT-X-MEDIA-SEQUENCE:501437\n"
            "#EXT-X-PROGRAM-DATE-TIME:2026-10-24T11:40:15.850+00:00\n#EXTINF:5.0,\nhttps://a/sq/501437/x\n"
            "#EXTINF:4.0,\nhttps://a/sq/501438/x\n")
    playlist = parse_playlist(text)
    start = datetime(2026, 10, 24, 11, 40, 15, 850000, tzinfo=timezone.utc)
    assert segment_start(playlist, 501437) == start
    assert (segment_start(playlist, 501439) - start).total_seconds() == 9.0
    assert (segment_start(playlist, 501441) - start).total_seconds() == 19.0  # extrapolated by target
    assert segment_start(playlist, 501400) is None and parse_playlist("#EXTM3U") is None
    line = b"[hls @ 0x1] Opening 'https://rr4.googlevideo.com/videoplayback/id/x.22/sq/501438/goap/y' for reading"
    assert OPENING.search(line).group(1) == b"501438"
    source = FfmpegFrames("https://manifest/x.m3u8", 320, 180, ffmpeg="ffmpeg", fetch=lambda url: text)
    assert "-re" in source.command and "-copyts" in source.command
    assert source.command[source.command.index("-live_start_index") + 1] == "-1"
    assert "-live_start_index" not in FfmpegFrames("clip.mp4", 320, 180, ffmpeg="ffmpeg").command
    assert source.stream_time(23527.34) is None
    source.first_pts = 23527.34
    source._anchor(501438)
    assert (source.stream_time(23529.34) - start).total_seconds() == pytest.approx(7.0)


def test_capture_times_prefer_a_plausible_broadcast_clock():
    from datetime import datetime, timedelta, timezone
    from app.live.runner import capture_times
    received = datetime(2026, 10, 24, 12, 0, 0, tzinfo=timezone.utc)
    clock = dict(started_at=received, first_pts=100.0, stream_time=None)
    assert capture_times(clock, 102.0, 104.0) == ("received", "2026-10-24T12:00:02.000Z", "2026-10-24T12:00:04.000Z")
    broadcast = received - timedelta(seconds=20)  # YouTube runs ~20 s behind
    clock["stream_time"] = lambda pts: broadcast + timedelta(seconds=pts - 100.0)
    assert capture_times(clock, 102.0, 104.0) == ("stream", "2026-10-24T11:59:42.000Z", "2026-10-24T11:59:44.000Z")
    clock["stream_time"] = lambda pts: received + timedelta(hours=3)  # implausible anchor: ignored
    assert capture_times(clock, 102.0, 104.0)[0] == "received"
    clock["stream_time"] = lambda pts: None
    assert capture_times(clock, 102.0, 104.0)[0] == "received"


def test_resolve_youtube_caps_the_video_height():
    class Ydl:
        options = None

        def __init__(self, options):
            Ydl.options = options

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def extract_info(self, url, download):
            return dict(live_status="is_live", url="https://m/x.m3u8", width=1280, height=720, fps=30, id="v")

    assert resolve_youtube("https://youtu.be/x", Ydl, max_height=720)["height"] == 720
    assert Ydl.options["format"] == "bv*[height<=720]"


def test_ffmpeg_decode_options_go_before_the_input_and_skip_showinfo_checksums():
    from app.live.__main__ import decode_options
    plain = FfmpegFrames("clip.mp4", 320, 180, ffmpeg="ffmpeg").command
    assert "showinfo=checksum=0" in plain and "-hwaccel" not in plain and "-threads" not in plain
    command = FfmpegFrames("clip.mp4", 320, 180, ffmpeg="ffmpeg", hwaccel="cuda", threads=2).command
    i = command.index("-i")
    assert command[command.index("-hwaccel") + 1] == "cuda" and command.index("-hwaccel") < i
    assert command[command.index("-threads") + 1] == "2" and command.index("-threads") < i
    assert decode_options({}) == {"hwaccel": None, "threads": None}
    assert decode_options({"PLATE_LIVE_HWACCEL": "CUDA", "PLATE_LIVE_FFMPEG_THREADS": "4"}) == {"hwaccel": "cuda", "threads": 4}
    for bad in ({"PLATE_LIVE_HWACCEL": "vaapi"}, {"PLATE_LIVE_FFMPEG_THREADS": "99"}):
        with pytest.raises(ValueError):
            decode_options(bad)


def test_live_reader_reuses_a_gray_frame_the_source_already_made(tmp_path):
    image = np.full((180, 320, 3), 90, np.uint8)
    marker = np.zeros((180, 320), np.uint8)
    reader = LiveReader(Frames([(0., image, marker), (.1, image)], finite=True), capacity=4).start()
    first, second = reader.get(1), reader.get(1)
    assert first[3] is marker, "a provided small gray is used as is"
    assert second[3].shape == (180, 320) and second[3].mean() > 0, "otherwise it is computed"
    reader.stop()

def test_rtsp_command_is_live_tcp_wallclock_and_scaled_before_showinfo():
    from app.live.source import RtspFrames
    command = RtspFrames("rtsp://cam/stream", max_height=720, ffmpeg="ffmpeg").command
    assert "-re" not in command and "-rw_timeout" not in command
    i = command.index("-i")
    for flag, value in (("-rtsp_transport", "tcp"), ("-use_wallclock_as_timestamps", "1")):
        assert command[command.index(flag) + 1] == value and command.index(flag) < i
    assert command[command.index("-timeout") + 1] == str(15 * 10**6)
    vf = command[command.index("-vf") + 1]
    assert vf.startswith("scale=-2:'min(ih,720)',") and vf.split(",")[-1].startswith("showinfo"), "showinfo stays last"


def test_rtsp_header_gives_the_scaled_frame_size_and_a_sane_fps():
    from app.live.source import RtspFrames
    frames = RtspFrames("rtsp://cam/stream", ffmpeg="ffmpeg")
    frames._other_line(b"  Stream #0:0: Video: h264 (High), yuvj420p(pc, bt709, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 90000 fps, 25 tbr")
    frames._other_line(b"  Stream #0:0: Video: rawvideo (BGR[24] / 0x18524742), bgr24(pc, progressive), 1280x720, q=2-31")

    class Running:
        def poll(self):
            return None

    frames.process = Running()  # already "started": probe only reads the parsed header
    info = frames.probe(timeout=1)
    assert info == {"width": 1280, "height": 720, "fps": 25.0, "video_id": "rtsp"}
    assert frames.shape == (720, 1280, 3) and frames.size == 1280 * 720 * 3


def test_rtsp_refusal_ends_the_session_and_never_leaks_the_password():
    import sys as _sys
    from app.live.source import RtspFrames, redact_url
    assert redact_url("rtsp://admin:s3cr%40t@10.0.0.5:554/h264 failed") == "rtsp://admin:***@10.0.0.5:554/h264 failed"
    assert redact_url("rtsp://10.0.0.5/live") == "rtsp://10.0.0.5/live"
    url = "rtsp://admin:hunter2@127.0.0.1:9/cam"
    refused = RtspFrames(url, ffmpeg="ffmpeg")
    refused.command = [_sys.executable, "-c", "import sys; sys.stderr.write("
                       f"'[rtsp @ 0] method DESCRIBE failed: 401 Unauthorized {url}\n')"]
    with pytest.raises(StreamEnded) as ended:
        refused.probe(timeout=10)
    assert "401" in str(ended.value) and "hunter2" not in str(ended.value)
    down = RtspFrames(url, ffmpeg="ffmpeg")
    down.command = [_sys.executable, "-c", f"import sys; sys.stderr.write('Connection to {url} failed: Error number -138\n')"]
    with pytest.raises(SourceError) as error:
        down.probe(timeout=10)
    assert "hunter2" not in str(error.value) and "***" in str(error.value)


def test_rtsp_not_found_is_retried_like_an_outage():
    import sys as _sys
    from app.live.source import RtspFrames
    restarting = RtspFrames("rtsp://admin:hunter2@127.0.0.1:9/cam", ffmpeg="ffmpeg")
    restarting.command = [_sys.executable, "-c", "import sys; sys.stderr.write('Server returned 404 Not Found\n')"]
    with pytest.raises(SourceError):
        restarting.probe(timeout=10)
