import json
from pathlib import Path

import torch

from app.models.config import Config
from app.models.decoder import decode_constrained
from app.models.model import load_model
from app.models.preprocessing import preprocess_image


def main():
    test_dir = Path(__file__).resolve().parent
    frame_paths = sorted(test_dir.glob("lr-*.jpg"))
    if len(frame_paths) != Config.NUM_FRAMES:
        raise ValueError(f"Expected {Config.NUM_FRAMES} frames, found {len(frame_paths)}")

    annotations = json.loads((test_dir / "annotations.json").read_text(encoding="utf-8"))
    expected_text = annotations["plate_text"]
    frames = torch.stack([preprocess_image(path.read_bytes()) for path in frame_paths]).unsqueeze(0)

    device = torch.device(Config.DEVICE)
    if device.type == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("MODEL_DEVICE is cuda, but CUDA is not available")
    model = load_model(Config.CHECKPOINT_PATH, device)

    with torch.inference_mode():
        logits, _, _, _, frame_weights = model(frames.to(device))

    predicted_text, score, valid = decode_constrained(logits, Config.IDX2CHAR)
    if not valid:
        raise RuntimeError("Constrained beam search found no candidate for the configured plate format")
    weights = frame_weights[0].float().cpu()
    if logits.shape[0] != 1 or weights.shape != (Config.NUM_FRAMES,):
        raise RuntimeError("Unexpected model output shape")
    if not torch.isfinite(weights).all() or not torch.isclose(weights.sum(), torch.tensor(1.0), atol=1e-5):
        raise RuntimeError("Frame fusion weights must be finite and sum to 1")
    if not predicted_text:
        raise RuntimeError("Model returned an empty plate prediction")

    matching_characters = sum(
        predicted == expected
        for predicted, expected in zip(predicted_text, expected_text)
    )
    character_accuracy = matching_characters / max(len(predicted_text), len(expected_text))

    print(f"Frames: {', '.join(path.name for path in frame_paths)}")
    print(f"Expected: {expected_text}")
    print(f"Predicted: {predicted_text}")
    print(f"Exact match: {predicted_text == expected_text}")
    print(f"Character accuracy: {character_accuracy:.1%}")
    print(f"Beam score: {score:.6f}")
    print(f"Frame weights: {weights.tolist()}")


if __name__ == "__main__":
    main()