"""YOLO detection stage module."""

from pathlib import Path
import hashlib
from typing import Any
from huggingface_hub import hf_hub_download
from ultralytics import YOLO
from ultralytics.engine.results import Results
import numpy as np


def select_model(model_name: str) -> dict:
    """Chọn cấu hình (spec) của YOLO model dựa trên tên được cung cấp."""
        
    match model_name:
        case "yolo11l":
            return {
                'repo': 'morsetechlab/yolov11-license-plate-detection',
                'filename': 'license-plate-finetune-v1l.pt',
                'revision': '251a30d7daedca065f56e04b0af04052c907c68f',
            }
        case "yolov8" | "yolo11n" | "yolo26n":
            return {
                'repo': 'morsetechlab/yolov11-license-plate-detection',
                'filename': 'license-plate-finetune-v1n.pt',
                'revision': '251a30d7daedca065f56e04b0af04052c907c68f',
            }
        case "yolo11m":
            return {
                'repo': 'morsetechlab/yolov11-license-plate-detection',
                'filename': 'license-plate-finetune-v1m.pt',
                'revision': '251a30d7daedca065f56e04b0af04052c907c68f',
            }
        case _:
            raise ValueError(f"Unsupported model: {model_name}")


def sha256_file(path: str | Path) -> str:
    """Tính mã hash SHA256 của file checkpoint để kiểm tra tính toàn vẹn."""
    sha256 = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            sha256.update(chunk)
    return sha256.hexdigest()


class YoloDetector:
    """Trình phát hiện biển số xe sử dụng YOLO."""

    def __init__(
        self, 
        cache_dir: str | Path, 
        model_name: str = "yolo11n",
        confidence: float = 0.25,
        device: str = "cpu", 
        imgsz: int = 1280
    ):
        self.cache_dir = Path(cache_dir)
        self.model_name = model_name
        self.confidence = confidence
        self.device = device
        self.imgsz = imgsz
        
        # Lấy thông tin cấu hình model dựa trên model_name
        self.yolo_spec = select_model(model_name)
        
        # Tải mô hình và lấy thông tin spec kèm mã hash
        self.model, self.spec = self._load_plate_detector()

    def _load_plate_detector(self) -> tuple[YOLO, dict]:
        """Tải checkpoint từ Hugging Face Hub và kiểm tra class."""
        path = hf_hub_download(
            repo_id=self.yolo_spec['repo'],
            filename=self.yolo_spec['filename'],
            revision=self.yolo_spec['revision'],
            cache_dir=str(self.cache_dir)
        )
        model = YOLO(path)
        if model.names != {0: 'License_Plate'}:
            raise RuntimeError(f"Checkpoint không đúng class biển số: {model.names}")
            
        spec_with_hash = dict(self.yolo_spec, weight_sha256=sha256_file(path))
        return model, spec_with_hash

    def detect(self, images: list[np.ndarray]) -> list[Any]:
        """Phát hiện biển số xe trên danh sách các khung hình (images) và lọc kết quả."""
        results = self.model.predict(
            images,
            imgsz=self.imgsz,
            conf=self.confidence,
            iou=0.7,
            device=self.device,
            verbose=False,
            max_det=100,
            rect=True
        )
        
        boxes_list = []
        # if len(results) != len(images):
        #     raise RuntimeError("YOLO returned a different number of results than input frames.")
        for result, image in zip(results, images, strict=True):
            if not isinstance(result, Results):
                raise TypeError(f"Expected an Ultralytics Results object, received {type(result).__name__}.")
            if result.boxes is None:
                raise RuntimeError("YOLO result does not contain bounding boxes.")
            b = result.boxes.cpu().numpy()
            if len(b):
                h, w = image.shape[:2]
                a = b.data[:, :4]
                bw = a[:, 2] - a[:, 0]
                bh = a[:, 3] - a[:, 1]
                ratio = bw / np.maximum(bh, 1e-9)
                
                # Lọc các bounding box thỏa mãn điều kiện hình học & kích thước
                keep = (
                    np.isfinite(a).all(axis=1) & 
                    (a[:, 0] >= 0) & (a[:, 1] >= 0) &
                    (a[:, 2] <= w) & (a[:, 3] <= h) & 
                    (bw >= 12) & (bh >= 5) &
                    (ratio >= 1.1) & (ratio <= 7)
                )
                b = b[keep]
            boxes_list.append(b)
            
        return boxes_list