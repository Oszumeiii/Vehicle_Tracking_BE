from datetime import datetime
from typing import Literal
from pydantic import BaseModel

ModelName = Literal["yolov8", "yolo11n", "yolo11m", "yolo26n"]
JobState = Literal["queued", "running", "succeeded", "failed"]


class AcceptedJob(BaseModel):
    job_id: str
    status: JobState
    status_url: str


class JobStatus(BaseModel):
    job_id: str
    status: JobState
    model: ModelName
    confidence: float
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    selected_frames: int | None
    total_crops: int | None
    error_code: str | None
    error_message: str | None


class Plate(BaseModel):
    crop_id: str
    frame_index: int
    timestamp_seconds: float
    confidence: float
    bbox: tuple[float, float, float, float]
    crop_bbox: tuple[int, int, int, int]
    crop_url: str


class PlatePage(BaseModel):
    job_id: str
    total: int
    limit: int
    offset: int
    items: list[Plate]
