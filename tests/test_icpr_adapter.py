"""Joint-five inference contract tests; synthetic weights except one labelled real track."""
import json
import math
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
import pytest
import torch

from app.recognition.ctc_decoders import (
    ctc_prefix_beam_search,
    ctc_prefix_beam_search_constrained,
    decode_track,
    is_valid_plate_format,
)
from app.recognition.icpr_adapter import (
    create_recognizer,
    decode_predictions,
    load_state,
    preprocess_frames,
    validate_config,
)
from app.recognition.icpr_model import Config, SingleLRLPRModel


@pytest.fixture(scope="module", autouse=True)
def limited_cpu_threads():
    before = torch.get_num_threads()
    torch.set_num_threads(2)
    yield
    torch.set_num_threads(before)


def _synthetic_state():
    model = SingleLRLPRModel()
    with torch.no_grad():
        for parameter in model.parameters():
            parameter.zero_()
        model.primary_head.bias[11] = 5  # class 11 = A; repeated logits collapse to A.
    return model.state_dict()


@pytest.fixture(scope="module")
def synthetic_checkpoint(tmp_path_factory):
    """Zero feature weights + forced A logit, saved like the notebook DDP output."""
    path = tmp_path_factory.mktemp("icpr-contract") / "synthetic.pt"
    state = {f"module.{key}": value for key, value in _synthetic_state().items()}
    state["module.sr_decoder.head.weight"] = torch.zeros(3, 32, 3, 3)  # training-only branch
    torch.save(state, path)
    return path


def test_preprocessing_matches_notebook_rgb_resize_normalization_and_order():
    rng = np.random.default_rng(47)
    images = [Image.fromarray(rng.integers(0, 256, (18 + i, 71 + i, 3), dtype=np.uint8))
              for i in range(5)]
    actual = preprocess_frames(images)
    assert actual.shape == (1, 5, 3, 48, 192)
    assert actual.dtype == torch.float32
    expected = np.stack([
        ((cv2.resize(np.asarray(image), (192, 48), interpolation=cv2.INTER_LINEAR)
          .astype(np.float64) / 255.0 - 0.5) / 0.5).transpose(2, 0, 1)
        for image in images
    ])
    np.testing.assert_allclose(actual[0].numpy(), expected, rtol=0, atol=1e-6)
    assert actual.min() >= -1 and actual.max() <= 1


@pytest.mark.parametrize("images", [[], [Image.new("RGB", (16, 8))],
    [Image.new("RGB", (16, 8)) for _ in range(4)],
    [Image.new("RGB", (16, 8)) for _ in range(6)],
    Image.new("RGB", (16, 8)), [Image.new("L", (16, 8)) for _ in range(5)]])
def test_preprocessing_rejects_missing_frames_and_wrong_color_mode(images):
    with pytest.raises(ValueError):
        preprocess_frames(images)


def _log_probs(indices, peak=10.0):
    logits = torch.full((len(indices), 37), -peak)
    for time, index in enumerate(indices):
        logits[time, index] = peak
    return torch.log_softmax(logits, dim=-1)


def test_greedy_ctc_preserves_repeats_separated_by_blank_and_zeros():
    # blank,A,A,blank,A,0,0,B,B,blank => AA0B. 0 is alphabet class 1.
    indices = [0, 11, 11, 0, 11, 1, 1, 12, 12, 0]
    assert decode_predictions(_log_probs(indices).unsqueeze(0)) == ["AA0B"]
    assert decode_predictions(torch.zeros((2, 48, 37))) == ["", ""]


@pytest.mark.parametrize("logits", [torch.zeros((1, 37)), torch.zeros((1, 48, 36)),
    torch.full((1, 48, 37), float("nan"))])
def test_decoder_rejects_wrong_output_or_non_finite_logits(logits):
    with pytest.raises((ValueError, FloatingPointError)):
        decode_predictions(logits)


@pytest.mark.parametrize("text, valid", [("ABC1234", True), ("ABC1D23", True),
    ("AB1234", False), ("ABCD234", False), ("abc1234", False), ("", False)])
def test_brazil_plate_formats(text, valid):
    assert is_valid_plate_format(text) is valid


def _chars(text):
    return [Config.CHARS.index(ch) + 1 for ch in text]


