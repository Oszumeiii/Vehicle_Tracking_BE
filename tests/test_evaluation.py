import json

import pytest

from app.evaluation import evaluate_recognition, levenshtein, normalize_plate
from scripts.evaluate_recognition import run


def sample(sample_id="sample-1", plate_text="ABC1234", **kwargs):
    return {"sample_id": sample_id, "source_id": f"source-{sample_id}",
            "plate_text": plate_text, "split": "test", **kwargs}


def prediction(sample_id="sample-1", plate_text="ABC1234", **kwargs):
    return {"sample_id": sample_id, "variant": "single_image", "detected": True,
            "plate_text": plate_text, **kwargs}


def evaluate(samples, predictions, **kwargs):
    return evaluate_recognition({"samples": samples}, {"predictions": predictions}, **kwargs)


def test_end_to_end_and_conditional_metrics_include_missed_and_unreadable_samples():
    result = evaluate(
        [sample("a", "ABC1234"), sample("b", "DEF5678"), sample("c", "GHI9012"), sample("d", "JKL3456")],
        [prediction("a", "abc-1234", latency_ms=10), prediction("b", "DEF5679", latency_ms=20),
         prediction("c", None, latency_ms=30)],
    )["variants"]["single_image"]
    assert result["prediction_count"] == 3
    assert result["missing_prediction_count"] == 1
    assert result["missed_detection_count"] == 1
    assert result["detected_count"] == 3
    assert result["detection_rate"] == 0.75
    assert result["end_to_end"] == {
        "sample_count": 4, "exact_matches": 1, "exact_accuracy": 0.25,
        "character_errors": 15, "reference_characters": 28, "cer": 15 / 28,
        "unreadable_count": 2, "unreadable_rate": 0.5,
    }
    assert result["recognizer_conditional"]["exact_accuracy"] == 1 / 3
    assert result["recognizer_conditional"]["cer"] == 8 / 21
    assert result["recognizer_conditional"]["unreadable_rate"] == 1 / 3
    assert result["latency_ms"] == {"count": 3, "mean": 20, "p50": 20, "p95": 30}


def test_explicit_detection_failure_is_excluded_from_conditional_ocr_only():
    result = evaluate([sample()], [prediction(detected=False, plate_text=None, latency_ms=9)])
    variant = result["variants"]["single_image"]
    assert variant["missing_prediction_count"] == 0
    assert variant["missed_detection_count"] == 1
    assert variant["end_to_end"]["exact_accuracy"] == 0
    assert variant["end_to_end"]["cer"] == 1
    assert variant["end_to_end"]["unreadable_rate"] == 1
    assert variant["recognizer_conditional"]["exact_accuracy"] is None
    assert variant["recognizer_conditional"]["cer"] is None
    assert variant["recognizer_conditional"]["unreadable_rate"] is None
    assert variant["latency_ms"]["mean"] == 9


def test_variants_are_independent_and_absent_predictions_do_not_disappear():
    result = evaluate([sample()], [prediction(variant="five_image")])
    assert result["variants"]["five_image"]["end_to_end"]["exact_accuracy"] == 1
    for variant in ("single_image", "enhanced"):
        assert result["variants"][variant]["end_to_end"]["sample_count"] == 1
        assert result["variants"][variant]["end_to_end"]["exact_accuracy"] == 0
        assert result["variants"][variant]["latency_ms"]["mean"] is None


def test_normalization_preserves_character_identity():
    assert normalize_plate(" aBc - 1.234\n") == "ABC1.234"
    assert normalize_plate("OI12345") != normalize_plate("0112345")
    metrics = evaluate([sample(plate_text="AOI1234")], [prediction(plate_text="A011234")])
    assert metrics["variants"]["single_image"]["end_to_end"]["character_errors"] == 2


@pytest.mark.parametrize(("reference", "hypothesis", "distance"), [
    ("", "", 0), ("ABC", "", 3), ("", "ABC", 3), ("ABC", "ABCD", 1),
    ("ABC", "AC", 1), ("ABC", "ADC", 1), ("kitten", "sitting", 3),
])
def test_levenshtein(reference, hypothesis, distance):
    assert levenshtein(reference, hypothesis) == distance


def test_cer_can_exceed_one_for_insertions_and_uses_corpus_denominator():
    metrics = evaluate([sample(plate_text="AB")], [prediction(plate_text="ABCDEFG")])
    assert metrics["variants"]["single_image"]["end_to_end"]["cer"] == 2.5


