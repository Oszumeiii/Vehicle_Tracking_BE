"""Run the configured SVTR OCR checkpoint on labelled local five-frame tracks."""
import argparse
import importlib.metadata
import json
from pathlib import Path
import platform

import cv2
import torch

from app.recognition.fusion import PlateFusion
from app.recognition.registry import PipelineRegistry
from app.recognition.runner import PredictionRunner, RecognitionRunner


class TrackEvaluator:
    """Load one configured recognizer and compare every track with its annotation."""

    def __init__(self, config, pipeline_id, device="cpu"):
        pipelines = json.loads(config.read_text(encoding="utf-8"))["pipelines"]
        self.pipeline = next((row for row in pipelines if row["id"] == pipeline_id), None)
        if self.pipeline is None or self.pipeline.get("task") != "recognize":
            raise ValueError("Select a recognition pipeline from the config")
        spec = dict(self.pipeline["recognizer"])
        for key in ("checkpoint", "module_root"):
            spec[key] = str((config.parent / spec[key]).resolve())
        self.checkpoint = Path(spec["checkpoint"])
        self.device = device
        # Resolve the same class factory as the upload runner, without a detector:
        # test_tracks contains plate crops that are already grouped by track.
        import sys

        sys.path.insert(0, spec["module_root"])
        _, self.recognizer = RecognitionRunner.load_models({
            "input_mode": "plate_crop",
            "pipeline_snapshot": {**self.pipeline, "recognizer": spec, "device": device},
        })

    def evaluate(self, root):
        annotations = sorted(root.rglob("annotations.json"))
        if not annotations:
            raise ValueError(f"No annotated tracks under {root}")
        rows = []
        for annotation in annotations:
            truth = json.loads(annotation.read_text(encoding="utf-8-sig")).get("plate_text")
            if not isinstance(truth, str) or not PlateFusion.normalize_plate(truth):
                raise ValueError(f"Missing plate_text: {annotation}")
            truth = PlateFusion.normalize_plate(truth)
            frames = sorted(annotation.parent.glob("lr-*.jpg"))
            if len(frames) != 5:
                raise ValueError(f"Expected five lr-*.jpg crops in {annotation.parent}")
            prediction = PredictionRunner.predict_joint(self.recognizer, frames, root)
            text = prediction["normalized_text"]
            rows.append({
                "track": annotation.parent.relative_to(root).as_posix(),
                "expected": truth,
                "prediction": prediction,
                "exact_match": text == truth,
                "character_errors": PlateFusion.levenshtein(text, truth),
                "evidence_sha256": {
                    path.relative_to(root).as_posix(): PipelineRegistry.digest(path)
                    for path in [annotation, *frames]
                },
            })
        correct = sum(row["exact_match"] for row in rows)
        return {
            "pipeline_id": self.pipeline["id"],
            "factory": self.pipeline["recognizer"]["factory"],
            "checkpoint": self.checkpoint.name,
            "checkpoint_sha256": PipelineRegistry.digest(self.checkpoint),
            "device": self.device,
            "runtime": {"python": platform.python_version(), "opencv": cv2.__version__, **{
                name: importlib.metadata.version(name)
                for name in ("torch", "numpy", "Pillow")
            }},
            "tracks": len(rows),
            "correct": correct,
            "exact_accuracy": correct / len(rows),
            "character_error_rate": sum(row["character_errors"] for row in rows)
            / sum(len(row["expected"]) for row in rows),
            "results": rows,
        }

    @classmethod
    def main(cls, argv=None):
        repo = Path(__file__).resolve().parents[1]
        parser = argparse.ArgumentParser(description=__doc__)
        parser.add_argument("--tracks", type=Path, default=repo / "data/test_tracks")
        parser.add_argument("--config", type=Path, default=repo / "config/pipelines.kaggle.json")
        parser.add_argument("--pipeline", default="pbl6-svtrv2-regional-joint5-v1")
        parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
        parser.add_argument("--output", type=Path)
        args = parser.parse_args(argv)
        previous_threads = torch.get_num_threads()
        try:
            if args.device == "cpu":
                torch.set_num_threads(1)
            evaluator = cls(args.config.resolve(), args.pipeline, args.device)
            result = evaluator.evaluate(args.tracks.resolve())
            output = json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
            if args.output:
                args.output.parent.mkdir(parents=True, exist_ok=True)
                args.output.write_text(output, encoding="utf-8")
            print(output, end="")
            return 0
        finally:
            torch.set_num_threads(previous_threads)


if __name__ == "__main__":
    raise SystemExit(TrackEvaluator.main())