def test_beam_filter_prefers_valid_plate_format_over_higher_scoring_invalid_text():
    # Mostly "ABC123" (invalid, 6 chars) with a weaker 7th digit available at the end.
    sequence = [0] + sum(([c, 0] for c in _chars("ABC123")), [])
    logits = torch.full((len(sequence) + 2, 37), -8.0)
    for time, index in enumerate(sequence):
        logits[time, index] = 8.0
    logits[-2:, 0] = 2.0
    logits[-2, _chars("4")[0]] = 1.5
    lp = torch.log_softmax(logits, dim=-1)
    plain, _, _ = ctc_prefix_beam_search(lp.numpy(), Config.IDX2CHAR, 8, format_constrained=False)
    filtered, _, ok = ctc_prefix_beam_search(lp.numpy(), Config.IDX2CHAR, 8, format_constrained=True)
    assert plain == "ABC123"
    assert filtered == "ABC1234" and ok


def test_constrained_beam_only_emits_llldadd():
    lp = _log_probs([0] + sum(([c, 0] for c in _chars("ABC1D23")), []))
    text, score, ok = ctc_prefix_beam_search_constrained(lp.numpy(), Config.IDX2CHAR, beam_width=8)
    assert ok and text == "ABC1D23" and math.isfinite(score)


def test_decode_track_reports_uncalibrated_scores():
    lp = _log_probs([0] + sum(([c, 0] for c in _chars("ABC1234")), []), peak=3.0)
    result = decode_track(lp, "beam_filter", 8)
    assert result["plate_text"] == result["greedy_text"] == "ABC1234"
    assert result["format_valid"] is True
    assert 0 < result["greedy_symbol_confidence"] <= 1
    assert result["beam_confidence_proxy"] == pytest.approx(math.exp(result["beam_log_score"] / 7))
    greedy = decode_track(lp, "greedy", 8)
    assert greedy["beam_log_score"] is None and greedy["beam_confidence_proxy"] is None
    with pytest.raises(ValueError):
        decode_track(lp, "vote", 8)


def test_architecture_retains_exact_notebook_state_names_and_shapes():
    model = SingleLRLPRModel()
    state = model.state_dict()
    assert state["stn.fc_loc.0.weight"].shape == (64, 4096)
    assert state["backbone.layer1.2.conv1.weight"].shape == (64, 64, 3, 3)
    assert state["backbone.layer3.5.conv2.weight"].shape == (256, 256, 3, 3)
    assert state["backbone.layer4.0.conv1.weight"].shape == (512, 256, 3, 3)
    assert state["fusion.quality_conv.4.weight"].shape == (1, 64)
    assert state["fusion.col_score.3.weight"].shape == (1, 128, 1, 1)
    assert state["height_pool.flat_proj.weight"].shape == (512, 512 * 6)
    assert state["pos_encoder.pe"].shape == (1, 256, 512)
    assert state["encoder.layers.2.linear1.weight"].shape == (1024, 512)
    assert state["primary_head.weight"].shape == state["auxiliary_head.weight"].shape == (37, 512)
    assert model.backbone.layer4[0].conv1.stride == (2, 1)
    assert [len(model.backbone.layer1), len(model.backbone.layer2),
            len(model.backbone.layer3), len(model.backbone.layer4)] == [3, 4, 6, 3]
    assert not any(key.startswith("sr_decoder.") for key in state)
    model.eval()
    with torch.inference_mode():
        logits, weights = model(torch.zeros((1, 5, 3, 48, 192)))
    assert logits.shape == (1, 48, 37) and weights.shape == (1, 5)
    with pytest.raises(ValueError, match="Expected"):
        model(torch.zeros((1, 1, 3, 48, 192)))


def test_checkpoint_load_is_safe_strict_and_forward_has_no_invented_confidence(synthetic_checkpoint, monkeypatch):
    real_load = torch.load
    calls = []

    def observed_load(*args, **kwargs):
        calls.append(kwargs)
        return real_load(*args, **kwargs)

    monkeypatch.setattr(torch, "load", observed_load)
    recognize = create_recognizer({"checkpoint": str(synthetic_checkpoint), "device": "cpu",
                                   "config": {"decoder": "greedy"}})
    result = recognize([Image.new("RGB", (50 + index, 19), (20 * index, 100, 200))
                        for index in range(5)])
    assert calls == [{"map_location": "cpu", "weights_only": True}]
    assert result["raw_text"] == "A"  # forced synthetic head; not a real OCR accuracy assertion.
    assert result["ocr_score"] is None and result["character_scores"] is None
    assert result["frame_weights"] == pytest.approx([0.2] * 5)
    assert result["decoding"]["decoder"] == "greedy" and result["decoding"]["format_valid"] is False
    assert result["decoding"]["use_tta"] is False
    with pytest.raises(ValueError, match="exactly five"):
        recognize(Image.new("RGB", (50, 19)))


