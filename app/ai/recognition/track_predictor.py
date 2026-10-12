"""Track-level model prediction stage placeholders."""

from collections.abc import Mapping, Sequence
from typing import Any


def predict_track_crops(
    recognizer: Any,
    crops_by_track: Mapping[str, Sequence[Any]],
) -> Mapping[str, Any]:
    """Submit each track's five crops to the plate recognition model."""
    predictions = {}
    for track_id, crops in crops_by_track.items():
        if len(crops) != 5:
            raise ValueError(f"Track {track_id} must have exactly five selected crops.")
        frames = [crop["image"] if isinstance(crop, Mapping) else crop for crop in crops]
        predictions[track_id] = recognizer.predict_bgr(frames)
    return predictions
