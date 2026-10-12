from io import BytesIO
import warnings

import cv2
import numpy as np
import torch
from PIL import Image, UnidentifiedImageError

from app.ai.recognition.config import Config
from app.ai.recognition.errors import InvalidImage
from app.ai.recognition.model import Config as ArchitectureConfig


HEIGHT = ArchitectureConfig.IMG_HEIGHT
WIDTH = ArchitectureConfig.IMG_WIDTH
NUM_FRAMES = ArchitectureConfig.NUM_FRAMES


def decode_image(payload: bytes, max_pixels: int = Config.MAX_IMAGE_PIXELS) -> np.ndarray:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(BytesIO(payload)) as probe:
                if probe.format not in ('JPEG', 'PNG'):
                    raise InvalidImage('Only JPEG and PNG plate crops are accepted.')
                width, height = probe.size
                if width < 1 or height < 1 or width * height > max_pixels:
                    raise InvalidImage(f'Image exceeds the {max_pixels}-pixel limit.')
                probe.verify()
    except InvalidImage:
        raise
    except (UnidentifiedImageError, OSError, ValueError,
            Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise InvalidImage('Invalid or damaged image.') from exc
    # Match cv2.imread(..., IMREAD_COLOR) used by the training notebook.
    image = cv2.imdecode(np.frombuffer(payload, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise InvalidImage('OpenCV could not decode the image.')
    if image.shape[0] * image.shape[1] > max_pixels:
        raise InvalidImage('Decoded image is too large.')
    return image


def _preprocess_frame_bgr(frame: np.ndarray) -> np.ndarray:
    if (not isinstance(frame, np.ndarray) or frame.dtype != np.uint8
            or frame.ndim != 3 or frame.shape[2] != 3
            or min(frame.shape[:2]) < 1):
        raise InvalidImage('Each crop must be a nonempty uint8 BGR image with 3 channels.')
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    resized = cv2.resize(rgb, (WIDTH, HEIGHT), interpolation=cv2.INTER_LINEAR)
    image = (resized.astype(np.float32) - 127.5) * np.float32(1.0 / 127.5)
    return np.ascontiguousarray(image.transpose(2, 0, 1))


def preprocess_bgr(frames: list[np.ndarray]) -> np.ndarray:
    """BGR crops -> RGB, INTER_LINEAR resize, [-1,1], [1,5,3,48,192]."""
    if len(frames) != NUM_FRAMES:
        raise InvalidImage('Exactly five crops from one track are required.')
    return np.ascontiguousarray(np.stack([_preprocess_frame_bgr(frame) for frame in frames])[None])


def preprocess_image(
    image_bytes: bytes,
    max_pixels: int = Config.MAX_IMAGE_PIXELS,
) -> torch.Tensor:
    """Decode one uploaded frame and return its normalized [3,H,W] tensor."""
    return torch.from_numpy(_preprocess_frame_bgr(decode_image(image_bytes, max_pixels)))