def test_default_decoder_is_notebook_beam_filter(synthetic_checkpoint):
    recognize = create_recognizer({"checkpoint": str(synthetic_checkpoint), "config": {}})
    decoding = recognize([Image.new("RGB", (40, 12)) for _ in range(5)])["decoding"]
    assert decoding["decoder"] == "beam_filter" and decoding["beam_width"] == 8


def test_checkpoint_checksum_mismatch_is_rejected_before_loading(synthetic_checkpoint, monkeypatch):
    monkeypatch.setattr(torch, "load", lambda *a, **k: pytest.fail("Must not load changed checkpoint"))
    with pytest.raises(ValueError, match="checksum"):
        create_recognizer({"checkpoint": str(synthetic_checkpoint), "sha256": "0" * 64})


def test_missing_model_keys_rejected_without_partial_loading(tmp_path):
    checkpoint = tmp_path / "incomplete.pt"
    torch.save({"primary_head.bias": torch.zeros(37)}, checkpoint)
    with pytest.raises(RuntimeError, match="Missing key"):
        create_recognizer({"checkpoint": str(checkpoint)})


def test_wrapped_state_dict_and_prefix_collisions(tmp_path):
    wrapped = tmp_path / "wrapped.pt"
    torch.save({"model_state_dict": {"_orig_mod.primary_head.bias": torch.zeros(37)}}, wrapped)
    assert list(load_state(wrapped)) == ["primary_head.bias"]
    duplicate = tmp_path / "duplicate.pt"
    torch.save({"module.primary_head.bias": torch.zeros(37), "primary_head.bias": torch.zeros(37)}, duplicate)
    with pytest.raises(ValueError, match="Duplicate"):
        load_state(duplicate)
    non_finite = tmp_path / "nan.pt"
    torch.save({"primary_head.bias": torch.full((37,), float("nan"))}, non_finite)
    with pytest.raises(ValueError, match="non-finite"):
        load_state(non_finite)


@pytest.mark.parametrize("config", [{"decoder": "vote"}, {"beam_width": 0}, {"beam_width": True},
    {"use_tta": "yes"}, {"IMG_WIDTH": 256}, {"unknown_preprocessing": "resize"}, None])
def test_conflicting_or_unknown_config_is_rejected(config):
    with pytest.raises(ValueError):
        validate_config(config)


def test_valid_config_fills_notebook_defaults():
    assert validate_config({}) == {"decoder": "beam_filter", "beam_width": 8, "use_tta": False}
    assert validate_config({"decoder": "beam_constrained", "beam_width": 4, "use_tta": True})["beam_width"] == 4


REAL_CHECKPOINT = Path(__file__).resolve().parents[1] / "models" / "icpr_resnet34c_single_model_best.pt"
REAL_SHA256 = "e934a8644f06e28631a291b01c04a95274a546c19013f874c8b1995b30423c9c"


@pytest.mark.skipif(not REAL_CHECKPOINT.is_file(), reason="trained checkpoint is not downloaded")
def test_trained_checkpoint_reads_labelled_icpr_track():
    """One labelled ICPR track (5 low-resolution crops); a regression check, not an accuracy score."""
    folder = Path(__file__).parent / "fixtures" / "test_track"
    expected = json.loads((folder / "annotations.json").read_text(encoding="utf-8"))["plate_text"]
    recognize = create_recognizer({"checkpoint": str(REAL_CHECKPOINT), "sha256": REAL_SHA256, "config": {}})
    images = [Image.open(folder / f"lr-{index:03d}.jpg").convert("RGB") for index in range(1, 6)]
    result = recognize(images)
    assert result["raw_text"] == expected == "BCY4440"
    assert result["decoding"]["format_valid"] is True
