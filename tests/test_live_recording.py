"""Rolling recording and track clips of live sessions (real ffmpeg on small synthetic videos)."""
from datetime import datetime, timedelta, timezone
import json
import subprocess
import threading
import time
from pathlib import Path

import cv2
import pytest

from app.live.clips import NotRecorded, cut, file_entry, keyframes, plan, read_index
from app.live.recorder import ClipMaker, Recorder
from app.live.source import FfmpegFrames, SourceError


def ffmpeg():
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def h264(path, seconds=25, gop=20, fps=10):
    """A test pattern with a keyframe every gop frames (2 s at 10 fps)."""
    subprocess.run([ffmpeg(), "-hide_banner", "-loglevel", "error", "-f", "lavfi",
                    "-i", f"testsrc=size=320x240:rate={fps}", "-t", str(seconds), "-c:v", "libx264",
                    "-g", str(gop), "-keyint_min", str(gop), "-sc_threshold", "0", "-pix_fmt", "yuv420p",
                    "-y", str(path)], check=True)
    return path


BASE = datetime(2026, 10, 27, 12, tzinfo=timezone.utc)


def iso(seconds):
    return (BASE + timedelta(seconds=seconds)).isoformat().replace("+00:00", "Z")


def to_iso(start, end):
    return iso(start), iso(end)


def frames_of(path):
    capture = cv2.VideoCapture(str(path))
    count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    ok, _ = capture.read()
    capture.release()
    return count, ok


@pytest.fixture(scope="module")
def recording(tmp_path_factory):
    """16 s decoded through FfmpegFrames with recording on (paced at real time, so made once)."""
    tmp = tmp_path_factory.mktemp("recording")
    video = h264(tmp / "in.mp4", 16)
    folder = tmp / "record"
    source = FfmpegFrames(str(video), 320, 240, record_dir=folder)
    with pytest.raises(SourceError):  # end of a file looks like a dropped stream
        for _ in source:
            pass
    source.close()
    return folder


def copy_of(folder, tmp_path):
    import shutil
    return Path(shutil.copytree(folder, tmp_path / "record"))


def test_recording_is_a_second_stream_copy_output():
    command = FfmpegFrames("clip.mp4", 320, 180, ffmpeg="ffmpeg", record_dir=None).command
    assert "segment" not in command and "-nostdin" in command
    import tempfile
    with tempfile.TemporaryDirectory() as folder:
        command = FfmpegFrames("clip.mp4", 320, 180, ffmpeg="ffmpeg", record_dir=folder).command
    pipe = command.index("pipe:1")
    tail = command[pipe + 1:]
    assert tail[:4] == ["-map", "0:v:0", "-c", "copy"] and "segment" in tail and tail[-1].endswith("seg_%06d.mp4")
    assert "-nostdin" not in command, "close() quits a recording ffmpeg through stdin"


def test_stopping_mid_segment_still_closes_and_lists_the_last_segment(tmp_path):
    video = h264(tmp_path / "in.mp4", 30)
    folder = tmp_path / "record"
    source = FfmpegFrames(str(video), 320, 240, record_dir=folder)
    for pts, _ in source:
        if pts >= 12:  # 2 s into the second segment
            break
    source.close()
    recorder = Recorder(folder, to_iso, keep_minutes=60, now=lambda: BASE)
    recorder.scan()
    assert [e["file"] for e in recorder.entries] == ["seg_000000.mp4", "seg_000001.mp4"]
    assert recorder.covered >= 12
    count, ok = frames_of(folder / "seg_000001.mp4")
    assert ok and count >= 20


