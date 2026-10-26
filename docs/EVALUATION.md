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

`min_confidence` (mặc định 0.85) quyết định track live nào được đánh dấu `readable`. Ngưỡng chỉ được hiệu chỉnh bằng **nhãn độc lập**; review trong ứng dụng không phải nhãn và không được dùng làm ground truth.

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
