"""Calibrate the live readable threshold on labelled ICPR 2026 LRLPR tracks:
python -m scripts.calibrate_icpr --help

Runs the joint OCR model of a live pipeline snapshot (same checkpoint, decoder and
confidence as app/live/runner.py) on the five low-resolution frames of each track,
then reports precision/coverage per threshold with Wilson 95% intervals.
Dataset: Kaggle trnvnhun/icpr-2026-low-resolution-plate-dataset; validation list:
trnvnhun/split-data val_tracks.txt (docs/EVALUATION.md).
"""

import argparse
import json
import math
from pathlib import Path
import sys

from app.evaluation import calibrate_threshold, evaluate_recognition, normalize_plate

SPLITS = ("test", "validation")
WIDTH_GROUPS = ((0, 40, "<40"), (40, 50, "40-49"), (50, 60, "50-59"), (60, math.inf, ">=60"))


def wilson(successes: int, total: int, z: float = 1.96) -> tuple[float | None, float | None]:
    """Wilson score interval of a binomial proportion; (None, None) when total is 0."""
    if total == 0:
        return None, None
    p = successes / total
    centre = p + z * z / (2 * total)
    margin = z * math.sqrt(p * (1 - p) / total + z * z / (4 * total * total))
    scale = 1 + z * z / total
    return (centre - margin) / scale, (centre + margin) / scale


def find_tracks(root: Path, split: str, val_list: Path | None) -> list[tuple[str, Path, str]]:
    """(track id, folder, plate text) of the labelled tracks of a split, sorted by id."""
    if split == "test":
        folders = [folder for folder in (root / "test").iterdir() if folder.is_dir()]
    else:
        if val_list is None:
            raise ValueError("--val-list is required for the validation split")
        wanted = set(json.loads(val_list.read_text(encoding="utf-8-sig")))
        folders = [folder for folder in (root / "train").glob("*/*/track_*") if folder.name in wanted]
        missing = wanted - {folder.name for folder in folders}
        if missing:
            raise ValueError(f"{len(missing)} validation tracks are missing, e.g. {sorted(missing)[0]}")
    tracks = []
    for folder in sorted(folders, key=lambda f: f.name):
        plate = json.loads((folder / "annotations.json").read_text(encoding="utf-8-sig")).get("plate_text")
        if not isinstance(plate, str) or not normalize_plate(plate):
            raise ValueError(f"{folder.name} has no plate_text")
        tracks.append((folder.name, folder, plate))
    return tracks


def recognize_tracks(tracks, recognizer, root: Path, log=lambda message: None) -> list[dict]:
    """One machine reading per track, from its five lr-*.jpg frames in order."""
    from PIL import Image

    from app.live.runner import plate_confidence
    from app.recognition.runner import _predict_joint

    rows = []
    for index, (track, folder, plate) in enumerate(tracks, 1):
        frames = sorted(folder.glob("lr-*.jpg"))
        with Image.open(frames[2]) as middle:
            width, height = middle.size
        prediction = _predict_joint(recognizer, frames, root)
        rows.append(dict(track=track, plate_text=plate, crop_width=width, crop_height=height,
                         machine_text=prediction["normalized_text"] or None,
                         confidence=plate_confidence(prediction), latency_ms=prediction["latency_ms"]))
        if index % 250 == 0:
            log(f"{index}/{len(tracks)} tracks")
    return rows


def evaluation_files(rows: list[dict], split: str) -> tuple[dict, dict, dict]:
    """Ground truth plus predictions for calibrate_threshold and for evaluate_recognition."""
    truth = {"samples": [dict(sample_id=row["track"], source_id=row["track"], plate_text=row["plate_text"],
                              split=split, crop_width=row["crop_width"], crop_height=row["crop_height"])
                         for row in rows]}
    calibration = {"predictions": [dict(sample_id=row["track"], plate_text=row["machine_text"],
                                        confidence=row["confidence"]) for row in rows]}
    recognition = {"predictions": [dict(sample_id=row["track"], variant="five_image", detected=True,
                                        plate_text=row["machine_text"], latency_ms=row["latency_ms"])
                                   for row in rows]}
    return truth, calibration, recognition


