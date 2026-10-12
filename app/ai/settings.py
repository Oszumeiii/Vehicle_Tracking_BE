from dataclasses import dataclass, field
from pathlib import Path
import os

from app.ai.recognition.config import Config


def _boolean(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be a boolean value")


@dataclass(frozen=True)
class Settings:
    model_path: Path = field(default_factory=lambda: Config.CHECKPOINT_PATH)
    device: str = Config.DEVICE
    max_file_bytes: int = Config.MAX_FRAME_BYTES
    max_image_pixels: int = Config.MAX_IMAGE_PIXELS
    cpu_threads: int = max(1, min(os.cpu_count() or 1, 8))
    use_amp: bool = field(default_factory=lambda: _boolean("MODEL_USE_AMP", False))
    use_tta: bool = field(default_factory=lambda: _boolean("MODEL_USE_TTA", False))
    decoder: str = "beam_constrained"
    beam_width: int = 8

    def __post_init__(self):
        if self.device not in {"cpu", "cuda"}:
            raise ValueError("MODEL_DEVICE must be cpu or cuda")
        if min(self.max_file_bytes, self.max_image_pixels, self.cpu_threads, self.beam_width) <= 0:
            raise ValueError("Inference limits, CPU threads and beam width must be positive")
        if self.decoder != "beam_constrained":
            raise ValueError("Only the beam_constrained decoder is supported")
