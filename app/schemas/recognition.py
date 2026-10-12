from typing import Literal
from pydantic import BaseModel, Field


class Prediction(BaseModel):
    track_id: str | None = None
    plate: str
    greedy_plate: str
    format_valid: bool
    confidence: float = Field(ge=0.0, le=1.0)
    confidence_type: Literal['ctc_length_normalized_uncalibrated']
    ctc_log_probability: float | None
    decoder: Literal['greedy', 'beam_constrained', 'greedy_fallback']
    frame_weights: list[float] = Field(min_length=5, max_length=5)
    num_frames: Literal[5]
    device: str
    model_id: str
    tta: bool
    processing_ms: float = Field(ge=0)


class Health(BaseModel):
    status: Literal['ready']
    device: str
    model_id: str
    num_frames: Literal[5] = 5
