from dataclasses import dataclass
import os
import math
from pathlib import Path
import sys

from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parents[2]
MODELS = ("yolov8", "yolo11n", "yolo11m", "yolo26n")


def absolute(value: str) -> Path:
    path = Path(value).expanduser()
    return (PROJECT_ROOT / path).resolve() if not path.is_absolute() else path.resolve()


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    cache_dir: Path
    pipeline_python: Path
    device: str = "cpu"
    max_upload_bytes: int = 500 * 1024 * 1024
    poll_seconds: float = 2
    job_timeout_seconds: float = 7200

    @property
    def db_path(self) -> Path:
        return self.data_dir / "jobs.sqlite3"

    @classmethod
    def from_env(cls):
        load_dotenv(PROJECT_ROOT / ".env")
        data = absolute(os.getenv("PLATE_DATA_DIR", "data"))
        settings = cls(
            data_dir=data,
            cache_dir=absolute(os.getenv("PLATE_CACHE_DIR", str(data / "model-cache"))),
            pipeline_python=absolute(os.getenv("PLATE_PIPELINE_PYTHON", sys.executable)),
            device=os.getenv("PLATE_DEVICE", "cpu"),
            max_upload_bytes=int(os.getenv("PLATE_MAX_UPLOAD_MIB", "500")) * 1024 * 1024,
            poll_seconds=float(os.getenv("PLATE_POLL_SECONDS", "2")),
            job_timeout_seconds=float(os.getenv("PLATE_JOB_TIMEOUT_SECONDS", "7200")),
        )
        if settings.device not in ("cpu", "cuda"):
            raise ValueError("PLATE_DEVICE must be cpu or cuda")
        limits = (settings.max_upload_bytes, settings.poll_seconds, settings.job_timeout_seconds)
        if not all(math.isfinite(value) and value > 0 for value in limits):
            raise ValueError("Upload, poll and timeout limits must be positive")
        return settings
