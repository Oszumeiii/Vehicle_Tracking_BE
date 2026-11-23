# Đánh giá offline nhận dạng biển số

Chạy từ thư mục backend, chỉ cần Python chuẩn; không cần API, DB, model hoặc GPU:

```powershell
.\.venv\Scripts\python.exe -m scripts.evaluate_recognition `
  --ground-truth data/evaluation/ground_truth.json `
  --predictions data/evaluation/predictions.json `
  --split test --group-by-crop-size `
  --output data/evaluation/report.json
```

Thư mục của file đầu ra phải tồn tại. Bỏ `--output` để in JSON ra stdout. Mặc định là
`--split test`; `--all-splits` đánh giá toàn bộ sau kiểm tra rò rỉ dữ liệu. Các file
JSON đọc được cả UTF-8 thường và UTF-8 BOM. Đầu vào lỗi trả exit code 2.

## Ground truth độc lập

File nhãn do người chuẩn bị tập đánh giá kiểm chứng độc lập, có trước khi chấm model:

```json
{
  "samples": [
    {
      "sample_id": "clip-001-track-01",
      "source_id": "clip-001",
      "plate_text": "ABC1D23",
      "split": "test",
      "plate_identity": "labelled-plate-001",
      "crop_width": 58,
      "crop_height": 20
    },
    {
      "sample_id": "photo-002-plate-01",
      "source_id": "photo-002",
      "plate_text": "DEF5678",
      "split": "test"
    }
  ]
}
```

`sample_id`, `source_id`, `plate_text`, `split` bắt buộc; ba ID/split là chuỗi
không rỗng, không có khoảng trắng đầu/cuối. `sample_id` duy nhất toàn file.
`plate_identity`, `crop_width`, `crop_height` tùy chọn; kích thước là số nguyên dương
của crop LR gốc được gán nhãn, không lấy kích thước sau SR.

Một sample là một biển số có nhãn trong ảnh hoặc một lần xuất hiện/track trong video.
Không tạo sample chỉ từ những biển số mà detector đã tìm thấy: các biển số bị bỏ sót
cũng phải có nhãn, nếu không kết quả end-to-end sẽ bị tăng giả. `source_id` phải đại
diện nguồn độc lập gốc; các frame, crop, clip trích từ cùng một video dùng chung ID
nguồn. `plate_identity` là mã định danh ổn định do người gán nhãn cung cấp khi biết
cùng biển số xuất hiện ở nhiều nguồn; đây không phải ID xe được suy ra từ OCR.

Trình chấm từ chối source hoặc plate identity xuất hiện ở nhiều split, kể cả khi
các dòng đó không thuộc split đang chấm. Nếu không cung cấp `plate_identity`, kiểm
tra này chỉ phát hiện rò rỉ theo nguồn. Muốn phát hiện rò rỉ identity đầy đủ phải gán
identity nhất quán cho toàn bộ các mẫu liên quan. Không tự đổi tên split hay suy ra
identity từ text dự đoán. Nên dùng nhất quán `train`, `validation`, `test`.

Script không đọc review trong DB và không chuyển review thành ground truth. Mọi
nhãn dùng để báo độ chính xác cần được kiểm chứng độc lập; không xuất trực tiếp các
sửa tay trong ứng dụng vào file dự đoán máy hay coi chúng là nhãn test đã kiểm định.

## Dự đoán máy

```json
{
  "predictions": [
    {
      "sample_id": "clip-001-track-01",
      "variant": "single_image",
      "detected": true,
      "plate_text": "ABC1D28",
      "latency_ms": 42.5
    },
    {
      "sample_id": "clip-001-track-01",
      "variant": "five_image",
      "detected": true,
      "plate_text": "ABC1D23",
      "latency_ms": 96.0
    },
    {
      "sample_id": "clip-001-track-01",
      "variant": "enhanced",
      "detected": true,
      "plate_text": null,
      "latency_ms": 130.0
    },
    {
      "sample_id": "photo-002-plate-01",
      "variant": "single_image",
      "detected": false,
      "plate_text": null,
      "latency_ms": 18.0
    }
  ]
}
```

`sample_id`, `variant`, `detected` bắt buộc. `variant` chỉ nhận `single_image`,
`five_image`, `enhanced`; mỗi cặp sample/variant chỉ có một dự đoán. `plate_text`
có thể thiếu, `null` hoặc chuỗi rỗng khi không đọc được. `detected: false` không
được đi kèm chuỗi biển số có nội dung. `latency_ms` tùy chọn, phải là số hữu hạn
không âm. Dự đoán có sample ID ngoài tập nhãn bị từ chối.

Thiếu một dòng dự đoán cho sample/variant được tính là bỏ sót detection và không
đọc được. Vì vậy phải xuất toàn bộ đầu ra của lượt chạy đã kết thúc; file xuất dở
không phải kết quả đánh giá hợp lệ. Báo cáo luôn chứa cả ba variant: một variant
hoàn toàn chưa chạy sẽ có toàn bộ sample bị tính thiếu, không phải bằng chứng
model đó kém. Dùng `prediction_count`/`missing_prediction_count` để nhận biết.

Ba variant là ba đầu ra máy riêng, không chọn chuỗi tốt nhất bằng ground truth.
`single_image` dùng model một ảnh/crop; `five_image` ghi đầu ra thật của model
Kaggle joint-frame trên năm crop từ năm frame khác nhau của cùng track. Nếu đánh
giá adapter một ảnh kèm bỏ phiếu, ghi rõ cấu hình đó trong báo cáo riêng, không
coi là đầu ra model joint-frame. `enhanced` là cấu hình có tăng chất lượng thật sự.
Script chỉ chấm JSON đầu ra, không chạy model hoặc tự tạo phiếu bầu. Không nhân
bản ảnh đơn năm lần để tuyên bố có kết quả nhận diện nhiều ảnh. So sánh
single/five cần tập sample có đủ bằng chứng thật cho cả hai. Chấm ảnh đơn trong
một file/tập báo cáo riêng khi model năm ảnh không áp dụng, và không diễn giải
các variant chưa chạy của báo cáo đó.

Khi gán detection cho sample, dùng annotation/bbox/track đã kiểm chứng; không
chọn theo chuỗi OCR giống ground truth. Công cụ này chấm nhận dạng trên các biển
số có nhãn và lỗi bỏ sót; **chưa chấm false-positive precision, mAP hoặc chất
lượng tracking**. Không dùng detection rate của báo cáo để thay thế các chỉ số đó.

## Cách tính

- Chuẩn hóa text thành chữ hoa, bỏ khoảng trắng và dấu `-`, giống API/worker. Giữ nguyên
  `O/0`, `I/1` và các ký tự khác; không dùng luật biển số để sửa dự đoán trước chấm.
- `end_to_end.exact_accuracy`: số chuỗi khớp toàn bộ / toàn bộ sample thuộc split.
  Detection bị bỏ sót, OCR rỗng và thiếu prediction đều là sai.
- `cer`: tổng khoảng cách Levenshtein / tổng số ký tự ground truth; dùng tổng
  toàn tập, không trung bình CER của từng sample. Một biển số bỏ sót có số lỗi
  bằng độ dài nhãn. CER có thể lớn hơn 1 khi dự đoán thừa nhiều ký tự.
