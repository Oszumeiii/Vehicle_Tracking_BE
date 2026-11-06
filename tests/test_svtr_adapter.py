"""Inference contract tests for the supplied SVTRv2 regional checkpoint."""
from pathlib import Path

from PIL import Image
import pytest
import torch

from app.recognition.svtr_adapter import SVTRRecognizer
from scripts.evaluate_test_tracks import TrackEvaluator

CHECKPOINT = (
    Path(__file__).resolve().parents[1]
    / "models"
    / "single_model_best_svtrv2_base_regional_pool_warmup_v1.pt"
)
CHECKPOINT_SHA256 = "fe1e58e5fb5938b83cc4ddac1e5bad62c2bbcbd2dd4bb925043913601db5e8d1"


def test_preprocess_preserves_aspect_ratio_and_pads_to_training_dimensions():
    images = [Image.new("RGB", (160, 40), (255, 0, 0)) for _ in range(5)]

    tensor = SVTRRecognizer.preprocess_frames(images)

    assert tuple(tensor.shape) == (1, 5, 3, 40, 128)
    assert tensor.dtype == torch.float32
    assert tensor[0, 0, 0, 0, 0].item() == pytest.approx(
        (128 / 255 - 0.5) / 0.5, abs=1e-6
    )
    assert tensor[0, 0, 0, 20, 64].item() == pytest.approx(1.0)
    assert tensor[0, 0, 1, 20, 64].item() == pytest.approx(-1.0)


def test_configured_checkpoint_recognizes_labelled_test_track():
    if not CHECKPOINT.is_file():
        pytest.skip("Optional SVTR best checkpoint is not present.")

    with CHECKPOINT.open("rb") as source:
        import hashlib

        assert hashlib.file_digest(source, "sha256").hexdigest() == CHECKPOINT_SHA256

    previous_threads = torch.get_num_threads()
    torch.set_num_threads(1)
    try:
        repo = Path(__file__).resolve().parents[1]
        evaluator = TrackEvaluator(
            repo / "config/pipelines.kaggle.json", "pbl6-svtrv2-regional-joint5-v1"
        )
        assert evaluator.recognizer.__class__.__name__ == "SVTRRecognizer"
        report = evaluator.evaluate(repo / "data/test_tracks")
    finally:
        torch.set_num_threads(previous_threads)

    assert report["checkpoint_sha256"] == CHECKPOINT_SHA256
    assert report["tracks"] == report["correct"] == 1
    assert report["exact_accuracy"] == 1.0
    assert report["character_error_rate"] == 0.0
    result = report["results"][0]["prediction"]
    assert result["normalized_text"] == "BCY4440"
    assert result["input_storage_keys"] == [f"lr-{i:03d}.jpg" for i in range(1, 6)]
    assert result["ocr_score"] is None
    assert len(result["frame_weights"]) == 5
    assert sum(result["frame_weights"]) == pytest.approx(1.0)
    assert result["decoding"]["decoder"] == "beam_filter"
    assert result["decoding"]["use_tta"] is False
