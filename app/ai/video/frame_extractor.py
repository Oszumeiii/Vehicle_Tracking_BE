"""Video frame extraction stage placeholders."""

from collections.abc import Iterator
import math
from pathlib import Path
from typing import Any
import cv2
import numpy as np


def extract_frames(video_path: Path, max_seconds: float = 0) -> Iterator[tuple[int, float, np.ndarray]]:
    """Yield (one-based frame index, timestamp, BGR frame) from a video."""
    capture = cv2.VideoCapture(str(video_path))
    try:
        fps = capture.get(cv2.CAP_PROP_FPS)
        if not capture.isOpened() or not math.isfinite(fps) or fps <= 0:
            raise ValueError(f"Cannot open video or determine a valid frame rate: {video_path}")
        frame_index = 0
        while True:
            ok, image = capture.read()
            if not ok:
                break
            frame_index += 1
            timestamp = (frame_index - 1) / fps
            if max_seconds > 0 and timestamp >= max_seconds:
                break
            yield frame_index, timestamp, image
    finally:
        capture.release()


class FrameExtractor:
    def __init__(self, fps, low_fps, med_fps, high_fps, threshold_low, threshold_high):
        values = [fps, low_fps, med_fps, high_fps, threshold_low, threshold_high]
        if not all(math.isfinite(v) for v in values) or fps <= 0:
            raise ValueError('FPS/ngưỡng không hợp lệ')
        if not 0 < low_fps <= med_fps <= high_fps or not 0 <= threshold_low < threshold_high:
            raise ValueError('Kiểm tra thứ tự FPS/ngưỡng')
        self.fps = round(fps, 2)
        self.rates = (low_fps, med_fps, high_fps)
        self.thresholds = (threshold_low, threshold_high)
        self.prev = None
        self.score = 0.
        self.last = -1.

    def select(self, image, index):
        gray = cv2.cvtColor(cv2.resize(image, (320,180), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
        if self.prev is not None:
            motion = float(np.mean(cv2.absdiff(self.prev, gray))) / 255 * 100
            self.score = .6 * motion + .4 * self.score
        self.prev = gray
        if self.score < self.thresholds[0]:
            level = 0
        elif self.score < self.thresholds[1]:
            level = 1
        else:
            level = 2
        rate = min(self.rates[level], self.fps)
        timestamp = (index-1)/self.fps
        if self.last >= 0 and timestamp-self.last < 1/rate-.5/self.fps:
            return None
        self.last = timestamp
        return {
            "motion_score": round(self.score, 2),
            "change_level": ("Low", "Medium", "High")[level],
            "sampling_fps": rate,
        }