- `unreadable_rate`: tỷ lệ không có text sau chuẩn hóa. Ở end-to-end chỉ số này
  bao gồm detection bị bỏ sót; ở `recognizer_conditional` chỉ tính các sample
  có `detected: true`. Chuỗi sai nhưng không rỗng không được tính unreadable.
- `recognizer_conditional`: chấm các chỉ số trên riêng mẫu có detection, kể cả
  mẫu OCR rỗng; luôn xem cùng end-to-end để tránh loại bỏ thất bại detector.
- `latency_ms`: count/mean/p50/p95 của các dòng có latency, gồm cả detection
  thất bại. Percentile dùng nearest-rank: phần tử thứ `ceil(p * N)` sau sắp tăng.
  Mẫu thiếu latency không bị coi là 0; count cho biết độ phủ đo. Dùng cùng thiết
  bị, phạm vi đo và chính sách warm-up cho các variant. Không dùng thời gian toàn
  video lặp lại trên mỗi track như latency của từng sample.
- Mẫu số rỗng trả `null`, không báo 0% hay 100%.
- `--group-by-crop-size` thêm cùng bộ metrics theo chiều rộng crop LR gốc:
  `<64`, `64–127`, `>=128` pixel và `unknown`. Đây là nhóm báo cáo cố định,
  không phải ngưỡng khẳng định model đọc được biển số.

Model được huấn luyện trên biển số Brazil cần báo cáo tập dữ liệu và miền đánh
giá rõ ràng. Không lấy kết quả trên Brazil để suy ra độ chính xác trên Việt Nam.
Giữ checkpoint/config, phiên bản preprocessing và cách chọn năm crop cùng file
dự đoán để tái lập; công cụ này không phải hệ thống quản lý thí nghiệm hoặc training.

