"""Continuous recognition of a live source (YouTube Live) with the shared TrackSession core."""

# Readable from this OCR confidence. 0.96 reaches precision 0.95 on labelled ICPR tracks but marks
# almost nothing readable on the live cameras; the team chose 0.85 (about 0.87 precision on ICPR,
# docs/EVALUATION.md).
DEFAULT_MIN_CONFIDENCE = .85
