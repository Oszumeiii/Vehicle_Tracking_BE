# Recognition classes

`config/pipelines.kaggle.json` uses `svtr_adapter:SVTRRecognizer` with
`models/single_model_best_svtrv2_base_regional_pool_warmup_v1.pt`.
The architecture and state-dict keys remain compatible with the supplied weights.

| Class | Responsibility |
| --- | --- |
| `SVTRRecognizer` / `ICPRRecognizer` | Own model, device and decoder settings; preprocess and recognize five RGB crops through `__call__`. ICPR supports historical snapshots. |
| `CTCDecoder` | Greedy and beam decoding, including plate-format constraints. |
| `PlateFusion` / `TrackGroups` | Plate normalization, voting and advisory grouping of broken tracks. |
| `PipelineRegistry` | Verify pinned checkpoint and source hashes. |
| `PredictionRunner` | Load crop evidence and validate single-crop or joint model output. |
| `AppearanceBuilder` | Build image/video appearance records from detections and crop manifests. |
| `RecognitionRunner` / `JobProgress` / `ResultWriter` | Own job context, execute recognition, publish progress and save results. |
| `TrackSession` / `VideoTracker` | Incremental sampling, detection and tracking; drive uploaded-video jobs. |
| `VideoFrameReader` / `FrameImage` | Background decoding with queue/capture cleanup; sampler image transforms. |
| `CropSelector` / `PlateDetector` / `TrackingConfig` / `EvidenceWriter` | Crop quality/selection, detector filtering, source configuration and evidence export. |
| `RecognitionSupervisor` | Bound subprocess lifetime and handle parent exit/timeouts. |

Stateful resources belong to instances. Stateless transformations are static
methods on their responsible class. The package has no standalone function
definitions. CLI entry points remain `python -m app.recognition.runner` and
`python -m app.recognition.supervisor`. The adapters retain `create_recognizer`
as a class alias so existing pipeline snapshots can still resolve their factory;
source hashes must still match the snapshot before a job runs.

## Local evaluation

Install inference/test dependencies and retrieve the LFS weights first:

```shell
git lfs install
git lfs pull
python -m scripts.evaluate_test_tracks --output data/test_tracks_report.json
python -m pytest -q
```

The evaluator uses the pipeline's class factory, preprocessing, checkpoint checksum
and decoder. It reads each `annotations.json` and five ordered `lr-*.jpg` crops
under `data/test_tracks`. Its report includes exact match, character error rate,
raw prediction, decoding metadata, normalized frame weights and evidence hashes.
The current fixture is one Brazilian plate, `BCY4440`; it exercises OCR directly
and does not require the YOLO detector.

The checkpoint and test crops are included by `.gitignore`; `.gitattributes`
routes only this checkpoint through LFS. Run `git lfs install --local` in an
existing clone before staging it. Other runtime data and model binaries remain
ignored.