def test_recorder_indexes_closed_segments_with_wall_clock_and_keyframes(recording, tmp_path):
    folder = copy_of(recording, tmp_path)
    base = datetime(2026, 10, 27, 12, tzinfo=timezone.utc)
    iso = lambda s: (base + timedelta(seconds=s)).isoformat().replace("+00:00", "Z")  # noqa: E731
    recorder = Recorder(folder, lambda a, b: (iso(a), iso(b)), keep_minutes=60, now=lambda: base)
    recorder.scan()
    entries = [json.loads(line) for line in (folder / "index.jsonl").read_text().splitlines()]
    assert len(entries) >= 2 and entries[0]["pts_start"] == 0 and entries[-1]["pts_end"] == pytest.approx(16, abs=.3)
    assert entries[0]["utc_start"] == iso(0) and entries[0]["keyframes"][0] == 0
    assert all(abs(k - round(k / 2) * 2) < .05 for k in entries[0]["keyframes"]), "keyframes every 2 s"
    assert recorder.covered == entries[-1]["pts_end"]
    # Hours later every segment is older than keep_minutes and is deleted.
    later = Recorder(folder, lambda a, b: (iso(a), iso(b)), keep_minutes=60, now=lambda: base + timedelta(hours=2))
    later.scan()
    assert not list(folder.glob("seg_*.mp4")) and (folder / "index.jsonl").read_text() == ""


def test_clips_start_on_the_keyframe_before_and_say_where_the_moment_is(recording, tmp_path):
    folder = copy_of(recording, tmp_path)
    recorder = Recorder(folder, to_iso, now=lambda: BASE)
    recorder.scan()
    entries = read_index([folder / "index.jsonl"])
    segments, ss, to, offset = plan(entries, 9.0, 14.0)
    assert ss == pytest.approx(8.0, abs=.05) and offset == pytest.approx(1.0, abs=.05)
    info = cut(entries, 9.0, 14.0, tmp_path / "clip.mp4")
    count, ok = frames_of(tmp_path / "clip.mp4")
    assert ok and count == pytest.approx(60, abs=2), "8 s to 14 s at 10 fps"
    assert info["first_seen_offset"] == pytest.approx(1.0, abs=.05)
    with pytest.raises(NotRecorded):
        plan(entries, 100, 110)
    with pytest.raises(ValueError):
        plan(entries, 5, 5)


def test_a_demo_video_is_cut_from_the_file_even_after_it_looped(tmp_path):
    video = h264(tmp_path / "demo.mp4", 20)
    events = []
    maker = ClipMaker(tmp_path / "out", events.append, pad=2, video=(video, 20.0), interval=.05)
    maker.request("e000-t000001", 20 + 10, 20 + 12)  # second pass: file time 10-12 s
    maker.finish()
    clip = next(e for e in events if e["type"] == "clip")
    assert clip["path"] == "clips/e000-t000001.mp4" and (tmp_path / "out" / clip["path"]).is_file()
    count, ok = frames_of(tmp_path / "out" / clip["path"])
    assert ok and count == pytest.approx(60, abs=2), "8 s (keyframe) to 14 s"
    assert clip["first_seen_offset"] == pytest.approx(2.0, abs=.05)
    assert keyframes(video)[1][:3] == [0, 2, 4]
    assert file_entry(video, 20.0)["pts_end"] == 20.0


def test_any_demo_track_can_be_cut_on_demand_from_the_command_line(tmp_path, capsys):
    from app.live.clips import main
    video = h264(tmp_path / "demo.mp4", 20)
    out = tmp_path / "cache" / "job.mp4"
    out.parent.mkdir()
    # Third pass of the loop: PTS 51-52 plays file time 11-12 s; padded 9-14 s, starting at keyframe 8 s.
    assert main(["--video", str(video), "--pts-from", "51", "--pts-to", "52", "--pad", "2", "--out", str(out)]) == 0
    info = json.loads(capsys.readouterr().out)
    count, ok = frames_of(out)
    assert ok and count == pytest.approx(60, abs=2), "8 s (keyframe) to 14 s"
    assert info["first_seen_offset"] == pytest.approx(3.0, abs=.05)
    assert main(["--video", str(tmp_path / "missing.mp4"), "--pts-from", "1", "--pts-to", "2",
                 "--out", str(out)]) == 2


