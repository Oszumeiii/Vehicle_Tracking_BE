"""Compare crop selections on a video: same tracks, five crops chosen two ways, both read by the OCR.

  python -m scripts.eval_crops --video clip.mp4 --payload data/live/SESSION/payload.json --out DIR
      [--zones "x1,y1,x2,y2;..."] [--seconds N]

Detection and tracking run once, exactly as in the live pipeline (TrackSession on the
pinned snapshot); when a track ends its five crops are selected with "current" and with
"robust" (video_tracking.select_five) and each set goes through the joint OCR. Writes
tracks.json, report.json and sheet.jpg (crops of tracks whose status differs). There are
no ground-truth labels here: the readable share and confidence are compared, and the
sheet is for a person to check that the readings did not get worse.
"""
import argparse
from collections import Counter
import json
from pathlib import Path
import statistics
import sys

import cv2
import numpy as np

from app.recognition import video_tracking as vt

MODES = ("current", "robust")


def crops_of(candidate_rows, jpeg, cfg):
    """RGB crops exactly as export_retained cuts them from the sampled (JPEG round-tripped) frames."""
    from PIL import Image
    images = []
    for row in candidate_rows:
        frame = cv2.imdecode(np.frombuffer(jpeg[row["frame_index"]], np.uint8), cv2.IMREAD_COLOR)
        h, w = frame.shape[:2]
        x1, y1, x2, y2 = vt.crop_bounds(row["box"], w, h, cfg["crop_padding"])
        images.append(Image.fromarray(cv2.cvtColor(frame[y1:y2, x1:x2], cv2.COLOR_BGR2RGB)))
    return images


