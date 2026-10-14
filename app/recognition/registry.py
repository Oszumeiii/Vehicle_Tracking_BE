"""Validate the immutable ML snapshot created by the NestJS pipeline registry."""
import hashlib
from pathlib import Path


class PipelineUnavailable(ValueError):
    """The exact checkpoint or source pinned for this job is unavailable."""

    code = "CHECKPOINT_MISSING"


def digest(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def validate_snapshot(snapshot):
    """Fail if a checkpoint or inference source changed after enqueue."""
    if snapshot.get("task", "recognize") not in {"prepare", "recognize"}:
        raise ValueError("Invalid pipeline task")
    models = [snapshot["detector"]]
    if snapshot.get("task", "recognize") != "prepare":
        if snapshot["recognizer"].get("input_mode", "single_crop") not in {"single_crop", "five_frame_joint"}:
            raise ValueError("Invalid recognizer input mode")
        models.append(snapshot["recognizer"])
    for spec in [*models, *snapshot["code_files"]]:
        path = Path(spec.get("checkpoint") or spec["path"])
        try:
            valid = path.is_file() and digest(path) == spec["sha256"]
        except OSError:
            valid = False
        if not valid:
            raise PipelineUnavailable("Checkpoint or inference code changed after job creation")