def test_clips_wait_until_the_recording_covers_the_track(recording, tmp_path):
    folder = copy_of(recording, tmp_path)

    class Partial:
        covered = 5.0

        def __init__(self, entries):
            self.entries = entries

        def snapshot(self):
            return self.entries

    recorder = Recorder(folder, to_iso, now=lambda: BASE)
    recorder.scan()
    partial = Partial(recorder.snapshot())
    events = []
    maker = ClipMaker(tmp_path / "out", events.append, pad=1, recorder=partial, interval=.05)
    maker.request("t1", 10, 12)
    maker.request("t1", 10, 12)  # asked twice (policy and alert): one clip
    time.sleep(.3)
    assert not events, "the end of the track is not recorded yet"
    partial.covered = 20.0
    deadline = time.monotonic() + 10
    while not events and time.monotonic() < deadline:
        time.sleep(.05)
    maker.request("t2", 100, 101)  # beyond the recording: finish gives up silently
    maker.finish(timeout=10)
    assert [e["track"] for e in events if e["type"] == "clip"] == ["t1"]
    assert not [e for e in events if e["type"] == "clip_failed"]


def test_recording_options_come_from_the_environment():
    from app.live.__main__ import recording_options
    assert recording_options({}) == {"minutes": 240.0, "clip_policy": "readable", "pad": 3.0}
    assert recording_options({"PLATE_LIVE_RECORD": "false"}) is None
    assert recording_options({"PLATE_LIVE_CLIP_POLICY": "all", "PLATE_LIVE_RECORD_MINUTES": "30"})["minutes"] == 30
    for bad in ({"PLATE_LIVE_CLIP_POLICY": "some"}, {"PLATE_LIVE_RECORD_MINUTES": "0"}):
        with pytest.raises(ValueError):
            recording_options(bad)


def test_runner_clips_readable_tracks_of_a_demo_video_and_on_request(tmp_path):
    from test_live import SNAPSHOT, recognizer
    from test_ml_adapter import BoxFixture
    from app.live.runner import LiveRunner
    from app.live.source import FileFrames
    video = h264(tmp_path / "input.mp4", 3)
    events, opened = [], []

    def open_source(record_dir=None):
        opened.append(record_dir)
        return dict(width=320, height=240, fps=10., video_id="synthetic", duration=3.0), FileFrames(video)

    runner = LiveRunner(SNAPSHOT, tmp_path / "live", open_source, events.append, BoxFixture(), recognizer,
                        recording=dict(minutes=60, clip_policy="readable", pad=0))
    assert runner.run(threading.Event()) == "ended"
    tracks = [e for e in events if e["type"] == "track"]
    assert tracks and opened and opened[0].name == "e000"
    clips = [e for e in events if e["type"] == "clip"]
    assert [c["track"] for c in clips] == [t["track"] for t in tracks if t["status"] == "readable"]
    assert all((tmp_path / "live" / c["path"]).is_file() for c in clips)
    off = LiveRunner(SNAPSHOT, tmp_path / "off", lambda: (dict(width=320, height=240, fps=10.), FileFrames(video)),
                     [].append, BoxFixture(), recognizer)
    assert off.run(threading.Event()) == "ended" and not (tmp_path / "off" / "clips").exists()


def test_a_first_segment_listed_from_zero_starts_at_its_keyframe(recording, tmp_path):
    folder = copy_of(recording, tmp_path)
    lines = (folder / "segments.csv").read_text().splitlines()
    name, start, end = lines[1].split(",")
    (folder / "segments.csv").write_text(f"{name},0.000000,{end}\n")  # as ffmpeg lists HLS with -copyts
    recorder = Recorder(folder, to_iso, now=lambda: BASE)
    recorder.scan()
    assert recorder.snapshot()[0]["pts_start"] == pytest.approx(float(start), abs=.3)