Kiểm thử riêng bộ chấm:

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_evaluation.py -q
```

## Hiệu chỉnh ngưỡng tin cậy live

`min_confidence` (mặc định **0.85** từ 15/11/2026, trước đó 0.96) quyết định track live nào được đánh dấu `readable`. Ngưỡng chỉ được hiệu chỉnh bằng **nhãn độc lập**; review trong ứng dụng không phải nhãn và không được dùng làm ground truth.

`readable` là nhãn tham khảo: nó chỉ đổi trạng thái hiển thị và bộ lọc `confidence_status`. Cảnh báo watchlist và việc gom lượt xuất hiện vẫn chạy với mọi track đọc ra chữ; mỗi cảnh báo kèm `confidence_status` để người xem biết mức tin cậy.

### Kết quả hiện tại — SVTRv2-Base regional (09/11/2026)

Chạy lại `scripts/calibrate_icpr.py` với payload của pipeline đang dùng `pbl6-svtrv2-regional-joint5-v1` (checkpoint sha256 `fe1e58e5…`, `beam_filter`, beam 8), cùng 3000 track test và 1000 track validation như lần đo SE-ResNet34-C bên dưới. RTX 4060 Laptop: 5 phút cho test, 1,5 phút cho validation.

**Đọc đúng toàn biển** (không ngưỡng):

| Model | Test | Validation | CER test |
|---|---|---|---|
| SE-ResNet34-C (cũ) | 77,1% | 78,0% | 5,95% |
| **SVTRv2 (hiện tại)** | **79,6%** | **81,4%** | **5,21%** |

**Precision của nhãn `readable`** (khoảng tin cậy Wilson 95%):

| Ngưỡng | Test: precision | Test: coverage | Validation: precision | Validation: coverage |
|---|---|---|---|---|
| 0.85 | 87,2% (85,9–88,4) | 90,1% | 87,7% (85,4–89,6) | 91,5% |
| 0.90 | 90,8% (89,6–91,8) | 85,0% | 90,8% (88,7–92,6) | 85,8% |
| 0.95 | 95,2% (94,3–96,0) | 75,4% | 96,0% (94,3–97,2) | 74,3% |
| **0.96** | **96,0% (95,1–96,8)** | **73,0%** | **96,8% (95,3–97,9)** | **72,5%** |
| 0.97 | 97,3% (96,5–97,9) | 68,5% | 97,7% (96,3–98,6) | 68,6% |
| 0.98 | 98,8% (98,1–99,2) | 61,4% | 98,6% (97,3–99,3) | 63,2% |
| 0.99 | 99,6% (97,6–99,9) | 7,8% | 100% (94,8–100) | 7,0% |

**Kết luận:**
- Gộp hai tập (4000 track), ngưỡng nhỏ nhất có **cận dưới ≥ 95%** vẫn là **0.96** (precision 96,2%, cận dưới 95,5%). Lúc đo, mặc định `min_confidence=0.96` được giữ nguyên.
- Ở cùng ngưỡng, SVTRv2 gắn `readable` cho **72,9%** track so với 68,9% của model cũ: nhiều hơn khoảng 4 điểm phần trăm, precision giữ nguyên.
- Độ chính xác tăng ở mọi cỡ crop; nhóm 40–49 px (đông nhất, gần cỡ crop live) tăng từ 73,7% lên 77,4% trên test.
- Confidence của SVTRv2 dồn sát 0,99: từ 0.98 lên 0.99 coverage rơi từ 61% xuống 8%. Không nên đặt ngưỡng 0.99.
- **Giới hạn bổ sung:** nhóm không ghi lại SVTRv2 được train trên phần nào của ICPR. Nếu tập test từng được dùng khi train hoặc chọn checkpoint, các số trên lạc quan hơn thực tế. Các giới hạn 1–3 của lần đo cũ (bên dưới) vẫn áp dụng.

Kết quả gốc: `data/evaluation/icpr/svtrv2/{test,validation}/report.json` (không commit).

### Kết quả lịch sử — SE-ResNet34-C (26/10/2026)

Các số bên dưới được đo với checkpoint SE-ResNet34-C cũ, trước khi chuyển sang SVTRv2; kết quả hiện tại ở mục trên.

**Dữ liệu:** bộ ICPR 2026 LRLPR mà nhóm dùng để train model (Kaggle `trnvnhun/icpr-2026-low-resolution-plate-dataset`). Mỗi track có 5 ảnh độ phân giải thấp và biển số do người gán.
- **Tập test**, 3000 track: chỉ dùng để chấm, không dùng để train hay chọn checkpoint.
- **Tập validation**, 1000 track: danh sách `trnvnhun/split-data/val_tracks.txt`, tách khỏi train nhưng được dùng để chọn checkpoint.
- Crop ICPR rộng 39–56 px, **cùng cỡ với crop live** (Camboriú: trung vị 42,5 px).

**Cách chạy lịch sử:** `scripts/calibrate_icpr.py` dùng snapshot của pipeline live `pbl6-resnet34c-joint5-v1` (checkpoint `single_model_best.pt` sha256 `e934a864…`, `beam_filter`, beam 8, không TTA) và confidence `beam_confidence_proxy`. Để đánh giá model hiện tại, cung cấp payload/snapshot có recognizer `svtr_adapter:SVTRRecognizer`; không dùng `--tta` vì adapter SVTRv2 không hỗ trợ test-time augmentation.
- **Kiểm tra tái lập:** đọc đúng toàn biển 77,1% trên test, khớp với 77,3% trong notebook của nhóm (`docs/OCR_KAGGLE.md`).
- Validation đạt 78,0%. Hai tập gần nhau, nên không thấy dấu hiệu rò rỉ.

**Precision của nhãn `readable` theo ngưỡng** (precision = tỷ lệ track `readable` đọc đúng toàn biển; khoảng tin cậy Wilson 95%; coverage = tỷ lệ track được gắn `readable`):

| Ngưỡng | Test: precision | Test: coverage | Validation: precision | Validation: coverage |
|---|---|---|---|---|
| 0.70 | 81,2% (79,7–82,6) | 94,8% | 82,0% (79,4–84,3) | 94,9% |
| 0.80 | 84,3% (82,9–85,6) | 90,7% | 84,7% (82,2–86,9) | 90,9% |
| **0.85** (cũ) | 87,0% (85,6–88,2) | 87,0% | 86,2% (83,7–88,3) | 88,1% |
| 0.90 | 90,2% (89,0–91,3) | 81,9% | 89,1% (86,8–91,0) | 83,2% |
| 0.95 | 95,6% (94,6–96,4) | 71,5% | 94,9% (93,1–96,3) | 72,6% |
| **0.96** (mới) | 96,9% (96,1–97,6) | 68,5% | 95,7% (94,0–97,0) | 70,1% |
| 0.97 | 97,8% (97,1–98,4) | 64,9% | 97,1% (95,6–98,2) | 66,4% |
| 0.98 | 98,4% (97,7–98,9) | 59,1% | 98,4% (97,0–99,1) | 60,9% |

**Kết luận:**
- Ở ngưỡng cũ 0.85, cứ khoảng **8 track `readable` thì có 1 track đọc sai**. Mục tiêu của dự án là 95%: trong các track gắn `readable`, ít nhất 95% phải đọc đúng.
- Ngưỡng nhỏ nhất đạt mục tiêu là 0.95 (test) hoặc 0.96 (validation).
- Khi gộp hai tập (4000 track), ngưỡng nhỏ nhất mà **cận dưới** khoảng tin cậy vẫn ≥ 95% là **0.96**, và đó là mặc định mới.
- `scripts.calibrate_threshold` chạy trên cùng file cũng cho 0.95/0.96, khớp với kết quả trên.

**Ảnh hưởng trên live:** cùng các track live đã có trong DB, đổi ngưỡng từ 0.85 sang 0.96:

| Phiên | Track có chữ | `readable` ở 0.85 | `readable` ở 0.96 |
|---|---|---|---|
| Camboriú YouTube 1080p, 45 phút | 486 | 158 | 51 |
| Camera demo `camboriu-day.mp4`, 3 phút | 38 | 10 | 3 |

Track live mất nhãn `readable` nhiều hơn trên ICPR. Lý do: confidence trên live thấp hơn (nén YouTube, crop YOLO có đệm, xe chạy). Có thể precision trên live ở cùng ngưỡng cũng thấp hơn ICPR, nên **không nên hạ ngưỡng chỉ để có nhiều `readable` hơn**.

**Giới hạn:**
1. ICPR là dữ liệu cắt sẵn từ camera giao thông Brazil, chưa phải luồng YouTube của ứng dụng. Kết quả nên xem là **cận trên** của precision trên live.
2. Checkpoint được chọn theo điểm trên validation, nên số đo của tập validation hơi lạc quan; tập test thì không bị ảnh hưởng.
3. Chưa xác nhận trên live bằng nhãn người. Cách xác nhận: tạo bộ mẫu trong tab **Gán nhãn** từ camera có biển lớn (crop từ 50 px trở lên), mỗi mẫu cần ít nhất 2 người gán, rồi xem precision ở ngưỡng 0.96 trong **Báo cáo ngưỡng**.

**Mặc định hạ về 0.85 (15/11/2026):** ở 0.96, camera live của nhóm gần như không có track `readable` (camera 24/7: 0 trong 433 track của một phiên, các phiên trước khoảng 1%), vì biển nhỏ và xa nên confidence thấp hơn ICPR. Nhóm chọn lại 0.85 để có track `readable` trên live và chấp nhận precision thấp hơn: trên ICPR với SVTRv2 là khoảng 87% (cứ 8 track `readable` thì khoảng 1 track sai) thay vì 96%, và trên live có thể thấp hơn nữa. Track `readable` vì vậy vẫn cần người duyệt trước khi dùng làm bằng chứng. Migration `0019_live_threshold_085.sql` đổi `auto_settings.min_confidence` từ đúng 0.96 sang 0.85; camera đặt giá trị khác giữ nguyên. Track đã ghi giữ trạng thái cũ.

**Camera đã tạo trước thay đổi 0.85 → 0.96:** migration `0009_live_threshold.sql` đổi `auto_settings.min_confidence` từ đúng 0.85 (mặc định cũ) sang 0.96. Camera đặt giá trị khác giữ nguyên. Camera cố ý chọn đúng 0.85 không phân biệt được nên cũng bị đổi; muốn giữ thì đặt lại bằng `PATCH /api/v2/stream-sources/{id}`. Phiên bật tay không truyền `min_confidence` sẽ dùng 0.96.

**Chạy lại** (cần `kaggle` CLI đã đăng nhập; dữ liệu khoảng 690 MB, nằm trong `data/`, không commit):

```powershell
kaggle datasets download trnvnhun/icpr-2026-low-resolution-plate-dataset -p data/evaluation/icpr
kaggle datasets download trnvnhun/split-data -p data/evaluation/icpr --unzip
Expand-Archive data/evaluation/icpr/icpr-2026-low-resolution-plate-dataset.zip data/evaluation/icpr/dataset
.\.venv\Scripts\python.exe -m scripts.calibrate_icpr --dataset data/evaluation/icpr/dataset `
  --split test --payload data/live/SESSION_ID/payload.json --out data/evaluation/icpr/test
.\.venv\Scripts\python.exe -m scripts.calibrate_icpr --dataset data/evaluation/icpr/dataset `
  --split validation --val-list data/evaluation/icpr/val_tracks.txt `
  --payload data/live/SESSION_ID/payload.json --out data/evaluation/icpr/validation
```

- `--payload` là `payload.json` của một phiên live bất kỳ (trong `data/live/`), nên script chạy đúng pipeline đang dùng.
- Trên RTX 4060 Laptop, cả hai tập mất khoảng 10 phút, phần lớn là thời gian duyệt thư mục.
- Thư mục `--out` chứa:
  - `readings.json`: kết quả đọc của máy cho từng track. Có thể chấm lại bằng `--readings` mà không cần chạy model.
  - `ground_truth.json` và `predictions.json`, đúng định dạng của `scripts.calibrate_threshold`.
  - `report.json`: bảng đầy đủ các ngưỡng 0.50–0.99 và độ chính xác theo cỡ crop.

### Đo lại cách chọn crop và các biến thể OCR

