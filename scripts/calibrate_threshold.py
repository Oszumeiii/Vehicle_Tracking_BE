"""Calibrate the live readable threshold: python -m scripts.calibrate_threshold --help.

Inputs come from `node dist/src/cli.js export-live-samples`: predictions.json as
exported and a ground-truth file an independent labeller completed (docs/EVALUATION.md).
"""

import argparse
import json
from pathlib import Path
import sys

from app.evaluation import calibrate_threshold


def run(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Precision/coverage of the readable status per confidence threshold.")
    parser.add_argument("--ground-truth", type=Path, required=True)
    parser.add_argument("--predictions", type=Path, required=True)
    parser.add_argument("--target-precision", type=float, default=0.95)
    parser.add_argument("--output", type=Path, help="Write JSON here; otherwise print to stdout.")
    args = parser.parse_args(argv)
    try:
        truth = json.loads(args.ground_truth.read_text(encoding="utf-8-sig"))
        predictions = json.loads(args.predictions.read_text(encoding="utf-8-sig"))
        report = calibrate_threshold(truth, predictions, target_precision=args.target_precision)
        output = json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
        if args.output:
            if args.output.resolve() in (args.ground_truth.resolve(), args.predictions.resolve()):
                raise ValueError("Output path must differ from input paths")
            args.output.write_text(output, encoding="utf-8")
        else:
            sys.stdout.write(output)
    except (OSError, ValueError) as exc:
        parser.exit(2, f"Calibration failed: {exc}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
