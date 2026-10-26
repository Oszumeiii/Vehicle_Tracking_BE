"""Shared live host: session routing, isolation and model sharing with fake runners."""
import json
import threading
import time

import pytest

from app.live.host import GpuModel, Host, SharedModels

SNAPSHOT = {"id": "joint", "version": "1", "device": "cuda", "detector": {"sha256": "a"},
            "recognizer": {"input_mode": "five_frame_joint"}}


class Collect:
    def __init__(self, stop_all):
        self.events, self.lock = [], threading.Lock()

    def __call__(self, event):
        with self.lock:
            self.events.append(event)

    def of(self, session, kind=None):
        with self.lock:
            return [e for e in self.events if e.get("session") == session and (kind is None or e["type"] == kind)]


class FakeRunner:
    """Emits running and stats until stopped; a source named "boom" fails mid-run."""

    def __init__(self, snapshot, out, open_source, emit, model, recognizer, **kwargs):
        self.source, self.emit, self.kwargs, self.model = open_source, emit, kwargs, model

    def run(self, stop):
        self.emit(dict(type="status", status="running"))
        self.model.predict("frame")
        while not stop.wait(.01):
            self.emit(dict(type="stats", sampling_scale=self.kwargs["sampling_scale"]))
            if self.source == "boom":
                raise RuntimeError("decoder crashed")
        self.emit(dict(type="status", status="stopped"))
        return "stopped"


class FakeModel:
    names = {0: "plate"}

    def __init__(self):
        self.active, self.overlap, self.threads = 0, False, set()

    def predict(self, *_):
        self.threads.add(threading.current_thread().name)
        self.active += 1
        self.overlap |= self.active > 1
        time.sleep(.005)
        self.active -= 1


def make_host(tmp_path, load=None, **kwargs):
    model = FakeModel()
    loads = []

    def default_load(snapshot):
        loads.append(snapshot["id"])
        return model, lambda images: ["text"] * len(images)

    host = Host(tmp_path, SharedModels(load or default_load), Collect, source_factory=lambda source: source["name"],
                runner_factory=FakeRunner, **kwargs)
    return host, model, loads


def payload(tmp_path, name, snapshot=SNAPSHOT):
    file = tmp_path / f"{name}.json"
    file.write_text(json.dumps({"pipeline_snapshot": snapshot, "source": {"name": name}}))
    return str(file)


def start(host, tmp_path, session, name, snapshot=SNAPSHOT):
    host.command(dict(cmd="start", session=session, payload=payload(tmp_path, name, snapshot),
                      out=str(tmp_path / "live" / session), min_confidence=.9, max_track_seconds=20))


def wait(predicate, timeout=5):
    deadline = time.monotonic() + timeout
    while not predicate():
        assert time.monotonic() < deadline, "timed out"
        time.sleep(.01)


def test_sessions_share_one_model_load_and_stop_independently(tmp_path):
    host, model, loads = make_host(tmp_path, sampling_scale=.5)
    start(host, tmp_path, "a", "camboriu")
    start(host, tmp_path, "b", "itajai")
    events = host.emit
    wait(lambda: events.of("a", "stats") and events.of("b", "stats"))
    assert loads == ["joint"], "models load once for every session"
    assert events.of("a", "stats")[0]["sampling_scale"] == .5
    host.command(dict(cmd="stop", session="a"))
    wait(lambda: events.of("a", "exit"))
    assert events.of("a", "exit")[0]["code"] == 0
    count = len(events.of("b", "stats"))
    wait(lambda: len(events.of("b", "stats")) > count + 3)
    assert not events.of("b", "exit"), "the other session keeps running"
    assert not model.overlap, "model calls never overlap"
    assert len(model.threads) == 1 and model.threads.pop().startswith("live-gpu"),         "every session's model calls run on the one GPU thread, so CUDA warm-up is shared"
    host.serve(iter([]))  # EOF: stop the rest and wait
    assert events.of("b", "exit")[0]["code"] == 0
    assert events.events[-1] == {"type": "host", "status": "stopped"}


def test_a_failing_session_does_not_stop_the_others(tmp_path):
    host, _, _ = make_host(tmp_path)
    start(host, tmp_path, "ok", "camboriu")
    start(host, tmp_path, "bad", "boom")
    events = host.emit
    wait(lambda: events.of("bad", "exit"))
    assert [e["code"] for e in events.of("bad", "error")] == ["PIPELINE_FAILED"]
    assert events.of("bad", "status")[-1] == {"type": "status", "status": "failed", "reason": "decoder crashed",
                                              "session": "bad"}
    assert events.of("bad", "exit")[0]["code"] == 1
    count = len(events.of("ok", "stats"))
    wait(lambda: len(events.of("ok", "stats")) > count + 3)
    host.serve(iter(['{"cmd": "shutdown"}']))
    assert events.of("ok", "exit")[0]["code"] == 0


def test_startup_errors_and_another_pipeline_are_reported_per_session(tmp_path):
    def broken(_snapshot):
        error = RuntimeError("checkpoint missing")
        error.code = "CHECKPOINT_MISSING"
        raise error

    host, _, _ = make_host(tmp_path, load=broken)
    start(host, tmp_path, "a", "camboriu")
    events = host.emit
    wait(lambda: events.of("a", "exit"))
    assert events.of("a", "error")[0]["code"] == "CHECKPOINT_MISSING"
    assert events.of("a", "status")[0]["reason"] == "startup"

    host, _, _ = make_host(tmp_path)
    start(host, tmp_path, "a", "camboriu")
    start(host, tmp_path, "b", "other", {**SNAPSHOT, "id": "other"})
    events = host.emit
    wait(lambda: events.of("b", "exit"))
    assert "another pipeline" in events.of("b", "error")[0]["message"]
    # Outside the data directory is refused before any model work.
    host.command(dict(cmd="start", session="c", payload=payload(tmp_path, "x"), out=str(tmp_path.parent / "elsewhere")))
    wait(lambda: events.of("c", "exit"))
    assert "inside the host data directory" in events.of("c", "error")[0]["message"]
    # ".." is normalized before the check, so it cannot climb out of the data directory.
    host.command(dict(cmd="start", session="d", payload=payload(tmp_path, "x"),
                      out=str(tmp_path / "live" / ".." / ".." / "elsewhere")))
    wait(lambda: events.of("d", "exit"))
    assert "inside the host data directory" in events.of("d", "error")[0]["message"]
    host.serve(iter(["not json", '{"cmd": "stop"}']))
    assert [e["status"] for e in events.events if e["type"] == "host"] == ["ready", "error", "error", "stopped"]


def test_sampling_scale_is_validated_and_gpu_model_keeps_names():
    models = SharedModels(lambda s: (FakeModel(), lambda images: images))
    model, recognize = models.get(SNAPSHOT)
    assert isinstance(model, GpuModel) and model.names == {0: "plate"} and model.warmed == set()
    assert recognize(["crop"]) == ["crop"]
    with pytest.raises(ValueError):
        Host(".", SharedModels(lambda s: None), Collect, sampling_scale=0, source_factory=str, runner_factory=FakeRunner)