- **Chọn crop** trên một video (không cần stack; dùng `payload.json` của một phiên live để chạy đúng pipeline):
  ```powershell
  .\.venv\Scripts\python.exe -m scripts.eval_crops --video data/evaluation/crops/camboriu-yt-1080.mp4 `
    --payload data/live/SESSION_ID/payload.json --zones "0,0.66,0.14,0.87;0.18,0.69,0.35,0.89" --out data/evaluation/crops/yt
  ```
  Kết quả: `report.json` (số `readable`, confidence, số track dính crop bị che theo từng cách chọn) và `sheet.jpg` (crop của các track đổi trạng thái, để soát bằng mắt).
- **Biến thể OCR trên ICPR:** thêm `--tta` hoặc `--frames 3|4` vào lệnh `scripts.calibrate_icpr` ở trên.

### Cách 1: trang gán nhãn trong ứng dụng (khuyên dùng)

1. **Admin tạo bộ mẫu:** tab **Gán nhãn**, chọn camera và số mẫu mỗi khoảng tin cậy (mặc định 30; 7 khoảng 0–0,5, 0,5–0,7, 0,7–0,8, 0,8–0,85, 0,85–0,9, 0,9–0,95, 0,95–1, tức tối đa 210 mẫu). API tương ứng: `POST /api/v2/evaluation-sets`.
2. **Người gán nhãn** (mọi tài khoản, nên là người không làm model) mở bộ mẫu:
   - mỗi mẫu có 5 crop và một keyframe;
   - gõ biển đọc được rồi nhấn Enter; chọn **Không đọc được** nếu chính mình cũng không đọc ra; **Bỏ qua** để xem sau; **Quay lại** để sửa nhãn vừa gán;
   - **gán mù:** trang không hiện biển máy đọc, confidence hay trạng thái review;
   - mỗi người gán theo một thứ tự xáo trộn riêng, nên nhiều người có thể gán song song.
3. **Admin mở tab Báo cáo ngưỡng:**
   - precision/coverage theo từng ngưỡng (biểu đồ và bảng), ngưỡng đề xuất theo precision mục tiêu;
   - độ đồng thuận giữa người gán, độ chính xác theo từng khoảng confidence;
   - **chỉ mẫu mà mọi người gán đồng ý mới được tính**, mẫu bất đồng bị loại và có đếm riêng. Có thể yêu cầu tối thiểu 2–3 nhãn mỗi mẫu.
4. **Nhãn được lưu riêng** (`evaluation_labels`), không đụng tới review.
   - Track nằm trong bộ mẫu không bị retention xóa hay bỏ keyframe.
   - Xóa bộ mẫu thì xóa nhãn, nhưng giữ track.
5. **Đối chiếu chéo:** `GET /api/v2/evaluation-sets/{id}/report?format=files` trả `predictions` và `ground_truth` đúng định dạng bên dưới để chạy lại bằng `scripts.calibrate_threshold`. Cách tính của hai bên giống nhau; trên cùng dữ liệu, hai bên cho cùng ngưỡng đề xuất và precision.

### Cách 2: file

1. Xuất mẫu phân tầng theo confidence từ một camera hoặc phiên:

   ```powershell
   node dist/src/cli.js export-live-samples --source CAMERA_ID --out data/evaluation/live --per-bin 20
   ```

   Thư mục chứa `samples/{id}/crop_1..5` và các keyframe còn giữ, `predictions.json` (biển máy đọc và `confidence`) và `ground_truth.template.json`.
2. Người gán nhãn mở crop/keyframe của từng mẫu, điền `plate_text` bằng biển đọc được; không đọc được thì đặt `null`. Không xem `predictions.json` trong lúc gán nhãn. Lưu thành `ground_truth.json`.
3. Tính precision/coverage theo từng ngưỡng:

   ```powershell
   .\.venv\Scripts\python.exe -m scripts.calibrate_threshold `
     --ground-truth data/evaluation/live/ground_truth.json `
     --predictions data/evaluation/live/predictions.json `
     --target-precision 0.95 --output data/evaluation/live/threshold.json
   ```

   Với mỗi ngưỡng từ 0.50 đến 0.99, báo cáo có số track `readable`, số đúng (khớp chính xác sau chuẩn hóa), precision và coverage (tỉ lệ mẫu được đánh dấu `readable`). `recommended_threshold` là ngưỡng nhỏ nhất đạt precision mục tiêu. Mẫu người gán nhãn ghi `null` mà máy vẫn đọc ra chữ được tính là sai.

Báo cáo chỉ có ý nghĩa với tập nhãn đủ lớn và đại diện cho camera đang dùng. Ngưỡng mới áp dụng qua `min_confidence` khi bật phiên hoặc trong `auto_settings` của camera.

### Ghi nhận: thử gán nhãn bằng AI trên camera Camboriú (25/10/2026)

**Bộ mẫu:** 210 track (30 mẫu × 7 khoảng confidence), lấy từ camera YouTube Camboriú vào ban ngày ở Brazil (486 track trong 45 phút, 1080p).

**Cách làm:** Claude gán nhãn qua đúng API gán mù, bằng một tài khoản `user` riêng tên "Claude (AI labeller)". Quy tắc: chỉ ghi biển khi đọc chắc chắn (có đối chiếu định dạng LLLNLNN/LLLNNNN), ghi `null` khi không thấy ký tự nào, còn lại bỏ qua.

**Kích thước crop** (crop thứ 3 của mỗi track, đã gồm 15% phần đệm):

| Rộng | Số mẫu |
|---|---|
| tối thiểu / trung vị / tối đa | 19 / 42,5 / 71 px |
| từ 60 px | 21 |
| từ 50 px | 69 |
| từ 40 px | 137 |
| từ 30 px | 190 |

**Kết quả:**
- Sau 34 mẫu (ưu tiên các mẫu crop từ 48 px trở lên), chỉ 4 mẫu đọc được chắc chắn, đều có crop rộng 56–71 px.
- 2 mẫu hoàn toàn không đọc được; 28 mẫu chỉ thấy một phần.
- Với tỷ lệ này, cả bộ chỉ được khoảng 10–15 nhãn, không đủ để ước lượng precision theo ngưỡng. Đoán các mẫu mờ thì sẽ tạo ra ground truth giả. Vì vậy **không gửi nhãn nào lên hệ thống** và chưa đổi ngưỡng.

**Kết luận cho đánh giá:**
- Ở khoảng cách của camera này, phần lớn biển chỉ rộng 30–50 px trong khung 1080p. Mỗi ký tự chỉ vài pixel: người gán nhãn cũng sẽ gặp đúng giới hạn đó, và đây chính là bài toán biển số độ phân giải thấp của đề tài.
- **Hiệu chỉnh ngưỡng có ý nghĩa cần một trong hai:**
  1. nhiều người gán nhãn độc lập, chấp nhận nhiều mẫu `null`, và yêu cầu `min_labels ≥ 2`;
  2. camera có biển lớn hơn (gần hơn hoặc zoom).
- Hoặc hiệu chỉnh offline trên bộ dữ liệu có nhãn sẵn (ví dụ dữ liệu ICPR dùng để huấn luyện model) bằng `scripts.calibrate_threshold`.
- Nếu một lúc nào đó dùng nhãn AI, phải ghi rõ nguồn nhãn khi công bố kết quả (BR30), và không trình bày như nhãn của người.

### Ước lượng sơ bộ bằng nhãn AI trên camera Camboriú (28/10/2026)

**Bộ mẫu:** "Camboriú YouTube 26–27/10: nhãn AI (Claude), ước lượng sơ bộ", gồm 280 track (40 × 7 khoảng confidence) lấy từ mọi phiên của camera. Gồm cả phiên 720p và phiên 1080p, cả trước và sau cách chọn crop mới.

**Cách làm:**
- Tài khoản `user` "Claude (AI labeller)" gán qua đúng API gán mù: chỉ thấy crop, không thấy biển máy đọc hay confidence.
- Ảnh ghép 10 mẫu mỗi trang, crop phóng to, sắp từ crop lớn đến nhỏ.
- Chỉ gửi nhãn khi chắc chắn từng ký tự (đối chiếu định dạng LLLNLNN/LLLNNNN). Mẫu có dù chỉ một ký tự mơ hồ (H/K, I/J, G/O/D, R/H, 6/8) thì bỏ qua.
- **Không gửi `null`** cho biển quá nhỏ: báo cáo tính `null` là máy đọc sai, nên gửi `null` sẽ phạt cả những lần máy đọc đúng mà người đọc không ra.

