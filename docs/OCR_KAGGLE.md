# SVTRv2 OCR model

The active video-recognition profile is `pbl6-svtrv2-regional-joint5-v1` in
[`config/pipelines.kaggle.json`](../config/pipelines.kaggle.json). It passes five
ordered RGB crops from a video track to SVTRv2-Base regional and returns one
joint prediction. The old SE-ResNet34-C adapter remains in the source only to
support older pipeline snapshots; its accuracy and confidence calibration do not
apply to this model.

## Checkpoint

The checkpoint is tracked with Git LFS (107,437,431 bytes exceeds
[GitHub's 100 MiB regular-file limit](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github)). After installing Git LFS, run `git lfs install`
and `git lfs pull` to materialize the weights at:

```text
models/single_model_best_svtrv2_base_regional_pool_warmup_v1.pt
```

Verify the exact file before running a recognition profile:

| File | SHA-256 | Size |
| --- | --- | --- |
| `single_model_best_svtrv2_base_regional_pool_warmup_v1.pt` | `fe1e58e5fb5938b83cc4ddac1e5bad62c2bbcbd2dd4bb925043913601db5e8d1` | 107,437,431 bytes |

```powershell
Get-FileHash models/single_model_best_svtrv2_base_regional_pool_warmup_v1.pt -Algorithm SHA256
```

The profile pins this checksum. A missing or mismatched checkpoint makes the
profile report `ready=false`, and job creation returns `503`. Provenance for the
checkpoint is recorded in [`models/icpr-source.json`](../models/icpr-source.json).

## Model and preprocessing

The `svtr_adapter:SVTRRecognizer` class owns the loaded model, device and decoder
settings; calling the instance recognizes one five-frame track. The old
`create_recognizer` name aliases this class for persisted snapshots.
The inference implementation is in `app/recognition/svtr_adapter.py`,
`svtr_config.py`, `svtr_backbone.py`, and `svtr_model.py`. The model uses an
STN, SVTRv2-Base backbone, regional evidence fusion and height pooling, with a
37-class CTC output (blank plus `0-9A-Z`). The input is exactly five ordered
frames.

Each PIL RGB crop is resized with aspect ratio preserved to fit a 128×40 canvas.
Unused pixels are gray (RGB 128), and OpenCV `INTER_LINEAR` resizing is followed
by normalization to `[-1, 1]`, then HWC-to-CHW conversion. The resulting tensor
has shape `[1, 5, 3, 40, 128]`. CUDA inference uses float16 autocast; CPU uses
float32.

The adapter loads tensor-only checkpoints with `torch.load(weights_only=True)`,
checks the pinned SHA-256, and requires a strict state-dict match. Decoder
configuration supports `greedy`, `beam_plain`, `beam_filter`, and
`beam_constrained`; the profile uses `beam_filter` with beam width 8. Unsupported
configuration values, including TTA, are rejected.

The output includes one `raw_text`, `decoding` metadata, and five normalized
`frame_weights`. The regional fusion may reserve weight for an unknown feature;
the adapter normalizes the relative weights over the five input frames to meet
the worker contract. `frame_weights` are not confidence scores.
`beam_confidence_proxy` is a ranking heuristic, not a calibrated probability;
`ocr_score` remains `null`.

## Evaluation limits

The available model evaluation is on ICPR/Brazil-Mercosul data: 3,000 test
samples reported 79.13% greedy exact accuracy, 79.63% `beam_filter` exact
accuracy, and 99.8% format-valid output. These figures do not establish accuracy
on Vietnamese plates or on end-to-end video detection/tracking. The previous
SE-ResNet34-C threshold calibration and live confidence values are not validated
for SVTRv2. Recalibrate with independent labels before relying on `readable`
status or confidence thresholds; see [EVALUATION.md](EVALUATION.md).

## Tests

Run the focused adapter test in the configured inference environment, which must
include PyTorch, Pillow, NumPy, OpenCV, and pytest:

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_svtr_adapter.py -q
```

The tests check preprocessing shape/padding/normalization, checkpoint checksum,
strict loading, the configured class factory, and the five-frame prediction
contract against the labelled crops in `data/test_tracks`.

Run a reproducible evaluation and write the predictions, frame weights, input
hashes and runtime versions:

```shell
python -m scripts.evaluate_test_tracks --output data/test_tracks_report.json
```

The supplied track is read as `BCY4440`, matching its annotation (1/1 tracks,
zero character errors). The recorded CPU run is in
[`validation/svtr-test-tracks.json`](validation/svtr-test-tracks.json). This is a
single-track regression check, not an estimate of accuracy on a larger dataset.

The SVTRv2 source attribution and Apache-2.0 license are in
[`third_party/openocr-svtrv2/`](../third_party/openocr-svtrv2/). The original
SE-ResNet34-C checkpoint metadata remains in the provenance file for historical
job snapshots.