def report(rows: list[dict], split: str, targets: list[float]) -> dict:
    truth, calibration, recognition = evaluation_files(rows, split)
    curve = calibrate_threshold(truth, calibration, target_precision=targets[0])
    for row in curve["thresholds"]:
        row["precision_low"], row["precision_high"] = wilson(row["correct"], row["readable"])
    recommended = {}
    for target in targets:
        reaching = [row["threshold"] for row in curve["thresholds"]
                    if row["precision"] is not None and row["precision"] >= target]
        lower_bound = [row["threshold"] for row in curve["thresholds"]
                       if row["precision_low"] is not None and row["precision_low"] >= target]
        recommended[str(target)] = dict(threshold=min(reaching, default=None),
                                        conservative_threshold=min(lower_bound, default=None))
    by_width = {}
    for low, high, name in WIDTH_GROUPS:
        group = [row for row in rows if low <= row["crop_width"] < high]
        if group:
            correct = sum(row["machine_text"] == normalize_plate(row["plate_text"]) for row in group)
            by_width[name] = dict(tracks=len(group), exact_accuracy=correct / len(group),
                                  mean_confidence=sum(row["confidence"] or 0 for row in group) / len(group))
    five = evaluate_recognition(truth, recognition, split=split)["variants"]["five_image"]
    return dict(split=split, tracks=len(rows), recognition=five, by_crop_width=by_width,
                recommended=recommended, thresholds=curve["thresholds"])


def run(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Precision/coverage of the live readable status on ICPR tracks.")
    parser.add_argument("--dataset", type=Path, required=True, help="Folder holding train/ and test/")
    parser.add_argument("--split", choices=SPLITS, default="test")
    parser.add_argument("--val-list", type=Path, help="val_tracks.txt (validation split only)")
    parser.add_argument("--payload", type=Path, help="Live payload.json or pipeline snapshot whose recognizer to run")
    parser.add_argument("--device", choices=("cpu", "cuda"), help="Override the snapshot device")
    parser.add_argument("--limit", type=int, help="First N tracks only (smoke runs)")
    parser.add_argument("--readings", type=Path, help="Reuse readings.json from an earlier run instead of the model")
    parser.add_argument("--target-precision", type=float, action="append",
                        help="Repeatable; the first one is the main target (default 0.95, 0.90, 0.98)")
    parser.add_argument("--out", type=Path, required=True, help="Folder for readings, evaluation files and report")
    args = parser.parse_args(argv)
    targets = args.target_precision or [0.95, 0.90, 0.98]
    try:
        if args.readings:
            readings = json.loads(args.readings.read_text(encoding="utf-8"))
            rows, pipeline = readings["rows"], readings["pipeline"]
        else:
            if not args.payload:
                raise ValueError("--payload is required unless --readings is given")
            from app.live.__main__ import load_recognizer

            payload = json.loads(args.payload.read_text(encoding="utf-8-sig"))
            snapshot = payload.get("pipeline_snapshot", payload)
            if args.device:
                snapshot = {**snapshot, "device": args.device}
            tracks = find_tracks(args.dataset, args.split, args.val_list)[:args.limit]
            recognizer = load_recognizer(snapshot)
            rows = recognize_tracks(tracks, recognizer, args.dataset,
                                    log=lambda message: print(message, file=sys.stderr, flush=True))
            pipeline = dict(id=snapshot.get("id"), device=snapshot["device"],
                            **{key: snapshot["recognizer"].get(key) for key in ("version", "sha256", "config")})
        args.out.mkdir(parents=True, exist_ok=True)
        if not args.readings:
            (args.out / "readings.json").write_text(json.dumps(dict(pipeline=pipeline, rows=rows), indent=1),
                                                    encoding="utf-8")
        truth, calibration, _ = evaluation_files(rows, args.split)
        (args.out / "ground_truth.json").write_text(json.dumps(truth, indent=1), encoding="utf-8")
        (args.out / "predictions.json").write_text(json.dumps(calibration, indent=1), encoding="utf-8")
        result = dict(pipeline=pipeline, **report(rows, args.split, targets))
        (args.out / "report.json").write_text(json.dumps(result, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        summary = {key: result[key] for key in ("split", "tracks", "recommended", "by_crop_width")}
        summary["exact_accuracy"] = result["recognition"]["end_to_end"]["exact_accuracy"]
        sys.stdout.write(json.dumps(summary, indent=2) + "\n")
    except (OSError, ValueError, KeyError) as exc:
        parser.exit(2, f"ICPR calibration failed: {exc}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