**Mức đọc được theo cỡ crop** (rộng trung vị của 5 crop, đã gồm 15% phần đệm):

| Rộng crop | Mẫu đã xem | Nhãn chắc chắn |
|---|---|---|
| 64–72 px | 10 | 5 |
| 57–63 px | 42 | 9 |
| 51–56 px | 48 | 6 |
| dưới 51 px | 180 (chỉ soát nhóm hẹp nhất, 16–26 px) | 0 |

Tổng cộng 20/280 mẫu có nhãn, đều thuộc nhóm crop lớn nhất và có confidence máy từ 0,8 trở lên.

**So với máy:**

| Ngưỡng | Track `readable` | Đúng | Precision |
|---|---|---|---|
| 0,85 | 18 | 9 | 50% |
| 0,90 | 13 | 7 | 54% |
| 0,95 | 8 | 7 | 88% |
| **0,96 (mặc định)** | 6 | 6 | 100% |
| 0,97 | 6 | 6 | 100% |

- Cả 11 lần máy đọc khác nhãn đều dưới 0,96. Ví dụ: H thành N/M (SAH2B43 → SAN2B43, FHV6B53 → FMV6B53), U thành O, T thành I (SET2J25 → SEI2J25 ở 0,953).
- Kết quả phù hợp với ngưỡng 0,96 hiệu chỉnh trên ICPR: các lỗi kiểu này nằm ngay dưới ngưỡng.

**Giới hạn:**
- 6/6 ở 0,96 chỉ cho cận dưới 95% (Wilson) khoảng 61%. Đây là dấu hiệu, chưa phải số đo.
- Nhãn AI không phải ground truth độc lập. Ở 11 ca khác nhau, chính nhãn cũng có thể sai.
- Mẫu chỉ có crop lớn, nên kết quả không đại diện cho biển xa.
- **Ngưỡng mặc định không đổi vì kết quả này** (BR30).

**Bộ mẫu cho nhóm gán:** "Camboriú YouTube: crop ≥ 51 px, cho nhóm gán", tạo với `min_crop_width: 51` và `per_bin: 25` (khoảng 160 track).
- Bộ 280 track ban đầu có khoảng 180 track crop dưới 51 px. Ở cỡ đó không đọc được ký tự nào, nên gán chỉ tốn công mà không thêm thông tin.
- Cách gán chi tiết: `docs/LABELLING.md`. Mỗi mẫu cần ít nhất 2 người; admin mở **Báo cáo ngưỡng** với tối thiểu 2 nhãn mỗi mẫu.
- Kết quả chỉ đại diện cho biển đủ lớn để người đọc được. Đó cũng là nhóm biển duy nhất máy có thể xếp `readable` đúng.

## Vùng nhận diện (ROI) trên camera Canada Orla (06/11/2026)

- **Câu hỏi:** chỉ cho bộ phát hiện xem vùng làn xe gần camera (phóng to vùng đó lên) có giúp đọc biển tốt hơn không.
- **Cách đo:** ghép 5 phút bản ghi của camera YouTube "Canada Orla" (Av. Atlântica, 15:14 giờ Brasília ngày 03/11/2026), upload rồi phát như livestream hai lần trên đúng footage đó: không ROI và ROI `[0,42; 0,3; 1; 1]`. Pipeline `pbl6-svtrv2-regional-joint5-v1`, ngưỡng 0,96.

| | Không ROI | Có ROI |
|---|---|---|
| Track lưu | 77 | 76 |
| Track bị loại (dưới 5 ảnh dùng được) | 16 | 6 |
| Độ tin cậy trung vị | 0,40 | 0,45 |
| Track có độ tin cậy từ 0,8 | 5 | 7 |
| Track từ 0,9 | 3 | 3 |
| `readable` (từ 0,96) | 2 | 1 |
| Crop trung vị | 51 px | 51 px |
| Detector, ms/khung | 33 | 40 |
| Khung bị bỏ | 0 | 0 |

- **Kết luận:** ROI giúp **bám vết**: box chuẩn hơn, nhiều track đủ 5 ảnh hơn, độ tin cậy nhích lên. Số biển `readable` không tăng, vì crop OCR vẫn lấy từ pixel gốc của khung, và giới hạn chính là độ nét của nguồn YouTube.
- **Hướng tiếp:** gán nhãn người cho crop của chính camera này (tab Gán nhãn), rồi tinh chỉnh OCR và chọn ngưỡng riêng cho camera.

## Biển bị sót do bộ bám vết (16/11/2026)

- **Hiện tượng:** xem video thấy nhiều xe đi qua mà hệ thống không ghi biển nào.
- **Cách đo:** chạy pipeline `pbl6-svtrv2-regional-joint5-v1` ngoài hệ thống trên hai đoạn ngắn, mỗi cấu hình một lượt trên đúng footage đó. Bản tham chiếu soi **mọi khung hình** với ảnh detector 1920 px (không chạy được thời gian thực). "Biển đọc rõ của tham chiếu" là biển tham chiếu đọc với độ tin cậy từ 0,85; một cấu hình "thấy" biển đó khi có track cùng thời điểm với chuỗi lệch tối đa 1 ký tự.
  - A: 45 giây đầu video `04_5phut_00h30m-00h35m.mp4` (2560×1440, xe chạy nhanh qua khung).
  - B: 60 giây đầu bản ghi camera Canada Orla (1920×1080, xe chạy chậm, biển nhỏ).

| Cấu hình | A: track lưu | A: thấy biển đọc rõ của tham chiếu (8) | A: track từ 0,85 | B: track lưu | B: track từ 0,5 | Detector, giây GPU mỗi giây video |
|---|---|---|---|---|---|---|
| Trước khi sửa (8/12/15 fps, 1280 px) | 0 | 0 | 0 | 21 | 9 | 0,2 |
| Lấy mẫu 15/20/25 fps | 4 | 2 | 2 | 28 | 7 | 0,4 |
| Ảnh detector 1920 px | 0 | 0 | 0 | 26 | 11 | 0,5 |
| Cho phép track 4 ảnh | 0 | 0 | 0 | 21 | 9 | 0,2 |
| **`association_reach` 1,5 (đang dùng)** | **9** | **8** | **8** | **25** | **8** | **0,2** |
| `association_reach` 1 | 9 | 8 | 7 | 25 | 8 | 0,2 |
| `association_reach` 1 + 15/20/25 fps | 11 | 8 | 8 | 29 | 7 | 0,4 |
| Tham chiếu (mọi khung, 1920 px) | 12 | 8 | 8 | 36 | 10 | 2,0 |

