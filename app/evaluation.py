"""Offline recognition metrics over independent, labelled source samples.

This module uses only the standard library and never reads application reviews.
Missing predictions are failures in end-to-end metrics, not discarded samples.
"""

from collections import defaultdict
import math
from statistics import mean
from typing import Any


VARIANTS = ("single_image", "five_image", "enhanced")


def normalize_plate(text: str) -> str:
    """Ignore presentation separators, preserving distinctions such as O/0."""
    return "".join(char for char in text.upper() if not char.isspace() and char != "-")


def levenshtein(reference: str, hypothesis: str) -> int:
    """Character edit distance with linear auxiliary space."""
    if len(reference) < len(hypothesis):
        reference, hypothesis = hypothesis, reference
    previous = list(range(len(hypothesis) + 1))
    for row, expected in enumerate(reference, start=1):
        current = [row]
        for column, actual in enumerate(hypothesis, start=1):
            current.append(min(current[-1] + 1, previous[column] + 1,
                               previous[column - 1] + (expected != actual)))
        previous = current
    return previous[-1]


def _identifier(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise ValueError(f"{field} must be a nonempty string without surrounding whitespace")
    return value


def _records(document: Any, field: str) -> list[dict]:
    if not isinstance(document, dict) or not isinstance(document.get(field), list):
        raise ValueError(f"Document must contain a '{field}' array")
    records = document[field]
    if any(not isinstance(record, dict) for record in records):
        raise ValueError(f"Every item in '{field}' must be an object")
    return records


def _validate_ground_truth(document: Any) -> dict[str, dict]:
    samples = {}
    source_splits = {}
    plate_splits = {}
    for sample in _records(document, "samples"):
        sample_id = _identifier(sample.get("sample_id"), "sample_id")
        if sample_id in samples:
            raise ValueError(f"Duplicate ground-truth sample_id: {sample_id}")
        source_id = _identifier(sample.get("source_id"), "source_id")
        split = _identifier(sample.get("split"), "split")
        plate_text = sample.get("plate_text")
        if not isinstance(plate_text, str) or not normalize_plate(plate_text):
            raise ValueError(f"Ground truth {sample_id} needs a nonempty plate_text")
        if source_id in source_splits and source_splits[source_id] != split:
            raise ValueError(f"Split leakage for source_id: {source_id}")
        source_splits[source_id] = split
        plate_identity = sample.get("plate_identity")
        if plate_identity is not None:
            plate_identity = _identifier(plate_identity, "plate_identity")
            if plate_identity in plate_splits and plate_splits[plate_identity] != split:
                raise ValueError(f"Split leakage for plate_identity: {plate_identity}")
            plate_splits[plate_identity] = split
        for field in ("crop_width", "crop_height"):
            value = sample.get(field)
            if value is not None and (type(value) is not int or value <= 0):
                raise ValueError(f"{field} for {sample_id} must be a positive integer")
        samples[sample_id] = sample
    return samples


def _validate_predictions(document: Any, samples: dict[str, dict]) -> dict[tuple[str, str], dict]:
    predictions = {}
    for prediction in _records(document, "predictions"):
        sample_id = _identifier(prediction.get("sample_id"), "sample_id")
        if sample_id not in samples:
            raise ValueError(f"Prediction refers to unknown sample_id: {sample_id}")
        variant = prediction.get("variant")
        if variant not in VARIANTS:
            raise ValueError(f"variant must be one of: {', '.join(VARIANTS)}")
        key = (sample_id, variant)
        if key in predictions:
            raise ValueError(f"Duplicate prediction for {sample_id}/{variant}")
        detected = prediction.get("detected")
        if type(detected) is not bool:
            raise ValueError(f"detected for {sample_id}/{variant} must be a boolean")
        plate_text = prediction.get("plate_text")
        if plate_text is not None and not isinstance(plate_text, str):
            raise ValueError(f"plate_text for {sample_id}/{variant} must be a string or null")
        if not detected and plate_text is not None and normalize_plate(plate_text):
            raise ValueError(f"Undetected sample {sample_id}/{variant} cannot contain plate_text")
        latency = prediction.get("latency_ms")
        if latency is not None and (type(latency) not in (int, float)
                                    or not math.isfinite(latency) or latency < 0):
            raise ValueError(f"latency_ms for {sample_id}/{variant} must be finite and nonnegative")
        predictions[key] = prediction
    return predictions


def _recognition_metrics(pairs: list[tuple[dict, dict | None]]) -> dict:
    count = len(pairs)
    exact_matches = character_errors = reference_characters = unreadable = 0
    for sample, prediction in pairs:
        reference = normalize_plate(sample["plate_text"])
        hypothesis = normalize_plate(prediction.get("plate_text") or "") if prediction else ""
        exact_matches += reference == hypothesis
        character_errors += levenshtein(reference, hypothesis)
        reference_characters += len(reference)
        unreadable += not hypothesis
    return {
        "sample_count": count,
        "exact_matches": exact_matches,
        "exact_accuracy": exact_matches / count if count else None,
        "character_errors": character_errors,
        "reference_characters": reference_characters,
        "cer": character_errors / reference_characters if reference_characters else None,
        "unreadable_count": unreadable,
        "unreadable_rate": unreadable / count if count else None,
    }


def _metrics(pairs: list[tuple[dict, dict | None]]) -> dict:
    detected = [(sample, prediction) for sample, prediction in pairs
                if prediction is not None and prediction["detected"]]
    latencies = sorted(prediction["latency_ms"] for _, prediction in pairs
                       if prediction is not None and prediction.get("latency_ms") is not None)
    latency_count = len(latencies)
    return {
        "prediction_count": sum(prediction is not None for _, prediction in pairs),
        "missing_prediction_count": sum(prediction is None for _, prediction in pairs),
        "detected_count": len(detected),
        "missed_detection_count": len(pairs) - len(detected),
        "detection_rate": len(detected) / len(pairs) if pairs else None,
        "end_to_end": _recognition_metrics(pairs),
        "recognizer_conditional": _recognition_metrics(detected),
        "latency_ms": {
            "count": latency_count,
            "mean": mean(latencies) if latencies else None,
            "p50": latencies[math.ceil(latency_count * 0.50) - 1] if latencies else None,
            "p95": latencies[math.ceil(latency_count * 0.95) - 1] if latencies else None,
        },
    }


def _crop_width_group(sample: dict) -> str:
    width = sample.get("crop_width")
    if width is None:
        return "unknown"
    if width < 64:
        return "width_lt_64"
    if width < 128:
        return "width_64_127"
    return "width_ge_128"


def evaluate_recognition(ground_truth: dict, predictions: dict, *, split: str | None = "test",
                         group_by_crop_size: bool = False) -> dict:
    """Validate input and return separate, comparable metrics for each variant.

    Split leakage is checked against the entire ground-truth document before
    selecting a split. ``split=None`` evaluates all samples. Each missing
    variant/sample prediction is an end-to-end failure. Conditional OCR metrics
    include only predictions explicitly marked as detected.
    """
    if split is not None:
        _identifier(split, "split")
    samples = _validate_ground_truth(ground_truth)
    indexed = _validate_predictions(predictions, samples)
    selected = [sample for sample in samples.values() if split is None or sample["split"] == split]
    variants = {}
    for variant in VARIANTS:
        pairs = [(sample, indexed.get((sample["sample_id"], variant))) for sample in selected]
        variants[variant] = _metrics(pairs)
        if group_by_crop_size:
            groups = defaultdict(list)
            for sample, prediction in pairs:
                groups[_crop_width_group(sample)].append((sample, prediction))
            variants[variant]["by_crop_width"] = {name: _metrics(items)
                                                   for name, items in sorted(groups.items())}
    return {
        "split": split,
        "sample_count": len(selected),
        "normalization": "uppercase; remove whitespace and hyphen; preserve O/0 and I/1",
        "variants": variants,
    }
