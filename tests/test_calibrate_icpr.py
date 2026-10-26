import json

import pytest

from scripts.calibrate_icpr import find_tracks, report, run, wilson


def track(folder, plate="ABC1D23"):
    folder.mkdir(parents=True)
    (folder / "annotations.json").write_text(json.dumps({"plate_layout": "Brazilian", "plate_text": plate}))
    return folder


def row(name, plate, machine, confidence, width=45):
    return dict(track=name, plate_text=plate, crop_width=width, crop_height=16,
                machine_text=machine, confidence=confidence, latency_ms=5.0)


def test_wilson_interval_matches_the_textbook_values():
    low, high = wilson(9, 10)
    assert low == pytest.approx(0.5958, abs=1e-4)
    assert high == pytest.approx(0.9821, abs=1e-4)
    assert wilson(0, 0) == (None, None)
    assert wilson(5, 5)[1] == pytest.approx(1.0)


def test_tracks_come_from_test_or_from_the_validation_list(tmp_path):
    track(tmp_path / "test" / "track_2", "DEF5678")
    track(tmp_path / "test" / "track_1")
    track(tmp_path / "train" / "Scenario-A" / "Brazilian" / "track_7")
    track(tmp_path / "train" / "Scenario-B" / "Mercosur" / "track_8")
    assert [(t, p) for t, _, p in find_tracks(tmp_path, "test", None)] == [("track_1", "ABC1D23"),
                                                                          ("track_2", "DEF5678")]
    val = tmp_path / "val_tracks.txt"
    val.write_text(json.dumps(["track_8"]))
    assert [t for t, _, _ in find_tracks(tmp_path, "validation", val)] == ["track_8"]
    val.write_text(json.dumps(["track_8", "track_9"]))
    with pytest.raises(ValueError, match="missing"):
        find_tracks(tmp_path, "validation", val)


def test_report_marks_readable_by_threshold_and_adds_intervals():
    rows = [row("a", "ABC1234", "ABC1234", 0.99), row("b", "ABC1235", "ABC1236", 0.90),
            row("c", "ABC1237", "ABC1237", 0.80, width=55), row("d", "ABC1238", None, 0.40)]
    result = report(rows, "test", [0.95])
    at = {r["threshold"]: r for r in result["thresholds"]}
    assert (at[0.85]["readable"], at[0.85]["correct"]) == (2, 1)
    assert (at[0.95]["readable"], at[0.95]["correct"]) == (1, 1)
    assert at[0.95]["precision_low"] == pytest.approx(wilson(1, 1)[0])
    assert at[0.5]["coverage"] == 0.75
    assert result["recommended"]["0.95"] == {"threshold": 0.91, "conservative_threshold": None}
    assert result["by_crop_width"]["40-49"]["tracks"] == 3
    assert result["recognition"]["end_to_end"]["exact_accuracy"] == 0.5


def test_saved_readings_are_rescored_without_the_model(tmp_path, capsys):
    rows = [row(f"t{i}", "ABC1234", "ABC1234", 0.99) for i in range(80)] + [row("x", "ABC1234", "ABC9999", 0.6)]
    readings = tmp_path / "readings.json"
    readings.write_text(json.dumps({"pipeline": {"version": "test"}, "rows": rows}))
    out = tmp_path / "out"
    assert run(["--dataset", str(tmp_path), "--readings", str(readings), "--out", str(out)]) == 0
    summary = json.loads(capsys.readouterr().out)
    assert summary["recommended"]["0.95"] == {"threshold": 0.5, "conservative_threshold": 0.61}
    assert json.loads((out / "predictions.json").read_text())["predictions"][0]["confidence"] == 0.99
    assert not (out / "readings.json").exists()