- **Nguyên nhân:** trên đoạn A detector vẫn thấy biển (212 box trong 278 khung lấy mẫu) nhưng không track nào được lưu, và cũng không track nào bị báo loại. BoT-SORT ghép box bằng IoU; ở 8 khung/giây biển của xe đang chạy dịch xa hơn kích thước của nó giữa hai khung, IoU bằng 0, track mới không bao giờ được xác nhận nên biến mất không dấu vết. Tăng FPS chỉ giảm một phần; tăng cỡ ảnh detector hay hạ số ảnh tối thiểu không có tác dụng.
- **Cách sửa:** nới box trước khi tính IoU (`tracking.association_reach`, mặc định 1,5 lần bề rộng biển). Không tốn thêm GPU.
- **Giới hạn:**
  - Hai đoạn ngắn, không có nhãn người: "đúng" ở đây là khớp với bản tham chiếu, và bản tham chiếu cũng đọc sai được. Trên đoạn A, trong 8 biển thấy lại có 5 biển trùng đúng từng ký tự; 3 biển lệch 1 ký tự (ví dụ `MKY3950`/`MKY3350`), chưa biết bên nào đúng.
  - Trên đoạn B (xe chậm) số track tăng 21 → 25 nhưng số track độ tin cậy cao không tăng: ở đó giới hạn là độ nét của nguồn, như phần ROI ở trên.
  - Chưa đo trên cảnh đông xe sát nhau, nơi box nới rộng có thể ghép nhầm hai biển gần nhau.


## Phần đệm của ảnh đưa vào OCR (21/11/2026)

- **Hiện tượng:** biển rõ, crop nét, 5 ảnh đúng cùng một xe, nhưng OCR đọc sai gần hết ký tự (ví dụ `RYN2F47` → `KYM7647`, `TDB4G68` → `AYN4542`).
- **Nguyên nhân:** crop lưu làm bằng chứng có thêm 15% quanh box detector (`tracking.crop_padding`) để người duyệt thấy biển trong ngữ cảnh, và OCR đọc nguyên crop đó. Cả hai checkpoint (SVTRv2 và SE-ResNet34-C cũ) được train trên ảnh ICPR cắt sát biển; phần thân xe thừa làm model đọc lệch. Trên camera YouTube cũ biển chỉ rộng khoảng 40 px nên ảnh hưởng ít hơn; trên footage Balneário Camboriú hiện tại biển rộng 40–75 px (trung vị 56 px), ảnh crop lưu kèm viền rộng 54–98 px.
- **Cách đo:** 55 track của hai camera phát lại "BC – Pau da Viola 21/11 sáng" và "BC – San Telmo 21/11 sáng", lấy ngẫu nhiên trong các track còn crop. Nhãn do Claude đọc từ crop (không phải nhãn người): 29 biển "chắc chắn", 26 biển "khá chắc", bỏ các track không đọc được. Vì O/Q và I/J khó phân biệt ở độ phân giải này (cả hai model cũng đọc `QIR8J74` khi nhãn ghi `OIR8J74`), số dưới đây coi O=Q và I=J. OCR chạy lại trên chính các crop đã lưu, cắt còn box detector cộng phần đệm cho trong bảng.

| OCR | Phần đệm | Đúng cả biển (55) | Tỷ lệ ký tự sai |
|---|---|---|---|
| SVTRv2 (đang dùng) | 0,15 (trước khi sửa) | 13 | 37,7% |
| SVTRv2 | 0,10 | 14 | 31,7% |
| SVTRv2 | 0,05 | 19 | 25,2% |
| SVTRv2 | 0,03 | 19 | 23,4% |
| **SVTRv2** | **0 (mặc định mới)** | **14** | **21,8%** |
| SE-ResNet34-C (trước 06/11) | 0,15 | 15 | 33,2% |
| SE-ResNet34-C | 0,05 | 27 | 17,4% |
| SE-ResNet34-C | 0 | 27 | 14,3% |

- **Cách sửa:** `tracking.ocr_padding` (mặc định 0): OCR đọc box detector cộng phần đệm này, cắt từ crop đã lưu; crop lưu vẫn giữ 15% cho người duyệt. Số track không đổi vì việc giữ hay loại track không phụ thuộc phần đệm. Snapshot tạo trước khi có tùy chọn vẫn đọc nguyên crop.
- **Kiểm tra lại qua đúng đường code của runner** (`PredictionRunner.detection_inputs` + `predict_joint`, SVTRv2): 14 → 18 biển đúng, tỷ lệ ký tự sai 38,4% → 21,8%. Số "đúng cả biển" dao động 2–4 biển giữa hai cách cắt chỉ khác nhau cách làm tròn pixel, nên chọn mức đệm theo tỷ lệ ký tự sai, chỉ số ổn định hơn: mức 0 thấp nhất với cả hai model.
- **Ghi nhận thêm:** trên footage này SE-ResNet34-C cũ đọc tốt hơn SVTRv2 ở mọi mức đệm (27 so với 14–19 biển đúng khi cắt sát), ngược với kết quả đo trên ICPR ngày 09/11. Đợt này chưa đổi model.
- **Giới hạn:** 55 track của một khung cảnh, nhãn không phải của người. Sau khi sửa vẫn chỉ khoảng 1/3 biển đúng cả chuỗi: crop xa cuối track mờ, biển nghiêng, và độ tin cậy từ 0,85 vẫn gồm nhiều biển sai (SVTRv2 cắt sát: 13 đúng trong 29 track từ 0,85).
- Dữ liệu và script: `data/evaluation/ocr_padding/` (không commit).
- **Theo bề rộng ảnh crop lưu** (đã cộng viền 15% mỗi bên; cùng 55 track, cắt sát). Bản trước ghi nhầm đây là bề rộng biển; sửa ngày 23/11/2026. Crop dưới 70 px: SVTRv2 đọc đúng 11/25, SE-ResNet34-C 15/25. Crop từ 70 px: SVTRv2 chỉ 3/30, SE-ResNet34-C 12/30. Thu nhỏ ảnh còn 48 px trước khi đọc giúp SVTRv2 một chút (3 → 6/30 ở nhóm crop lớn) nhưng vẫn kém xa model cũ. Tính theo bề rộng biển thật thì SVTRv2 kém ở mọi cỡ, xem mục "Vì sao SVTRv2 đọc kém hơn trên camera thật".

## Biển nghiêng (21/11/2026)

- **Hiện tượng:** sau khi cắt sát (mục trên), biển rõ vẫn bị đọc sai vài ký tự, thường ở cuối biển (`ENZ2E12` → `ENZ2E32`, `TQE1J16` → `TQE3336`).
- **Nguyên nhân:** camera đặt cao và lệch so với làn xe, nên biển trong ảnh nghiêng. Trên 55 track có nhãn, góc nghiêng trung vị là 9,5°, và 93% track nghiêng từ 4° trở lên. Ảnh train ICPR là biển gần như nằm ngang; khi resize vào khung 128×40 (SVTRv2) hoặc 192×48 (SE-ResNet34-C), dòng chữ nghiêng chéo qua khung và ký tự ở hai đầu bị cắt hoặc méo.
- **Cách sửa:** `tracking.ocr_deskew_degrees` (mặc định 15). Mỗi track đo một góc nghiêng: với từng crop (box detector cộng 5%), nhị phân Otsu, xoay từ −15° đến 15° bước 0,5°, chọn góc mà tổng điểm đen theo từng hàng có phương sai lớn nhất; góc của track là trung vị 5 góc. Crop được xoay quanh tâm box rồi cắt đúng cỡ biển khi nằm ngang. Crop lưu làm bằng chứng không đổi.
- **Kết quả** (cùng 55 track và nhãn của mục trên, O=Q và I=J; chạy qua đúng đường code `PredictionRunner.detection_inputs` + `predict_joint`; tham số chọn trước, không tinh chỉnh trên bộ này):

