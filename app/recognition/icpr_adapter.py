"""Safe inference adapter for the joint-five-frame SE-ResNet34-C OCR model.

Mirrors the PBL6 PIPELINE notebook: ``preprocess_track`` (cell 38),
``predict_log_probs`` (cell 36) and ``decode_track`` (cell 38). It does not
train and never repeats a single crop to fill a track.
See docs/OCR_KAGGLE.md for provenance and the five-image input contract.
"""
from collections import OrderedDict
from collections.abc import Mapping, Sequence
import hashlib
import math
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
import torch
from torch.nn import functional as F

from app.recognition.ctc_decoders import DECODERS, decode_predictions_greedy, decode_track
from app.recognition.icpr_model import Config, SingleLRLPRModel

# Kept for callers/tests that decode raw logits directly.
decode_predictions = decode_predictions_greedy

DEFAULT_CONFIG = {"decoder": "beam_filter", "beam_width": 8, "use_tta": False}


def preprocess_frames(images: Sequence[Image.Image]) -> torch.Tensor:
    """Notebook transform: RGB, bilinear resize to 192x48, scale to [-1, 1], CHW.

    The caller guarantees five distinct, temporally ordered source frames.
    """
    if not isinstance(images, (list, tuple)) or len(images) != Config.NUM_FRAMES:
        raise ValueError("ICPR joint model requires exactly five PIL RGB crops.")
    frames = []
    for image in images:
        if not isinstance(image, Image.Image) or image.mode != "RGB":
            raise ValueError("Each ICPR crop must be a PIL image in RGB mode.")
        if image.width <= 0 or image.height <= 0:
            raise ValueError("ICPR crops must have positive dimensions.")
        rgb = np.asarray(image, dtype=np.uint8)
        resized = cv2.resize(rgb, (Config.IMG_WIDTH, Config.IMG_HEIGHT), interpolation=cv2.INTER_LINEAR)
        normalized = (resized.astype(np.float32) / 255.0 - .5) / .5
        frames.append(torch.from_numpy(np.ascontiguousarray(normalized.transpose(2, 0, 1))))
    return torch.stack(frames, dim=0).unsqueeze(0)


def validate_config(config: object) -> dict:
    """Return the effective decoding config; unknown or invalid options fail."""
    if not isinstance(config, Mapping):
        raise ValueError("ICPR config must be an object.")
    unknown = set(config) - set(DEFAULT_CONFIG)
    if unknown:
        raise ValueError(f"Unsupported ICPR config option: {sorted(unknown)[0]}.")
    effective = {**DEFAULT_CONFIG, **config}
    if effective["decoder"] not in DECODERS:
        raise ValueError("ICPR decoder must be one of " + ", ".join(DECODERS) + ".")
    width = effective["beam_width"]
    if isinstance(width, bool) or not isinstance(width, int) or not 1 <= width <= 64:
        raise ValueError("ICPR beam_width must be an integer from 1 to 64.")
    if not isinstance(effective["use_tta"], bool):
        raise ValueError("ICPR use_tta must be a boolean.")
    return effective


def load_state(path: Path) -> OrderedDict:
    """Load tensors only; accept the notebook's plain or wrapped state_dict."""
    raw = torch.load(path, map_location="cpu", weights_only=True)
    if isinstance(raw, Mapping):
        for key in ("state_dict", "model_state_dict", "model"):
            if isinstance(raw.get(key), Mapping):
                raw = raw[key]
                break
    if not isinstance(raw, Mapping) or not raw or any(
            not isinstance(k, str) or not isinstance(v, torch.Tensor) for k, v in raw.items()):
        raise ValueError("ICPR checkpoint must contain a tensor state_dict.")
    state = OrderedDict()
    for key, value in raw.items():
        for prefix in ("module.", "_orig_mod."):
            if key.startswith(prefix):
                key = key[len(prefix):]
        if key.startswith("sr_decoder."):
            continue  # Training-only super-resolution branch.
        if key in state:
            raise ValueError("Duplicate checkpoint key after prefix removal: " + key)
        if value.is_floating_point() and not torch.isfinite(value).all():
            raise ValueError("ICPR checkpoint contains non-finite weights.")
        state[key] = value
    return state


def _affine_variant(images, scale, tx, ty):
    B, T, C, H, W = images.shape
    x = images.float().reshape(B * T, C, H, W)
    theta = torch.tensor([[scale, 0.0, tx], [0.0, scale, ty]], device=x.device, dtype=torch.float32)
    grid = F.affine_grid(theta.unsqueeze(0).expand(B * T, -1, -1), x.size(), align_corners=False)
    out = F.grid_sample(x, grid, mode="bilinear", padding_mode="border", align_corners=False)
    return out.view(B, T, C, H, W).to(images.dtype)


def predict_log_probs(model, images, *, use_tta=False, amp=False):
    """Average per-timestep log probabilities across optional TTA views.

    Fusion weights come from the untransformed view.
    """
    variants = Config.TTA_VARIANTS if use_tta else [(1.0, 0.0, 0.0)]
    acc, weights = [], None
    for sc, tx, ty in variants:
        identity = sc == 1.0 and tx == 0.0 and ty == 0.0
        x = images if identity else _affine_variant(images, sc, tx, ty)
        with torch.autocast(device_type=images.device.type, dtype=torch.float16, enabled=amp):
            logits, frame_weights = model(x)
        if identity:
            weights = frame_weights
        acc.append(F.log_softmax(logits.float(), dim=-1))
    return F.log_softmax(torch.stack(acc, dim=0).mean(dim=0), dim=-1), weights


def create_recognizer(spec: Mapping):
    """Load once and return a callable accepting exactly five ordered PIL RGB images."""
    options = validate_config(spec.get("config", {}))
    checkpoint = Path(spec["checkpoint"])
    if not checkpoint.is_file():
        raise FileNotFoundError("ICPR checkpoint is unavailable.")
    if spec.get("sha256"):
        with checkpoint.open("rb") as source:
            actual = hashlib.file_digest(source, "sha256").hexdigest()
        if actual != spec["sha256"]:
            raise ValueError("ICPR checkpoint checksum differs from the pipeline snapshot.")
    device_name = spec.get("device", "cpu")
    if device_name not in {"cpu", "cuda"}:
        raise ValueError("ICPR inference device must be cpu or cuda.")
    if device_name == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA was requested but is unavailable.")
    device = torch.device(device_name)
    model = SingleLRLPRModel()
    model.load_state_dict(load_state(checkpoint), strict=True)
    model.to(device).eval()
    # Notebook OCR_USE_AMP: fp16 autocast on CUDA only; STN stays FP32.
    amp = device.type == "cuda"

    def recognize(images):
        tensor = preprocess_frames(images).to(device)
        with torch.inference_mode():
            log_probs, weights = predict_log_probs(model, tensor, use_tta=options["use_tta"], amp=amp)
            log_probs = log_probs.float().cpu()[0]
            frame_weights = weights[0].float().cpu().tolist()
        if not torch.isfinite(log_probs).all():
            raise FloatingPointError("OCR NaN/Inf")
        if (len(frame_weights) != Config.NUM_FRAMES
                or any(not math.isfinite(weight) or weight < 0 or weight > 1 for weight in frame_weights)):
            raise FloatingPointError("ICPR fusion weights are invalid.")
        decoding = decode_track(log_probs, options["decoder"], options["beam_width"])
        decoding["use_tta"] = options["use_tta"]
        return {
            "raw_text": decoding["plate_text"],
            "ocr_score": None,
            "character_scores": None,
            "frame_weights": frame_weights,
            "decoding": decoding,
        }

    return recognize
