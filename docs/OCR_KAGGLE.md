# Pipeline và OCR từ notebook Kaggle PBL6

Nguồn chuẩn: notebook nhóm [PBL6 PIPELINE](https://www.kaggle.com/code/trnvnhun/pbl6-pipeline) (Kaggle T4, Ultralytics 8.4.150). Checkpoint OCR: dataset [`trnvnhun/icpr-2026-model`](https://www.kaggle.com/datasets/trnvnhun/icpr-2026-model), file `icpr_checkpoints_resnet34c/single_model_best.pt` (Apache-2.0). Thay thế model cũ `huantranvan/icpr-2026-lrp-reg` v4 (32×128).

Luồng: **Video → adaptive sampling → empty-scene gate → YOLO11l → BoT-SORT → 5 crop cùng ID (theo chất lượng) → OCR joint 5 frame → beam_filter → gộp track**.

| Bước | Notebook | Backend |
| --- | --- | --- |
| Sampling | `AdaptiveSelector`, LOW/MED/HIGH = 8/12/15 fps, ngưỡng 2/6 | `app/recognition/video_tracking.py`, `sampling` trong profile |
| Empty-scene gate | MOG2, probe 0.25 s, 3 lần xác nhận, foreground 0.003, warm-up 60 frame | `EmptySceneGate`, `empty_scene_gate` trong profile |
| Detector | `license-plate-finetune-v1l.pt` @ `251a30d7…`, imgsz 1280, conf 0.10, iou 0.7, lọc box (w≥12, h≥5, tỉ lệ 1.1–7) | `detect_plates`, `models/license-plate-finetune-v1l.pt` |
| Tracker | BoT-SORT, buffer 1.5 s, đồng hồ theo PTS | `SampledTrackerClock` |
| Chọn 5 crop | `crop_quality` + `score_rows` (nét 0.35, chiều cao 0.30, conf 0.25, không chạm mép 0.10), pool ≥ 8 hoặc nửa tốt nhất, trải đều theo thời gian | `select_five` |
| Crop | padding 0.15, pixel từ frame JPEG của sampler | `export_crops` (kiểm tra lại pixel crop = vùng keyframe) |
| OCR | `SingleLRLPRModel`, input `[B,5,3,48,192]`, logits `[B,48,37]` | `icpr_model.py`, `icpr_adapter.py` |
| Decoder | `beam_filter`, beam 8, TTA tắt, AMP trên CUDA | `ctc_decoders.py`, `recognizer.config` |
| Gộp track | `merge_tracks` (lệch ≤ 1 ký tự, cách ≤ 3 s, ≥ 5 ký tự) | `statistics.vehicle_groups` |

**Detector:** phần mô tả notebook ghi "YOLO11n" nhưng code tải `license-plate-finetune-v1l.pt`, là YOLO11**l** (scale `l`, ~25M tham số; v1n mới là YOLO11n). Backend theo code đã chạy: profile khai báo `detector.model=yolo11l`. Muốn nhẹ hơn trên CPU, đổi sang checkpoint v1n và `model=yolo11n` (registry chấp nhận cả hai); khi đó kết quả không còn giống notebook.

## Kiến trúc và tiền xử lý OCR

STN affine (FP32) → SE-ResNet34-C đủ 4 stage `[3,4,6,3]`, stride cuối `(2,1)` → `QualityAwareFrameFusion` (trọng số theo frame và theo cột) → `HeightAttentionPool` → Transformer 3 lớp → primary CTC head. 37 lớp: blank `0` và `0-9A-Z`.

- Đọc crop RGB, resize **192×48** bằng OpenCV `INTER_LINEAR`, `(x/255 − 0.5)/0.5`, HWC → CHW, đúng 5 crop theo thời gian.
- Nhánh super-resolution `sr_decoder.*` chỉ dùng lúc train; adapter bỏ các key này rồi `load_state_dict(strict=True)` cho phần còn lại.
- Load bằng `torch.load(..., weights_only=True)`; chấp nhận state_dict thuần hoặc bọc trong `state_dict`/`model_state_dict`/`model`, bỏ tiền tố `module.`/`_orig_mod.`.
- CUDA dùng autocast float16 (notebook `OCR_USE_AMP=True`), CPU dùng float32.

## Decoder và điểm số

`recognizer.config` hỗ trợ `decoder` (`greedy`, `beam_plain`, `beam_filter`, `beam_constrained`; mặc định `beam_filter`), `beam_width` (1–64, mặc định 8), `use_tta` (mặc định `false`). Option khác bị từ chối.

`beam_filter` lấy ứng viên beam tốt nhất khớp định dạng Brazil cũ `LLLDDDD` hoặc Mercosul `LLLDLDD`; nếu không có ứng viên hợp lệ thì trả ứng viên tốt nhất. Mỗi prediction joint lưu `decoding`:

- `plate_text` (= `raw_text`), `greedy_text`, `format_valid`;
- `greedy_symbol_confidence`: trung bình hình học xác suất các ký tự greedy;
- `beam_log_score`, `beam_confidence_proxy = exp(beam_log_score / số ký tự)`; notebook dùng ngưỡng 0.80 để lọc hiển thị.

Các điểm này **không phải xác suất đã hiệu chuẩn**; `ocr_score` vẫn `null`. `frame_weights` là trọng số fusion của model (trung bình theo cột), không phải confidence.

Kết quả notebook trên tập test 3000 mẫu (`icpr_results_resnet34c/test_results.json`): greedy exact 76.7%, CER 6.03%; `beam_filter` exact 77.3%, CER 5.90%, format hợp lệ 99.4%. Đây là số trên dataset ICPR, chưa phải độ chính xác trên video của ứng dụng.

## Checkpoint

| File | SHA-256 | Kích thước |
| --- | --- | --- |
| `models/icpr_resnet34c_single_model_best.pt` | `e934a8644f06e28631a291b01c04a95274a546c19013f874c8b1995b30423c9c` | 126.084.235 byte |
| `models/license-plate-finetune-v1l.pt` | `f3d25e066e4ff41c64c2bcbf4fd35fa85abaad5a37769b61c804de8f3291ff2c` | 51.189.266 byte |

Checkpoint không commit vào Git; `config/pipelines.kaggle.json` ghim checksum. Tải lại bằng Kaggle CLI và Hugging Face Hub (cần xác thực Kaggle trên máy):

```powershell
kaggle datasets download trnvnhun/icpr-2026-model -f icpr_checkpoints_resnet34c/single_model_best.pt -p data/kaggle-ocr --unzip
Copy-Item data/kaggle-ocr/single_model_best.pt models/icpr_resnet34c_single_model_best.pt
.\.venv\Scripts\python.exe -c "from huggingface_hub import hf_hub_download; import shutil; shutil.copyfile(hf_hub_download('morsetechlab/yolov11-license-plate-detection', 'license-plate-finetune-v1l.pt', revision='251a30d7daedca065f56e04b0af04052c907c68f', cache_dir='data/model-cache'), 'models/license-plate-finetune-v1l.pt')"
Get-FileHash models/icpr_resnet34c_single_model_best.pt, models/license-plate-finetune-v1l.pt -Algorithm SHA256
```

So hash với bảng trên trước khi chạy. Sai checksum thì `/api/v2/pipelines` trả `ready=false` và tạo job trả `503`.

## Khác biệt có chủ đích so với notebook

- Không tạo contact sheet, ảnh annotate hay `index.html`; giao diện dùng crop/keyframe qua API.
- `merge_tracks` chỉ là gợi ý trong `statistics.vehicle_groups`; mỗi track vẫn là một kết quả riêng để kiểm duyệt.
- Ảnh đơn (`scene`) dùng cùng detector và bộ lọc box, giữ box có confidence ≥ `crop_confidence`; model OCR joint không chạy trên ảnh đơn.

## Kiểm thử

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_icpr_adapter.py tests/test_ml_adapter.py -q
```

Test kiểm tra tên/shape state_dict, tiền xử lý 48×192, các decoder và định dạng biển, load an toàn/checksum, gate, chọn 5 crop theo chất lượng và `merge_tracks`, bằng trọng số tổng hợp, không đo accuracy. Riêng `test_trained_checkpoint_reads_labelled_icpr_track` chạy checkpoint thật (tự bỏ qua nếu chưa tải) trên một track ICPR có nhãn trong `tests/fixtures/test_track` và phải đọc đúng `BCY4440`; đây là kiểm tra hồi quy một mẫu, không phải số đo độ chính xác.

Ngày 14/10/2026 đã chạy ML runner thật trên CPU với hai checkpoint trên và `Pipeline/validation/new_short_video.avi` (30 frame): 13 frame được sampling, 2 track đủ 5 crop, OCR trả `ASL1231` và `LRV1121` (`format_valid=true`, proxy 0.50 và 0.67); kết quả qua `validateResult` của worker NestJS. Video không có nhãn chuẩn nên lần chạy này chỉ chứng minh pipeline hoạt động, không chứng minh đọc đúng.