| OCR | Xoay thẳng | Đúng cả biển (55) | Tỷ lệ ký tự sai | Độ tin cậy ≥ 0,85: đúng / số track |
|---|---|---|---|---|
| SVTRv2 (đang dùng) | không | 18 | 21,8% | 15 / 31 |
| **SVTRv2** | **có** | **29** | **11,9%** | **27 / 46** |
| SE-ResNet34-C | không | 26 | 15,3% | 22 / 34 |
| **SE-ResNet34-C** | **có** | **44** | **4,7%** | **44 / 54** |

- 8 biển trong ảnh chụp màn hình user gửi (camera "BC – Pau da Viola", phiên 16:24 UTC; một track là đèn hậu, một biển quá mờ để gán nhãn): phiên đó còn đọc nguyên crop có viền 15% vì API chạy từ trước khi #79 được merge, nên chỉ đúng 2/6. Cắt sát + xoay thẳng: SVTRv2 5/6, SE-ResNet34-C 5/6.
- **Ghi nhận:** trên footage này SE-ResNet34-C cũ vẫn tốt hơn SVTRv2 rõ rệt (44 so với 29 biển đúng). Pipeline `pbl6-resnet34c-joint5-v2` được thêm để chọn theo camera; pipeline mặc định chưa đổi.
- **Giới hạn:** nhãn do Claude đọc từ crop, chưa phải nhãn người; một khung cảnh, ban ngày. Cách đo góc dựa vào nền biển sáng chữ tối, nên chưa kiểm tra trên biển nền tối hoặc biển bị lóa.

## Xe bị sót trên camera Balneário Camboriú (21/11/2026)

- **Câu hỏi:** người dùng thấy nhiều xe đi qua mà không có kết quả. Xe bị mất ở bước nào, và phần nào do khâu theo dõi (không phải do OCR đọc sai rồi tìm không ra)?
- **Cách đo:** phút 10–14 (240 giây) của hai video phát lại sáng 21/11, 1920×1080, 30 fps: "BC – Pau da Viola" và "BC – San Telmo". Cùng một lượt đọc video chạy hai thứ:
  - pipeline thật: `TrackSession` với đúng snapshot của phiên live (lấy mẫu 8/12/15 fps, ảnh detector 1280 px, empty-scene gate, `association_reach` 1,5, `max_track_seconds` 30), ghi lại mọi box detector, box tracker và lý do loại track;
  - tham chiếu: detector ở **mọi khung** với ảnh 1920 px, BoT-SORT riêng. Một "lượt xe" của tham chiếu là track có ít nhất 10 box; track đứng yên (xe đỗ) và track chạm mép đoạn được tách riêng.
  - Một lượt xe được coi là "pipeline giữ được" khi có track được lưu chứa box trùng (IoU ≥ 0,3) với box tham chiếu cùng khung. Kết quả của phiên live thật (đọc từ database, cùng đoạn video) được đối chiếu theo cách giống hệt.

| Camera | Lượt xe đang chạy | Pipeline giữ | Biển ≥ 50 px | Biển < 50 px | Phiên live thật giữ |
|---|---|---|---|---|---|
| Pau da Viola | 57 | 48 | 40/41 | 8/16 | 47 |
| San Telmo | 62 | 50 | 30/30 | 20/32 | 50 |

- **Biển rộng từ 50 px gần như không bị sót** (70/71; lượt duy nhất là một xe tải mà detector chỉ thấy ở 4 khung). Các lượt bị sót còn lại đều là biển 18–44 px hiện trong khung 0,3–2 giây: xe máy (biển vuông 2 dòng), ô tô ở xa, một xe van. Ở 8 khung/giây lấy mẫu, detector chỉ thấy các biển này ở 0–8 khung, và tracker nối được tối đa 3–4, chưa đủ 5 khung để thành track.
- Phân loại 21 lượt bị sót: 11 bị loại vì "ít hơn 5 khung hợp lệ", 9 không bao giờ được tracker xác nhận (detector thấy 1–2 lần), 1 detector ở 1280 px không thấy.
- **Bỏ khung khi GPU không kịp không làm mất xe:** phiên live thật bỏ 4.767/81.000 (Pau da Viola) và 2.928/81.000 (San Telmo) khung đọc, nhưng giữ 47 và 50 lượt, gần bằng chạy offline không bỏ khung (48 và 50).
- Xe đỗ bên đường (5 và 3 lượt) không thành track; đây là chủ ý của empty-scene gate và không phải xe cần tìm.

**Thử cấu hình khác trên đoạn Pau da Viola** (tham chiếu giữ nguyên):

| Cấu hình | Lượt giữ (57) | Biển < 50 px (16) | Giây GPU detector / 240 giây video |
|---|---|---|---|
| Đang dùng | 48 | 8 | 86 |
| Cho phép track 4 ảnh (`min_frames` 4) | 50 | 9 | 84 |
| Lấy mẫu 15/20/25 fps | 53 | 12 | 171 |
| Lấy mẫu 15/20/25 fps + track 4 ảnh | 53 | 12 | 155 |

- Lấy mẫu dày hơn cứu thêm 5 lượt (đều là biển nhỏ) nhưng gấp đôi thời gian GPU: khoảng 0,7 giây GPU mỗi giây video, nên hai camera trên một GPU không còn chạy kịp thời gian thực. Pipeline thử nghiệm `pbl6-svtrv2-regional-joint5-hfps-v1` đã có sẵn cấu hình này cho trường hợp chỉ chạy một camera.
- Track 4 ảnh cứu thêm 2 lượt, không tốn GPU, nhưng đã được tắt ở giai đoạn 12 vì chất lượng OCR của track ngắn.
- **Chưa đổi mặc định.** Các biển được cứu thêm đều dưới 50 px. Ở cỡ đó OCR chưa được đo đủ (bộ 55 nhãn ở trên không có biển nào dưới 40 px, chỉ 14 biển rộng 40–49 px), nên chưa biết giữ thêm chúng có ra biển số dùng được hay không.
- **Kết luận:** với hai camera này, phần lớn cảm giác "bị sót" không đến từ khâu theo dõi. Mọi biển đủ lớn đều thành track. Biển đọc sai thì tìm theo biển đúng không ra, và trước khi sửa phần đệm, OCR đọc sai khoảng 3/4 biển (mục trên).
- **Giới hạn:** tham chiếu cũng dùng cùng detector, nên xe mà YOLO không thấy ở bất kỳ khung nào, kể cả với ảnh 1920 px, không có trong phép đo. Mỗi camera chỉ đo một đoạn 4 phút ban ngày.
- Dữ liệu và script: `data/evaluation/missed_tracks/` (không commit).

## Vì sao SVTRv2 đọc kém hơn trên camera thật (23/11/2026)

- **Câu hỏi:** trên ICPR, SVTRv2 đọc đúng nhiều hơn SE-ResNet34-C (79,6% so với 77,1%), nhưng trên camera Balneário Camboriú lại kém hơn hẳn. Vì sao?
- **Cách đo:** cùng 55 track có nhãn của hai mục trên (O=Q, I=J), cắt sát và xoay thẳng, chạy qua đúng code của runner. Ngoài cách đọc bình thường (ghép 5 khung), đo thêm:
  - đọc từng khung riêng (một crop lặp lại 5 lần);
  - thu nhỏ mỗi crop còn rộng 48 px (cỡ ICPR) trước khi đọc.

