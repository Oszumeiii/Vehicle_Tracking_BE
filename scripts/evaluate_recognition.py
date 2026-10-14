"""Run offline evaluation: python -m scripts.evaluate_recognition --help."""

import argparse
import json
from pathlib import Path
import sys

from app.evaluation import evaluate_recognition


def run(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Evaluate independent plate ground truth against machine predictions.")
    parser.add_argument("--ground-truth", type=Path, required=True)
    parser.add_argument("--predictions", type=Path, required=True)
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument("--split", default="test", help="Split to evaluate (default: test).")
    selection.add_argument("--all-splits", action="store_true", help="Evaluate all splits after leakage checks.")
    parser.add_argument("--group-by-crop-size", action="store_true")
    parser.add_argument("--output", type=Path, help="Write JSON here; otherwise print to stdout.")
    args = parser.parse_args(argv)
    try:
        truth = json.loads(args.ground_truth.read_text(encoding="utf-8-sig"))
        predictions = json.loads(args.predictions.read_text(encoding="utf-8-sig"))
        report = evaluate_recognition(truth, predictions, split=None if args.all_splits else args.split,
                                      group_by_crop_size=args.group_by_crop_size)
        output = json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
        if args.output:
            if args.output.resolve() in (args.ground_truth.resolve(), args.predictions.resolve()):
                raise ValueError("Output path must differ from input paths")
            args.output.write_text(output, encoding="utf-8")
        else:
            sys.stdout.write(output)
    except (OSError, ValueError) as exc:
        parser.exit(2, f"Evaluation failed: {exc}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
