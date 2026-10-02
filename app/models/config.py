import os
from pathlib import Path

from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(PROJECT_ROOT / ".env")


def _absolute(value: str) -> Path:
    path = Path(value).expanduser()
    return (PROJECT_ROOT / path).resolve() if not path.is_absolute() else path.resolve()


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


class Config:
    CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    IDX2CHAR = {idx + 1: char for idx, char in enumerate(CHARS)}
    NUM_CLASSES = len(CHARS) + 1

    IMG_HEIGHT = 32
    IMG_WIDTH = 128
    NUM_FRAMES = 5

    STN_MAX_AFFINE_DELTA = float(os.getenv("MODEL_STN_MAX_AFFINE_DELTA", "0.15"))
    USE_STN = _boolean("MODEL_USE_STN", True)
    USE_CENTER_LOSS = _boolean("MODEL_USE_CENTER_LOSS", False)
    FP32_SEQUENCE_DECODER = _boolean("MODEL_FP32_SEQUENCE_DECODER", True)
    PLATE_POSITION_CLASSES = os.getenv("MODEL_PLATE_POSITION_CLASSES", "LLLDDDD").strip().upper()

    CHECKPOINT_PATH = _absolute(os.getenv("MODEL_CHECKPOINT", "app/models/single_model_best"))
    DEVICE = os.getenv("MODEL_DEVICE", "cpu").strip().lower()
    MAX_FRAME_BYTES = int(os.getenv("MODEL_MAX_FRAME_MIB", "8")) * 1024 * 1024

    if DEVICE not in {"cpu", "cuda"}:
        raise ValueError("MODEL_DEVICE must be cpu or cuda")
    if MAX_FRAME_BYTES <= 0:
        raise ValueError("MODEL_MAX_FRAME_MIB must be positive")
    if not PLATE_POSITION_CLASSES or any(cls not in {"L", "D", "A"} for cls in PLATE_POSITION_CLASSES):
        raise ValueError("MODEL_PLATE_POSITION_CLASSES must use L, D, or A and cannot be empty")