| Model | ICPR test (cùng nguồn với dữ liệu train) | Camera Camboriú (55 track) |
|---|---|---|
| SVTRv2 | 79,6% | 29 (53%) |
| SE-ResNet34-C | 77,1% | 44 (80%) |

**Đã loại trừ:**
- **Cỡ biển:** biển (box detector) rộng 40–75 px, 80% trong khoảng 45–69 px, trung vị 56 px, gần cỡ crop ICPR (39–56 px). SE-ResNet34-C hơn ở mọi nhóm cỡ:

  | Bề rộng biển | Số track | SVTRv2 đúng | SE-ResNet34-C đúng |
  |---|---|---|---|
  | dưới 50 px | 14 | 5 | 8 |
  | 50–59 px | 22 | 14 | 20 |
  | từ 60 px | 19 | 10 | 16 |

  Thu nhỏ về 48 px: SVTRv2 tăng từ 29 lên 32, SE-ResNet34-C giảm từ 44 xuống 43.
- **Ghép 5 khung:** đọc từng khung riêng, SVTRv2 chỉ đúng 53/275 khung (19%), SE-ResNet34-C đúng 141/275 (51%). Ghép 5 khung còn nâng SVTRv2 lên 53%. Không có track nào đọc đúng riêng từ 3 khung trở lên mà ghép lại sai.
- **Biển nghiêng:** cả hai model đều nhận ảnh đã xoay thẳng.
- **Ngưỡng:** cả hai đều cho độ tin cậy cao cả khi sai. Trung vị độ tin cậy của các lần đọc sai: SVTRv2 0,93, SE-ResNet34-C 0,99.

**Lỗi còn lại:**
- **So từng track:**
  - 15 track chỉ SVTRv2 sai;
  - không có track nào chỉ SE-ResNet34-C sai;
  - 8 track hai model đọc giống hệt nhau nhưng khác nhãn, nhiều khả năng nhãn sai;
  - 3 track cả hai đọc sai, mỗi model một kiểu.
- **Kiểu lỗi của SVTRv2:** dồn vào các chữ số chỉ khác nhau một nét nhỏ: 6 → 0 (8 lần), 9 → 7 (4 lần), 1 → 3 (2 lần). 13 trong 26 lần đọc sai chỉ lệch 1 ký tự.

**Kết luận:**
- **Vì sao con số ICPR không áp dụng được:** ICPR test là ảnh cùng nguồn với ảnh train, nên con số trên ICPR chỉ cho biết model học bộ dữ liệu đó tốt đến đâu.
- **Lệch miền dữ liệu:** footage Camboriú khác ICPR ở camera, góc quay, ánh sáng và mức nén video. SVTRv2 chịu sự khác biệt này kém hơn nhiều, còn SE-ResNet34-C giữ được mức đúng. Phép đo chưa tách được yếu tố nào ảnh hưởng nhiều nhất.
- **79,6% có thể lạc quan hơn thực tế:** nhóm không ghi lại SVTRv2 được train trên phần nào của ICPR.
- **Bộ test độc lập cho cùng kết luận:** 88 track mới ở `docs/REVIEW_2026-11.md` (mục 5): SE-ResNet34-C đúng 77%, SVTRv2 66%.

**Quyết định của nhóm (23/11/2026):** giữ SVTRv2 làm mặc định. Người dùng chọn model theo camera, hoặc ngay cạnh nút "Bật phiên" (FE #31).

- **Giới hạn:** nhãn do Claude đọc từ crop, một khung cảnh ban ngày. Cần nhãn người trước khi đưa con số vào báo cáo chính thức.
- **Dữ liệu và script:** `data/evaluation/ocr_padding/svtr_why.py` và `svtr_why.json` (không commit).

## Bỏ khung khi chạy hai camera (24/11/2026)

- **Câu hỏi:** bản rà soát R14 ghi camera YouTube bỏ 1,45% khung khi chạy cùng một camera khác, vượt mức 1% của AT48. Bước chỉnh nghiêng mới thêm (#81) có phải nguyên nhân không?
- **Cách đo:** thống kê cuối của từng phiên live trong 6 ngày, lưu ở `live_sessions.stats`:
  - `stages.ocr.ms_per_track`: thời gian trung bình để chuẩn bị ảnh, chỉnh nghiêng và đọc OCR một track;
  - `stages.detect.ms_per_frame`;
  - `frames_dropped / frames_read`.
  
  Phép tìm góc nghiêng đo riêng: 3,6 ms mỗi ảnh crop cỡ 73×24 px, tức khoảng 18 ms cho 5 ảnh của một track.

| Phiên (giờ Việt Nam) | Camera chạy cùng lúc | Chỉnh nghiêng | Track | OCR mỗi track | Detector mỗi khung | Khung bị bỏ |
|---|---|---|---|---|---|---|
| 21/11 10:35, Pau da Viola 45 phút | 1 | không | 940 | 127 ms | 33 ms | 0,05% |
| 21/11 13:50, Santelmo 52 phút | 1 | không | 284 | 47 ms | 33 ms | 0% |
| 21/11 20:17, Pau da Viola + San Telmo | 2 | không | 685 + 652 | 250 + 253 ms | 53 + 52 ms | 5,89% và 3,61% |
| 21/11 23:48, Demo 14 phút | 1 | có | 294 | 108 ms | 38 ms | 0,09% |
| 22/11 00:23, Pau da Viola 6 phút (SE-ResNet34-C) | 1 | có | 118 | 108 ms | 36 ms | 0,30% |
| 23/11 20:34, Dom Cordoni + Pizza Hot 30 phút (SE-ResNet34-C) | 2 | có | 604 + 587 | 203 + 267 ms | 43 + 44 ms | 1,44% và 2,22% |

- **Không do chỉnh nghiêng:**
  - phép tìm góc chỉ chiếm khoảng 18 ms trong 100–270 ms của một track;
  - cặp hai camera chạy *không* chỉnh nghiêng (21/11) còn bỏ nhiều khung hơn (5,89% và 3,61%).
- **Nguyên nhân:** việc xử lý mỗi track chạy ngay trong vòng lặp đọc khung (`LiveRunner._record`, `app/live/runner.py`): ghi ảnh bằng chứng, chuẩn bị ảnh, chỉnh nghiêng, OCR. Trong lúc đó luồng đọc vẫn nhận khung vào hàng đợi; hàng đợi đầy thì khung bị bỏ. Khi hai camera dùng chung GPU, mỗi track mất gấp đôi thời gian (khoảng 250 ms so với 50–130 ms), nên một loạt xe đi qua cùng lúc dễ làm đầy hàng đợi.
- **Ảnh hưởng thực tế nhỏ:** mục "Xe bị sót trên camera Balneário Camboriú" cho thấy bỏ tới 5,9% khung vẫn giữ 47/48 và 50/50 lượt xe, vì xe nào cũng xuất hiện ở nhiều khung.
- **Hướng sửa nếu cần đạt AT48:** đưa việc xử lý track ra một luồng nền, để vòng lặp đọc khung không phải chờ OCR. Đây là thay đổi về đồng bộ giữa các luồng (thứ tự sự kiện, bộ đếm, đóng phiên phải chờ các track còn dở), nên cần làm và đo riêng. Thu nhỏ phép tìm góc chỉ tiết kiệm khoảng 10 ms mỗi track, không đủ.