@pytest.mark.parametrize("field", ["source_id", "plate_identity"])
def test_split_leakage_is_rejected_before_selected_split_filter(field):
    samples = [sample("a", split="train", **{field: "shared"}),
               sample("b", split="validation", **{field: "shared"})]
    with pytest.raises(ValueError, match=f"Split leakage for {field}"):
        evaluate(samples, [], split="test")


def test_same_source_and_identity_can_have_multiple_samples_in_one_split():
    report = evaluate([sample("a", source_id="same", plate_identity="same"),
                       sample("b", source_id="same", plate_identity="same")], [])
    assert report["sample_count"] == 2


def test_duplicate_ground_truth_and_prediction_ids_are_rejected():
    with pytest.raises(ValueError, match="Duplicate ground-truth"):
        evaluate([sample(), sample()], [])
    with pytest.raises(ValueError, match="Duplicate prediction"):
        evaluate([sample()], [prediction(), prediction()])


def test_prediction_sample_must_exist_in_ground_truth():
    with pytest.raises(ValueError, match="unknown sample_id"):
        evaluate([sample()], [prediction("unknown")])


@pytest.mark.parametrize("fields", [
    {"latency_ms": -1}, {"latency_ms": float("nan")}, {"latency_ms": float("inf")},
    {"latency_ms": True}, {"detected": "true"}, {"detected": False},
    {"plate_text": 1234}, {"variant": "best"},
])
def test_invalid_prediction_fields_are_rejected(fields):
    with pytest.raises(ValueError):
        evaluate([sample()], [prediction(**fields)])


@pytest.mark.parametrize("fields", [
    {"sample_id": " "}, {"source_id": ""}, {"split": ""}, {"plate_text": " - "},
    {"plate_text": None}, {"crop_width": 0}, {"crop_height": True}, {"plate_identity": ""},
])
def test_invalid_ground_truth_fields_are_rejected(fields):
    with pytest.raises(ValueError):
        evaluate([sample(**fields)], [])


def test_empty_denominators_are_null_and_filtering_is_explicit():
    result = evaluate([sample(split="train")], [prediction()])
    assert result["sample_count"] == 0
    for variant in result["variants"].values():
        assert variant["end_to_end"]["exact_accuracy"] is None
        assert variant["end_to_end"]["cer"] is None
        assert variant["end_to_end"]["unreadable_rate"] is None
        assert variant["detection_rate"] is None
        assert variant["latency_ms"]["p95"] is None
    assert evaluate([sample(split="train")], [prediction()], split=None)["sample_count"] == 1


def test_crop_size_grouping_uses_original_ground_truth_dimensions():
    report = evaluate([sample("a", crop_width=63), sample("b", crop_width=64),
                       sample("c", crop_width=127), sample("d", crop_width=128), sample("e")],
                      [prediction("a")], group_by_crop_size=True)
    groups = report["variants"]["single_image"]["by_crop_width"]
    assert groups["width_lt_64"]["end_to_end"]["sample_count"] == 1
    assert groups["width_64_127"]["end_to_end"]["sample_count"] == 2
    assert groups["width_ge_128"]["end_to_end"]["sample_count"] == 1
    assert groups["unknown"]["end_to_end"]["sample_count"] == 1


def test_cli_reads_independent_files_and_writes_report(tmp_path, capsys):
    truth = tmp_path / "truth.json"
    predictions = tmp_path / "predictions.json"
    output = tmp_path / "report.json"
    truth.write_text(json.dumps({"samples": [sample()]}), encoding="utf-8")
    predictions.write_text(json.dumps({"predictions": [prediction()]}), encoding="utf-8")
    arguments = ["--ground-truth", str(truth), "--predictions", str(predictions)]
    assert run([*arguments, "--output", str(output)]) == 0
    assert json.loads(output.read_text(encoding="utf-8"))["sample_count"] == 1
    assert run(arguments) == 0
    assert json.loads(capsys.readouterr().out)["sample_count"] == 1
    with pytest.raises(SystemExit) as exc:
        run([*arguments, "--output", str(truth)])
    assert exc.value.code == 2
    assert "samples" in json.loads(truth.read_text(encoding="utf-8"))


def test_cli_rejects_invalid_input_without_writing_report(tmp_path):
    truth = tmp_path / "truth.json"
    predictions = tmp_path / "predictions.json"
    output = tmp_path / "report.json"
    truth.write_text('{"samples": []}', encoding="utf-8")
    predictions.write_text('{"predictions": [', encoding="utf-8")
    with pytest.raises(SystemExit) as exc:
        run(["--ground-truth", str(truth), "--predictions", str(predictions), "--output", str(output)])
    assert exc.value.code == 2
    assert not output.exists()
