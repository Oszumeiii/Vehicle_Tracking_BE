
import math
import cv2
import numpy as np
from collections import Counter

class EmptySceneGate:
    def __init__(self, enabled=True, probe_seconds=.25, empty_confirmations=3,
                 motion_fraction=.003, warmup_frames=60):
        if not math.isfinite(probe_seconds) or probe_seconds <= 0:
            raise ValueError('probe_seconds must be positive and finite')
        if empty_confirmations < 1 or warmup_frames < 1:
            raise ValueError('confirmations and warmup must be >= 1')
        if not math.isfinite(motion_fraction) or not 0 < motion_fraction <= 1:
            raise ValueError('motion_fraction must be in (0,1]')
        self.enabled = bool(enabled)
        self.probe_seconds = probe_seconds
        self.empty_confirmations = empty_confirmations
        self.motion_fraction = motion_fraction
        self.warmup_frames = warmup_frames
        self.background = (cv2.createBackgroundSubtractorMOG2(
            history=300, varThreshold=25, detectShadows=False
        ) if self.enabled else None)
        self.seen_frames = 0
        self.foreground_fraction = 0.
        self.empty_streak = 0
        self.live_tracks = False
        self.last_scheduled = None
        self.previous_time = None
        self.counts = Counter()

    def observe_image(self, image):
        """Update a small background model on every decoded source frame."""
        if not self.enabled:
            return
        if self.background is None:
            raise RuntimeError('Background subtractor is unavailable while the gate is enabled.')
        gray = cv2.cvtColor(cv2.resize(image, (320, 180),
                                      interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
        mask = self.background.apply(gray, learningRate=.01)
        self.foreground_fraction = float(np.count_nonzero(mask)) / mask.size
        self.seen_frames += 1

    def observe_detection(self, detection_count, live_tracks):
        """Called after each actual YOLO/BoT-SORT update, never for skipped frames."""
        self.live_tracks = bool(live_tracks)
        self.empty_streak = self.empty_streak + 1 if detection_count == 0 else 0
        self.counts['detector_frames'] += 1
        if detection_count == 0:
            self.counts['detector_frames_without_plate'] += 1

    @property
    def idle(self):
        return self.empty_streak >= self.empty_confirmations and not self.live_tracks

    def decide(self, timestamp):
        """Evaluate only adaptive-sampling candidates; return keep and reason."""
        if not math.isfinite(timestamp) or (
            self.previous_time is not None and timestamp <= self.previous_time
        ):
            raise ValueError('Gate timestamps must increase strictly')
        self.previous_time = timestamp
        if not self.enabled:
            reason = 'disabled'
        elif self.seen_frames <= self.warmup_frames:
            reason = 'warmup'
        elif self.live_tracks:
            reason = 'live_track'
        elif self.empty_streak < self.empty_confirmations:
            reason = 'confirm_scene'
        elif self.foreground_fraction >= self.motion_fraction:
            reason = 'motion'
        elif self.last_scheduled is None or timestamp - self.last_scheduled >= self.probe_seconds:
            reason = 'periodic_probe'
        else:
            reason = 'idle_skip'
        keep = reason != 'idle_skip'
        self.counts['adaptive_candidates'] += 1
        self.counts[reason] += 1
        self.counts['kept' if keep else 'skipped'] += 1
        if keep:
            self.last_scheduled = timestamp
        return keep, reason

    def summary(self):
        total = self.counts['adaptive_candidates']
        return dict(enabled=self.enabled, adaptive_candidates=total,
                    detector_frames=self.counts['detector_frames'],
                    detector_frames_without_plate=self.counts['detector_frames_without_plate'],
                    skipped_empty_candidates=self.counts['skipped'],
                    skip_fraction_of_candidates=self.counts['skipped'] / max(1, total),
                    probe_seconds=self.probe_seconds, reasons=dict(self.counts),
                    note='Skipped frames are likely quiet, not verified empty. Decode still runs; YOLO/JPEG work is reduced.')
