# Tự kiểm thử API cắt biển số

## 1. Chuẩn bị

Mở PowerShell tại `D:\Documents\PBL6\Vehicle_Tracking_BE`.
Nếu API và worker đang chạy thì giữ nguyên, không mở thêm worker.

Nếu chưa chạy, terminal thứ nhất:

```powershell
.\.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000
```

Terminal thứ hai:

```powershell
.\.venv\Scripts\python.exe -m app.worker
```

Vào [Swagger](http://127.0.0.1:8000/docs). Model đã được chuẩn bị trên máy này bằng CPU.
Nếu cài lại môi trường hoặc chuyển máy, làm theo phần thiết lập trong README trước.

## 2. Test trên Swagger theo đúng thứ tự

### Kiểm tra server

Mở `GET /health` → **Try it out** → **Execute**.
Kỳ vọng: HTTP `200`, nội dung `{"status":"ok"}`.

### Upload video

Mở `POST /api/v1/plate-jobs` → **Try it out**:

- `file`: chọn `D:\Documents\PBL6\Pipeline\reference\assets\data\traffic_cam_01.mp4`.
- `model`: chọn `yolov8` trước; sau đó có thể thử `yolo11n`, `yolo11m`, `yolo26n`.
- `confidence`: `0.25`.
- Nhấn **Execute**, chờ upload xong.

Kỳ vọng HTTP `202`, ví dụ:

```json
{
  "job_id": "ma_job_do_server_tra_ve",
  "status": "queued",
  "status_url": "/api/v1/plate-jobs/ma_job_do_server_tra_ve"
}
```

**Sao chép giá trị `job_id` thực tế**, không dùng nguyên chuỗi ví dụ.
`202` chỉ có nghĩa server đã nhận và xếp hàng, chưa có nghĩa video đã xử lý xong.

### Theo dõi xử lý

Mở `GET /api/v1/plate-jobs/{job_id}` → **Try it out** → dán `job_id` → **Execute**.
Bấm lại mỗi khoảng hai giây. Trạng thái chuyển `queued` → `running` → `succeeded` hoặc `failed`.

- Khi `succeeded`: đọc `selected_frames`, `total_crops`, `started_at`, `finished_at`.
- Khi `failed`: đọc `error_code`, `error_message`; xem thêm `data/jobs/{job_id}/worker.log`.
- Nếu cứ `queued`: kiểm tra terminal worker và việc API/worker có dùng chung `.env` hay không.
- Trong khi đang chạy, gọi lại `/health` để xác nhận API vẫn phản hồi.

Video mẫu có 1.814 frame; cấu hình sampling hiện tại chọn 154 frame. Chạy CPU thường mất từ khoảng một
đến vài phút cho mỗi model trên máy này; đây không phải thời gian được đảm bảo.

### Lấy danh sách ảnh biển số

Sau khi `succeeded`, mở `GET /api/v1/plate-jobs/{job_id}/plates`:

- `job_id`: mã vừa tạo.
- `limit`: `5`.
- `offset`: `0`.

Kỳ vọng HTTP `200`, có `total` và `items`. Đổi `offset=5` để xem trang kế tiếp.
`bbox` và `crop_bbox` là `[x1,y1,x2,y2]`, tính theo pixel ảnh gốc; vùng crop có thêm padding.
`frame_index` bắt đầu từ 1. `timestamp_seconds` là thời điểm theo sampler.

### Xem ảnh crop

Lấy `crop_id` từ một phần tử của `items`. Mở `GET /api/v1/plate-jobs/{job_id}/crops/{crop_id}`,
điền cả hai mã và **Execute**. Kỳ vọng HTTP `200`, `Content-Type: image/jpeg`.

Cũng có thể mở trực tiếp trong trình duyệt bằng cách ghép `http://127.0.0.1:8000` với `crop_url`.
Nếu `items=[]`, video đã xử lý thành công nhưng model không phát hiện biển số ở ngưỡng đã chọn.

Khi xem ảnh, kiểm tra bằng mắt xem crop có thực sự là biển số không. Trong lượt thử video mẫu,
YOLOv8 ở ngưỡng `0.25` có trường hợp nhận nhầm chữ quảng cáo `www.0511.vn` với confidence khoảng `0.318`.
Đây là lỗi nhận diện của model; HTTP thành công và số crop lớn không chứng minh độ chính xác cao.
Có thể thử ngưỡng cao hơn để so sánh, nhưng cần kiểm tra cả biển số bị bỏ sót.

### Xóa job thử nghiệm

Chỉ làm khi đã xem hoặc lưu xong ảnh. Mở `DELETE /api/v1/plate-jobs/{job_id}`, nhập mã job **do bạn vừa tạo**.
Kỳ vọng `204`, không có body. Gọi lại status hoặc crop của job đó phải trả `404`.
Xóa job `queued`/`running` trả `409`; không dùng endpoint này để hủy tác vụ đang chạy.

## 3. Các tình huống lỗi nên thử

- Không chọn file: `422`.
- File `.txt` thay vì MP4/AVI/MOV: `415`.
- File rỗng: `422`.
- Model ngoài bốn lựa chọn hoặc confidence bằng `0`, lớn hơn `1`: `422`.
- `limit=0`, `limit=201` hoặc `offset=-1`: `422`.
- Job không tồn tại: `404`.
- Lấy kết quả trước khi `succeeded`: `409`.
- Crop không tồn tại trong job đã thành công: `404`.
- File MP4 giả/hỏng: upload vẫn có thể trả `202`, sau đó worker trả trạng thái `failed`, mã `INVALID_VIDEO`.
- File lớn hơn 500 MiB mặc định: `413`. Script HTTP bên dưới kiểm tra chặn sớm bằng header,
  không cần gửi một file lớn; bộ pytest kiểm tra thêm nội dung và upload chunked.

Thiếu checkpoint trả lỗi tác vụ `CHECKPOINT_MISSING`; chọn CUDA trong môi trường PyTorch CPU trả
`CUDA_UNAVAILABLE`. Không cần xóa model hay sửa môi trường đang hoạt động để thử hai lỗi này thủ công.

## 4. Chạy tự động toàn bộ API qua HTTP thật

Cần API và worker đang chạy. Lệnh sau kiểm tra các endpoint, lỗi đầu vào, chạy bốn model, phân trang,
tải tất cả crop và xóa một job thử nghiệm thất bại:

```powershell
.\.venv\Scripts\python.exe -m scripts.test_live_api --video "../Pipeline/reference/assets/data/traffic_cam_01.mp4"
```

Để thử nhanh chỉ YOLOv8:

```powershell
.\.venv\Scripts\python.exe -m scripts.test_live_api --video "../Pipeline/reference/assets/data/traffic_cam_01.mp4" --models yolov8
```

Mỗi phép kiểm tra in `PASS`. Cuối lượt phải có `All HTTP checks passed` và `passed: true` trong
`data/live-api-test-<thời gian>/report.json`. Các job thành công được giữ để xem trên Swagger;
script chỉ xóa job lỗi do chính nó tạo. Báo cáo có job ID, response trạng thái, metadata crop mẫu;
thư mục này cũng chứa ảnh crop mẫu và JSON danh sách của từng model.

Nếu server đổi cổng, thêm `--base-url http://127.0.0.1:8001`. Nếu đổi giới hạn upload,
truyền `--max-upload-mib` đúng bằng cấu hình server.

## 5. Bộ kiểm thử nội bộ và đối chiếu Pipeline

Không cần server đang chạy để chạy kiểm thử nội bộ:

```powershell
.\.venv\Scripts\python.exe -m pytest -q
```

Bộ này kiểm tra thêm transaction SQLite, phục hồi sau khởi động lại, nhận job không trùng,
khóa worker, chặn đường dẫn vượt thư mục, timeout và tiến trình con khi worker bị tắt trên Windows.
Các bài test dùng thư mục tạm, không xóa job của bạn.

Muốn đối chiếu mọi bbox, confidence, timestamp và byte ảnh với manifest Pipeline cho cả bốn model:

```powershell
.\.venv\Scripts\python.exe -m scripts.smoke_local --video "../Pipeline/reference/assets/data/traffic_cam_01.mp4"
```

Lệnh này tự chạy worker trong thư mục kiểm thử riêng và dùng TestClient; nó khác với script HTTP thật ở mục 4.
Chỉ nên chạy một lượt kiểm thử model nặng tại một thời điểm để tránh tranh tài nguyên CPU/GPU.
