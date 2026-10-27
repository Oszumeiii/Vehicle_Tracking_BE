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

`min_confidence` (mặc định **0.96**) quyết định track live nào được đánh dấu `readable`. Ngưỡng chỉ được hiệu chỉnh bằng **nhãn độc lập**; review trong ứng dụng không phải nhãn và không được dùng làm ground truth.

`readable` là nhãn tham khảo: nó chỉ đổi trạng thái hiển thị và bộ lọc `confidence_status`. Cảnh báo watchlist và việc gom lượt xuất hiện vẫn chạy với mọi track đọc ra chữ; mỗi cảnh báo kèm `confidence_status` để người xem biết mức tin cậy.

### Kết quả hiệu chỉnh offline trên ICPR (26/10/2026)

**Dữ liệu:** bộ ICPR 2026 LRLPR mà nhóm dùng để train model (Kaggle `trnvnhun/icpr-2026-low-resolution-plate-dataset`). Mỗi track có 5 ảnh độ phân giải thấp và biển số do người gán.
- **Tập test**, 3000 track: chỉ dùng để chấm, không dùng để train hay chọn checkpoint.
- **Tập validation**, 1000 track: danh sách `trnvnhun/split-data/val_tracks.txt`, tách khỏi train nhưng được dùng để chọn checkpoint.
- Crop ICPR rộng 39–56 px, **cùng cỡ với crop live** (Camboriú: trung vị 42,5 px).

**Cách chạy:** `scripts/calibrate_icpr.py` dùng đúng recognizer của pipeline live (`pbl6-resnet34c-joint5-v1`: checkpoint `single_model_best.pt` sha256 `e934a864…`, `beam_filter`, beam 8, không TTA) và đúng confidence của live (`beam_confidence_proxy`).
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

**Camera đã tạo trước thay đổi:** migration `0009_live_threshold.sql` đổi `auto_settings.min_confidence` từ đúng 0.85 (mặc định cũ) sang 0.96. Camera đặt giá trị khác giữ nguyên. Camera cố ý chọn đúng 0.85 không phân biệt được nên cũng bị đổi; muốn giữ thì đặt lại bằng `PATCH /api/v2/stream-sources/{id}`. Phiên bật tay không truyền `min_confidence` sẽ dùng 0.96.

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
