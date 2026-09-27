# Vehicle Tracking BE — API cắt biển số

FastAPI nhận video, SQLite lưu hàng đợi/kết quả, một worker riêng gọi package `plate_pipeline`.
Hỗ trợ `yolov8`, `yolo11n`, `yolo11m`, `yolo26n`; một model cho mỗi video. Chưa có OCR/tracking.

## Thiết lập trên Windows / PowerShell

Dùng Python 3.12. Đặt hai repository cạnh nhau: `Vehicle_Tracking_BE` và `Pipeline`.
Dependency local được khai báo trong `requirements-ml.txt`; nếu đặt Pipeline ở nơi khác, sửa dòng `-e` tương ứng.
Không cần sao chép mã Pipeline vào backend.

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
# Bản CPU để kiểm tra local:
.\.venv\Scripts\python.exe -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
.\.venv\Scripts\python.exe -m pip install -r requirements-ml.txt
Copy-Item .env.example .env
.\.venv\Scripts\python.exe -m app.prepare_models
```

Chỉ sao chép `.env.example` nếu chưa có cấu hình riêng trong `.env`. Bốn checkpoint được tải và kiểm tra inference
trong bước chuẩn bị. Cần Internet lần đầu; worker dùng cache offline, không cài dependency khi nhận video.
Sau khi đổi interpreter, thiết bị hoặc checkpoint, chạy lại `app.prepare_models`.

Muốn chạy GPU: cài cặp PyTorch/torchvision có CUDA theo [hướng dẫn PyTorch](https://pytorch.org/get-started/locally/)
trong môi trường ML, đặt `PLATE_DEVICE=cuda`, kiểm tra lệnh sau trả `True` rồi chạy lại bước chuẩn bị:

```powershell
.\.venv\Scripts\python.exe -c "import torch; print(torch.__version__, torch.cuda.is_available())"
```

Có GPU NVIDIA không đồng nghĩa PyTorch hiện tại có CUDA. Không tự chuyển về CPU khi cấu hình `cuda` bị lỗi.
Có thể tách môi trường API và ML bằng `PLATE_PIPELINE_PYTHON`; môi trường ML phải cài `requirements-ml.txt`.
Đường dẫn tương đối trong `.env` được tính từ thư mục backend.

## Chạy

Terminal thứ nhất:

```powershell
.\.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000
```

Terminal thứ hai:

```powershell
.\.venv\Scripts\python.exe -m app.worker
```

Mở [Swagger](http://127.0.0.1:8000/docs). API và worker phải dùng cùng `.env`.
Worker có khóa độc quyền trên `PLATE_DATA_DIR`, xử lý lần lượt. Dùng `--once` để xử lý tối đa một job.
Khi worker khởi động lại, job `running` cũ thành `failed/WORKER_INTERRUPTED`; job `queued` được giữ.
Windows Job Object dừng cả cây tiến trình model nếu worker chết hoặc job hết thời gian.

## API

```powershell
curl.exe -X POST http://127.0.0.1:8000/api/v1/plate-jobs `
  -F "file=@D:/videos/traffic.mp4" -F "model=yolov8" -F "confidence=0.25"
```

Trả `202` với `job_id`, `status=queued`, `status_url`. Sau đó:

- `GET /api/v1/plate-jobs/{job_id}`: poll mỗi hai giây; `queued`, `running`, `succeeded` hoặc `failed`.
- `GET /api/v1/plate-jobs/{job_id}/plates?limit=50&offset=0`: kết quả khi `succeeded`; `limit` từ 1–200.
- `GET /api/v1/plate-jobs/{job_id}/crops/{crop_id}`: ảnh JPEG; dùng `crop_url` trả về trong danh sách.
- `DELETE /api/v1/plate-jobs/{job_id}`: xóa dữ liệu của job đã kết thúc, trả `204`.

Mỗi crop gồm `frame_index` (1-based), `timestamp_seconds`, `confidence`, `bbox` và `crop_bbox`
dạng `[x1,y1,x2,y2]` theo pixel ảnh gốc. `crop_bbox` gồm padding và clamp theo Pipeline.
Timestamp dùng FPS của sampler, không phải PTS chính xác của video biến thiên FPS. Số crop không phải số xe duy nhất.
YOLOv8 là mặc định kỹ thuật, không phải kết luận về độ chính xác.

MP4/AVI/MOV tối đa 500 MiB mặc định. Video giả đuôi hoặc hỏng được worker kiểm tra giải mã và đánh dấu thất bại.
Không có detection vẫn thành công với `items=[]`. Kết quả chưa sẵn sàng trả `409`, không tìm thấy trả `404`,
sai tham số trả `422`, vượt dung lượng trả `413`, sai định dạng trả `415`.

## Cấu hình và dữ liệu

Các biến trong `.env.example`: thư mục dữ liệu/cache, interpreter, `cpu`/`cuda`, giới hạn upload,
khoảng chờ hàng đợi (2 giây), thời hạn xử lý (7200 giây). Không cung cấp đường dẫn file hoặc interpreter qua API.

`data/jobs.sqlite3` lưu metadata; `data/jobs/{job_id}` giữ video, kết quả Pipeline và `worker.log`.
Chi tiết lỗi nằm trong log; API chỉ trả mã và thông báo an toàn. Không công khai thư mục dữ liệu bằng static mount.
Thành công chỉ được ghi sau khi Pipeline trả `complete`, manifest hợp lệ và transaction nhập kết quả thành công.
Hàng đợi/lịch sử giữ qua lần khởi động lại API; kết quả giữ đến khi xóa. Theo dõi dung lượng đĩa khi xử lý nhiều video.
Bản này phục vụ local qua loopback, chưa có xác thực/phân quyền hay hàng đợi phân tán.

## Kiểm thử

Xem [TESTING.md](TESTING.md) để test từng API trên Swagger, các mã lỗi và chạy bộ kiểm tra HTTP thật.

```powershell
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe -m scripts.smoke_local --video "../Pipeline/reference/assets/data/traffic_cam_01.mp4"
```

Unit/integration tests dùng pipeline giả, không cần checkpoint. Smoke test chạy toàn bộ video với cả bốn model thật,
poll health/trạng thái trong khi worker chạy, đối chiếu mọi bbox/timestamp/confidence và nội dung crop với manifest.
Dữ liệu smoke được giữ riêng trong `data/smoke-*/`; `verification.json` ghi bằng chứng và thiết bị thực tế.
Smoke test cần môi trường ML và cả bốn model đã chuẩn bị; thời gian CPU có thể dài.