class BothSelections(vt.TrackSession):
    """A TrackSession that selects every finished track's crops with each mode."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.compared = []

    def _finish(self, tid):
        rows = self.active[tid]
        picks = {}
        for mode in MODES:
            chosen, reason = vt.select_five(rows, {**self.cfg, "crop_selection": mode})
            picks[mode] = (chosen, reason)
        if picks["current"][0]:
            hidden = vt.hidden_or_cut(sorted((r for r in rows if r["confidence"] >= self.cfg["crop_confidence"]),
                                             key=lambda r: r["frame_index"]))
            self.compared.append(dict(track_id=tid, observations=len(rows), hidden_observations=len(hidden),
                                      picks={m: [dict(r) for r in c] for m, (c, _) in picks.items()},
                                      jpeg={r["frame_index"]: self._jpeg_bytes[r["frame_index"]]
                                            for m in MODES for r in picks[m][0]}))
        super()._finish(tid)


def read(recognizer, images):
    from app.live.runner import plate_confidence
    from app.recognition.fusion import normalize_plate
    result = recognizer(images)
    text = normalize_plate(result.get("raw_text") or "") or None
    return text, plate_confidence(result)


def sheet(rows, out, limit=12):
    """Crops of tracks whose status differs: one line per selection."""
    lines = []
    for row in rows[:limit]:
        for mode in MODES:
            tiles = []
            for image in row["images"][mode]:
                tile = cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2BGR)
                tile = cv2.resize(tile, (tile.shape[1] * 3, tile.shape[0] * 3), interpolation=cv2.INTER_NEAREST)
                tiles.append(cv2.copyMakeBorder(tile, 3, 3, 3, 3, cv2.BORDER_CONSTANT, value=(255, 255, 255)))
            height = max(t.shape[0] for t in tiles)
            strip = np.hstack([cv2.copyMakeBorder(t, 0, height - t.shape[0], 0, 0, cv2.BORDER_CONSTANT,
                                                  value=(255, 255, 255)) for t in tiles])
            label = np.full((30, strip.shape[1], 3), 255, np.uint8)
            reading = row[mode]
            cv2.putText(label, f"t{row['track_id']} {mode}: {reading['text']} {reading['confidence']:.2f} "
                               f"{reading['status']}", (4, 22), cv2.FONT_HERSHEY_SIMPLEX, .6, (0, 0, 0), 1)
            lines.append(np.vstack([label, strip]))
    if not lines:
        return False
    width = max(line.shape[1] for line in lines)
    cv2.imwrite(str(out), np.vstack([cv2.copyMakeBorder(line, 0, 0, 0, width - line.shape[1], cv2.BORDER_CONSTANT,
                                                        value=(255, 255, 255)) for line in lines]))
    return True


def main(argv=None):
    from app.live import DEFAULT_MIN_CONFIDENCE
    from app.live.__main__ import load_models
    from app.live.runner import classify
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--video", type=Path, required=True)
    parser.add_argument("--payload", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--zones", default="", help="Exclusion zones as normalized x1,y1,x2,y2;... (the camera's)")
    parser.add_argument("--seconds", type=float, default=0, help="Only the first N seconds")
    parser.add_argument("--threshold", type=float, default=DEFAULT_MIN_CONFIDENCE)
    args = parser.parse_args(argv)
    snapshot = json.loads(args.payload.read_text(encoding="utf-8-sig"))["pipeline_snapshot"]
    model, recognizer = load_models(snapshot)
    cfg = {**vt.video_config(args.video, snapshot), "max_track_seconds": 30,
           "exclude_zones": [list(map(float, z.split(","))) for z in args.zones.split(";") if z]}
    vt.warm_up_detector(model, cfg)
    session = BothSelections(model, cfg, retain_images=True)
    with session:
        for index, timestamp, image, gray in vt.read_frames(args.video, args.seconds or 0):
            session.push(index, timestamp, image, gray)
        session.close()
    rows = []
    for track in session.compared:
        row = dict(track_id=track["track_id"], observations=track["observations"],
                   hidden_observations=track["hidden_observations"], images={})
        for mode in MODES:
            chosen = track["picks"][mode]
            images = crops_of(chosen, track["jpeg"], cfg)
            text, confidence = read(recognizer, images)
            hidden = vt.hidden_or_cut(chosen)
            row[mode] = dict(text=text, confidence=round(float(confidence or 0), 4),
                             status=classify(text, confidence, args.threshold),
                             widths=[round(vt._width(r)) for r in chosen], frames=[r["frame_index"] for r in chosen],
                             hidden_picked=len(hidden))
            row["images"][mode] = images
        rows.append(row)
    args.out.mkdir(parents=True, exist_ok=True)
    report = dict(video=str(args.video), tracks=len(rows), threshold=args.threshold,
                  rejected=dict(session.rejected))
    for mode in MODES:
        readings = [r[mode] for r in rows]
        report[mode] = dict(
            readable=sum(r["status"] == "readable" for r in readings),
            statuses=dict(Counter(r["status"] for r in readings)),
            median_confidence=round(statistics.median([r["confidence"] for r in readings]), 4) if readings else None,
            median_crop_width=statistics.median([w for r in readings for w in r["widths"]]) if readings else None,
            tracks_with_hidden_crop=sum(r["hidden_picked"] > 0 for r in readings))
    both = [r for r in rows if r["current"]["text"] and r["robust"]["text"]]
    report["same_text"] = sum(r["current"]["text"] == r["robust"]["text"] for r in both)
    report["both_read"] = len(both)
    changed = [r for r in rows if r["current"]["status"] != r["robust"]["status"]]
    report["status_changed"] = dict(Counter(f"{r['current']['status']}->{r['robust']['status']}" for r in changed))
    (args.out / "tracks.json").write_text(json.dumps([{k: v for k, v in r.items() if k != "images"} for r in rows],
                                                     indent=1), encoding="utf-8")
    (args.out / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    sheet(sorted(changed, key=lambda r: -r["robust"]["confidence"]), args.out / "sheet.jpg")
    sys.stdout.write(json.dumps(report, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
