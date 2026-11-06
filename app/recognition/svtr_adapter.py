"""Inference adapter for the SVTRv2-Base regional five-crop OCR checkpoint."""
from collections.abc import Mapping, Sequence
import hashlib
import math
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
import torch
from torch.nn import functional as F

from app.recognition.ctc_decoders import DECODERS, CTCDecoder
from app.recognition.svtr_config import Config
from app.recognition.svtr_model import SingleLRLPRModel

MODEL_VERSION = "svtrv2-base-regional-pool-warmup-v1"
DEFAULT_CONFIG = {"decoder": "beam_filter", "beam_width": 8}


class SVTRRecognizer:
    """Own the OCR model, device and decoding settings across predictions."""

    @staticmethod
    def preprocess_frames(images: Sequence[Image.Image]) -> torch.Tensor:
        """Resize with aspect ratio, center-pad gray to 40x128, and normalize to [-1, 1]."""
        if not isinstance(images, (list, tuple)) or len(images) != Config.NUM_FRAMES:
            raise ValueError("SVTR OCR requires exactly five ordered RGB crops.")

        frames = []
        for image in images:
            if not isinstance(image, Image.Image) or image.mode != "RGB":
                raise ValueError("Each SVTR crop must be a PIL image in RGB mode.")
            if image.width <= 0 or image.height <= 0:
                raise ValueError("SVTR crops must have positive dimensions.")

            rgb = np.asarray(image, dtype=np.uint8)
            scale = min(Config.IMG_WIDTH / image.width, Config.IMG_HEIGHT / image.height)
            width = max(1, min(Config.IMG_WIDTH, round(image.width * scale)))
            height = max(1, min(Config.IMG_HEIGHT, round(image.height * scale)))
            resized = cv2.resize(rgb, (width, height), interpolation=cv2.INTER_LINEAR)
            canvas = np.full((Config.IMG_HEIGHT, Config.IMG_WIDTH, 3), 128, dtype=np.uint8)
            left = (Config.IMG_WIDTH - width) // 2
            top = (Config.IMG_HEIGHT - height) // 2
            canvas[top : top + height, left : left + width] = resized
            normalized = (canvas.astype(np.float32) / 255.0 - 0.5) / 0.5
            frames.append(torch.from_numpy(np.ascontiguousarray(normalized.transpose(2, 0, 1))))

        return torch.stack(frames, dim=0).unsqueeze(0)

    @staticmethod
    def validate_config(config: object) -> dict:
        if not isinstance(config, Mapping):
            raise ValueError("SVTR config must be an object.")
        unknown = set(config) - set(DEFAULT_CONFIG)
        if unknown:
            raise ValueError(f"Unsupported SVTR config option: {sorted(unknown)[0]}.")
        effective = {**DEFAULT_CONFIG, **config}
        if effective["decoder"] not in DECODERS:
            raise ValueError("SVTR decoder must be one of " + ", ".join(DECODERS) + ".")
        width = effective["beam_width"]
        if isinstance(width, bool) or not isinstance(width, int) or not 1 <= width <= 64:
            raise ValueError("SVTR beam_width must be an integer from 1 to 64.")
        return effective

    @staticmethod
    def load_state(path: Path):
        state = torch.load(path, map_location="cpu", weights_only=True)
        if not isinstance(state, Mapping) or not state or any(
            not isinstance(key, str) or not isinstance(value, torch.Tensor)
            for key, value in state.items()
        ):
            raise ValueError("SVTR checkpoint must contain a tensor state_dict.")
        return state

    def __init__(self, spec: Mapping):
        """Load and validate the model once for this recognizer instance."""
        self.options = SVTRRecognizer.validate_config(spec.get("config", {}))
        checkpoint = Path(spec["checkpoint"])
        if not checkpoint.is_file():
            raise FileNotFoundError("SVTR checkpoint is unavailable.")
        expected_hash = spec.get("sha256")
        if expected_hash:
            with checkpoint.open("rb") as source:
                actual_hash = hashlib.file_digest(source, "sha256").hexdigest()
            if actual_hash != expected_hash:
                raise ValueError("SVTR checkpoint checksum differs from the pipeline snapshot.")

        device_name = spec.get("device", "cpu")
        if device_name not in {"cpu", "cuda"}:
            raise ValueError("SVTR inference device must be cpu or cuda.")
        if device_name == "cuda" and not torch.cuda.is_available():
            raise RuntimeError("CUDA was requested but is unavailable.")
        self.device = torch.device(device_name)

        self.model = SingleLRLPRModel()
        self.model.load_state_dict(SVTRRecognizer.load_state(checkpoint), strict=True)
        self.model.to(self.device).eval()
        self.amp = self.device.type == "cuda"

    def __call__(self, images):
        tensor = SVTRRecognizer.preprocess_frames(images).to(self.device)
        with torch.inference_mode(), torch.autocast(
            device_type=self.device.type, dtype=torch.float16, enabled=self.amp
        ):
            logits, _, _, frame_weights = self.model(tensor, return_aux=True)
            log_probs = F.log_softmax(logits.float(), dim=-1)[0].cpu()
            weights = frame_weights[0].float().cpu()

        if not torch.isfinite(log_probs).all():
            raise FloatingPointError("SVTR OCR logits contain NaN or Inf.")
        if (
            weights.numel() != Config.NUM_FRAMES
            or not torch.isfinite(weights).all()
            or torch.any(weights < 0)
            or torch.any(weights > 1)
        ):
            raise FloatingPointError("SVTR frame fusion weights are invalid.")
        weight_total = float(weights.sum())
        if not math.isfinite(weight_total) or weight_total <= 0:
            raise FloatingPointError("SVTR frame fusion weights have no valid contribution.")
        # The SVTR regional fusion can reserve probability mass for its unknown feature.
        # The API contract stores normalized relative weights across the five crop inputs.
        normalized_weights = (weights / weight_total).tolist()

        decoding = CTCDecoder.decode_track(log_probs, self.options["decoder"], self.options["beam_width"])
        decoding["use_tta"] = False
        return {
            "raw_text": decoding["plate_text"],
            "ocr_score": None,
            "character_scores": None,
            "frame_weights": normalized_weights,
            "decoding": decoding,
        }


# Compatibility for previously persisted pipeline snapshots.
create_recognizer = SVTRRecognizer
