"""YOLO Detection, BoT-SORT Tracking, and Frame Selection Pipeline Module."""

from pathlib import Path
import hashlib
import math
from typing import Any
import cv2
import numpy as np
from huggingface_hub import hf_hub_download
from ultralytics import YOLO
from ultralytics.engine.results import Results


class BotSortTracker:
    """Wrapper bảo vệ và điều phối BoT-SORT Tracker chuẩn hóa theo thời gian thực."""

    def __init__(self, tracker, fps: float):
        if not math.isfinite(fps) or fps <= 0:
            raise ValueError('Invalid tracker clock FPS')
        self.tracker = tracker
        self.fps = fps
        self.origin = None
        self.previous = None

    def update(self, boxes, image, timestamp: float):
        if not math.isfinite(timestamp) or (self.previous is not None and timestamp <= self.previous):
            raise ValueError('Tracker PTS must increase strictly')
        if self.origin is None:
            self.origin = timestamp
            
        tracker = self.tracker
        tick = max(tracker.frame_id + 1, 1 + round((timestamp - self.origin) * self.fps))
        
        # Expire before matching: xóa các track quá hạn trước khi match để tránh hồi sinh ID cũ sai lệch
        for name in ('tracked_stracks', 'lost_stracks'):
            keep = []
            for track in getattr(tracker, name):
                if tick - track.end_frame > tracker.max_frames_lost:
                    track.mark_removed()
                else:
                    keep.append(track)
            setattr(tracker, name, keep)
            
        pool = tracker.tracked_stracks + tracker.lost_stracks
        if pool:
            for _ in range(tick - tracker.frame_id - 1):
                tracker.multi_predict(pool)
                
        tracker.frame_id = tick - 1
        self.previous = timestamp
        return tracker.update(boxes, image)


def create_botsort_tracker(fps: float, buffer_seconds: float):
    """Create Ultralytics BoT-SORT with a time-based lost-track buffer."""
    from ultralytics import __file__ as ultralytics_file
    from ultralytics.cfg import get_cfg
    from ultralytics.trackers.bot_sort import BOTSORT

    if not math.isfinite(buffer_seconds) or buffer_seconds <= 0:
        raise ValueError("Track buffer must be positive and finite.")
    tracker_config = Path(ultralytics_file).parent / "cfg" / "trackers" / "botsort.yaml"
    args = get_cfg(str(tracker_config))
    args.track_buffer = max(1, math.ceil(fps * buffer_seconds))
    tracker = BOTSORT(args)
    return BotSortTracker(tracker, fps)


# =====================================================================
# 4. QUALITY ASSESSMENT & FRAME SELECTION
# =====================================================================

QUALITY_WEIGHTS = dict(sharp=0.35, height=0.30, conf=0.25, edge=0.10)
TOP_FRACTION = 0.5     # Chỉ chọn trong nửa chất lượng cao nhất của track
MIN_POOL = 8           # Pool tối thiểu số lượng frame nếu track đủ dài


def crop_quality(image: np.ndarray, box: list[float], padding: float) -> dict:
    """Tính chỉ số chất lượng của 1 detection từ đúng pixel sẽ được dùng để crop."""
    h, w = image.shape[:2]
    dx, dy = (box[2] - box[0]) * padding, (box[3] - box[1]) * padding
    x1, y1 = max(0, math.floor(box[0] - dx)), max(0, math.floor(box[1] - dy))
    x2, y2 = min(w, math.ceil(box[2] + dx)), min(h, math.ceil(box[3] + dy))
    crop = image[y1:y2, x1:x2]
    
    if crop.size == 0:
        return dict(sharpness=0.0, box_height=0.0, box_area=0.0, edge_ok=0)
        
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    gray = cv2.resize(gray, (192, 48), interpolation=cv2.INTER_AREA)
    sharp = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    bw, bh = box[2] - box[0], box[3] - box[1]
    margin = 2
    edge_ok = int(box[0] > margin and box[1] > margin
                  and box[2] < w - margin and box[3] < h - margin)
                  
    return dict(
        sharpness=sharp if math.isfinite(sharp) else 0.0,
        box_height=float(bh),
        box_area=float(bw * bh),
        edge_ok=edge_ok
    )


def _minmax(values: list[float]) -> list[float]:
    lo, hi = min(values), max(values)
    if hi - lo < 1e-9:
        return [0.5] * len(values)
    return [(v - lo) / (hi - lo) for v in values]


def score_rows(rows: list[dict]) -> list[float]:
    """Điểm chất lượng 0..1 cho từng observation, chuẩn hóa trong nội bộ track."""
    sharp = _minmax([math.log1p(r.get('sharpness', 0.0)) for r in rows])
    height = _minmax([r.get('box_height', 0.0) for r in rows])
    conf = _minmax([r['confidence'] for r in rows])
    w = QUALITY_WEIGHTS
    return [
        w['sharp'] * s + w['height'] * h + w['conf'] * c + w['edge'] * r.get('edge_ok', 1)
        for r, s, h, c in zip(rows, sharp, height, conf)
    ]


def select_five(rows: list[dict], cfg: dict) -> tuple[list[dict] | None, str | None]:
    """Chọn 5 observation tốt nhất: lọc theo chất lượng, rồi trải đều theo thời gian."""
    unique = {}
    for r in rows:
        if r["confidence"] >= cfg.get("crop_confidence", 0.1):
            previous = unique.get(r["frame_index"])
            if previous is None or r["confidence"] > previous["confidence"]:
                unique[r["frame_index"]] = r
                
    eligible = sorted(unique.values(), key=lambda r: r["frame_index"])
    if len(eligible) < 5:
        return None, "fewer_than_five_valid_frames"
        
    if any(b["timestamp_seconds"] <= a["timestamp_seconds"] for a, b in zip(eligible, eligible[1:])):
        raise ValueError("Track timestamps must be strictly increasing")

    scores = score_rows(eligible)
    pool_size = min(len(eligible), max(5, MIN_POOL, math.ceil(TOP_FRACTION * len(eligible))))
    top = sorted(range(len(eligible)), key=lambda i: scores[i], reverse=True)[:pool_size]
    pool = sorted(top)
    
    picks = np.rint(np.linspace(0, len(pool) - 1, 5)).astype(int)
    chosen = [eligible[pool[i]] for i in picks]
    
    if len({r["frame_index"] for r in chosen}) != 5:
        chosen = [eligible[i] for i in sorted(top[:5])]
        
    return chosen, None


def crop_bounds(box: list[float], width: int, height: int, padding: float) -> list[int]:
    """Mở rộng bounding box mà không resize; giữ nguyên box gốc riêng biệt."""
    dx, dy = (box[2] - box[0]) * padding, (box[3] - box[1]) * padding
    return [
        max(0, math.floor(box[0] - dx)),
        max(0, math.floor(box[1] - dy)),
        min(width, math.ceil(box[2] + dx)),
        min(height, math.ceil(box[3] + dy))
    ]