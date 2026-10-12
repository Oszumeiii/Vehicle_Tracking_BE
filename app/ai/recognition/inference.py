import hashlib
import math
import threading
import time

import cv2
import numpy as np
import torch
from torch.nn import functional as F

from app.ai.recognition.config import Config as ModelConfig
from app.ai.recognition.decoder import (
    ctc_prefix_beam_search,
    ctc_prefix_beam_search_constrained,
    ctc_prefix_beam_search_nbest,
    decode_greedy,
    is_valid_plate_format,
)
from app.ai.recognition.errors import InferenceBusy, InferenceUnavailable, NoValidPlateCandidate
from app.ai.recognition.model import SingleLRLPRModel, load_model
from app.ai.recognition.preprocessing import decode_image, preprocess_bgr
from app.ai.settings import Settings

TTA_VARIANTS = ((1., 0., 0.), (1., .03, 0.), (1., -.03, 0.), (.96, 0., 0.), (1.04, 0., 0.))


def select_device(value: str) -> torch.device:
    if value == 'auto':
        value = 'cuda:0' if torch.cuda.is_available() else 'cpu'
    device = torch.device(value)
    if device.type not in ('cpu', 'cuda'):
        raise ValueError('DEVICE must be auto, cpu, cuda or cuda:N.')
    if device.type == 'cuda':
        if not torch.cuda.is_available():
            raise RuntimeError('CUDA was requested but is not available.')
        index = device.index if device.index is not None else 0
        if index >= torch.cuda.device_count():
            raise RuntimeError(f'CUDA device {index} does not exist.')
        return torch.device(f'cuda:{index}')
    return device


def affine_variant(images, scale, tx, ty):
    b, t, c, h, w = images.shape
    x = images.float().reshape(b * t, c, h, w)
    theta = torch.tensor([[scale, 0., tx], [0., scale, ty]], device=x.device, dtype=torch.float32)
    grid = F.affine_grid(theta[None].expand(b * t, -1, -1), x.size(), align_corners=False)
    warped = F.grid_sample(x, grid, mode='bilinear', padding_mode='border', align_corners=False)
    return warped.view(b, t, c, h, w).to(images.dtype)


def _decode_prediction(log_probs, settings):
    decoder = settings.decoder
    if decoder == "greedy":
        text = decode_greedy(torch.from_numpy(log_probs)[None, ...], ModelConfig.IDX2CHAR)
        valid = is_valid_plate_format(text, ModelConfig.PLATE_POSITION_CLASSES)
        return text, None, valid, None
    if decoder == "beam_plain":
        candidates = ctc_prefix_beam_search_nbest(
            log_probs, ModelConfig.IDX2CHAR, beam_width=settings.beam_width
        )
        text, score = candidates[0] if candidates else ("", -1e9)
        valid = is_valid_plate_format(text, ModelConfig.PLATE_POSITION_CLASSES)
        return text, score, valid, None
    if decoder == "beam_filter":
        unconstrained = ctc_prefix_beam_search_nbest(
            log_probs, ModelConfig.IDX2CHAR, beam_width=settings.beam_width
        )
        best_score = unconstrained[0][1] if unconstrained else -1e9
        text, score, valid = ctc_prefix_beam_search(
            log_probs, ModelConfig.IDX2CHAR, beam_width=settings.beam_width,
            format_constrained=True,
        )
        relative_score = math.exp(min(0.0, score - best_score)) if valid else 0.0
        return text, score, valid and relative_score >= settings.min_beam_score, relative_score
    return ctc_prefix_beam_search_constrained(
        log_probs,
        ModelConfig.IDX2CHAR,
        position_classes=ModelConfig.PLATE_POSITION_CLASSES,
        beam_width=settings.beam_width,
    ) + (None,)


class PlateRecognizer:
    def __init__(self, settings: Settings | None = None):
        self.settings = settings or Settings()
        self.device = select_device(self.settings.device)
        self.device_label = str(self.device)
        torch.set_num_threads(self.settings.cpu_threads)
        cv2.setNumThreads(0)
        model = load_model(self.settings.model_path, self.device)
        model.requires_grad_(False)
        self.model: SingleLRLPRModel | None = model
        self.amp = self.settings.use_amp and self.device.type == 'cuda'
        self.lock = threading.Lock()
        digest = hashlib.sha256()
        model_files = (
            sorted(
                path for path in self.settings.model_path.rglob('*')
                if path.is_file() and not path.is_symlink() and path.name != '.DS_Store'
            )
            if self.settings.model_path.is_dir()
            else [self.settings.model_path]
        )
        for path in model_files:
            digest.update(path.name.encode('utf-8'))
            with path.open('rb') as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b''):
                    digest.update(chunk)
        self.model_id = digest.hexdigest()[:16]

    def predict_bytes(self, payloads: list[bytes]) -> dict:
        if len(payloads) != 5:
            raise ValueError('Exactly five images from one track are required.')
        if any(not data or len(data) > self.settings.max_file_bytes for data in payloads):
            raise ValueError('Empty or oversized image.')
        if not self.lock.acquire(blocking=False):
            raise InferenceBusy('Model is busy. Retry this track shortly.')
        try:
            start = time.perf_counter()
            frames = [
                decode_image(data, self.settings.max_image_pixels)
                for data in payloads
            ]
            return self._predict(frames, start)
        finally:
            self.lock.release()

    def predict_bgr(self, frames: list[np.ndarray]) -> dict:
        """Use directly with five cv2 crops collected by your tracking worker."""
        if not self.lock.acquire(blocking=False):
            raise InferenceBusy('Model is busy. Retry this track shortly.')
        try:
            return self._predict(frames, time.perf_counter())
        finally:
            self.lock.release()

    @torch.inference_mode()
    def _predict(self, frames, start):
        try:
            images = torch.from_numpy(preprocess_bgr(frames)).to(self.device)
            variants = TTA_VARIANTS if self.settings.use_tta else TTA_VARIANTS[:1]
            log_probs, original_weights = [], None
            if self.model is None:
                raise InferenceUnavailable('The inference model has been closed.')
            for index, (scale, tx, ty) in enumerate(variants):
                x = images if index == 0 else affine_variant(images, scale, tx, ty)
                with torch.autocast(device_type=self.device.type, dtype=torch.float16, enabled=self.amp):
                    logits, weights = self.model(x, return_aux=False, return_weights=True)
                log_probs.append(F.log_softmax(logits.float(), dim=-1))
                if index == 0:
                    original_weights = weights[0].float().cpu().tolist()
            averaged = F.log_softmax(torch.stack(log_probs).mean(0), dim=-1)
            # .cpu() synchronizes GPU completion before timings and decoding.
            lp = averaged[0].cpu().numpy()
            text, score, valid, relative_beam_score = _decode_prediction(lp, self.settings)
            if not valid:
                raise NoValidPlateCandidate('No candidate matched the configured plate format.')
            return {
                'text': text,
                'ctc_log_probability': score,
                'relative_beam_score': relative_beam_score,
                'frame_weights': original_weights,
                'num_frames': 5,
                'device': self.device_label,
                'model_id': self.model_id,
                'tta': self.settings.use_tta,
                'processing_ms': round((time.perf_counter() - start) * 1000, 3),
            }
        except torch.cuda.OutOfMemoryError as exc:
            raise InferenceUnavailable('GPU memory exhausted; reduce concurrent GPU workloads.') from exc

    def close(self):
        self.model = None
