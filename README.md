# Vehicle Tracking BE — API cắt biển số

FastAPI nhận video, SQLite lưu hàng đợi/kết quả, một worker riêng chạy pipeline nội bộ: adaptive sampling,
YOLO, BoT-SORT, chọn năm crop theo track và nhận dạng biển số.
Các model video được hỗ trợ là `yolo11l`, `yolo11n`, `yolo11m`, `yolo26n`.

## Cây thư mục

```text
Vehicle_Tracking_BE/
│
├── app/
│   ├── __init__.py
│   ├── main.py
│   │
│   ├── api/
│   │   ├── __init__.py
│   │   ├── deps.py
│   │   └── v1/
│   │       ├── router.py
│   │       └── endpoints/
│   │           ├── health.py
│   │           ├── plate_jobs.py
│   │           └── recognition.py
│   │
│   ├── core/
│   │   ├── config.py
│   │   ├── processes.py
│   │   ├── security.py
│   │   └── upload_limit.py
│   │
│   ├── db/
│   │   └── __init__.py
│   │
│   ├── schemas/
│   │   ├── plate_job.py
│   │   └── recognition.py
│   │
│   ├── repositories/
│   │   ├── plate_job_repository.py
│   │
│   ├── services/
│   │   ├── plate_job_service.py
│   │
│   ├── workers/
│   │   ├── job_executor.py
│   │
│   └── ai/
│       ├── pipelines/
│       │   ├── config.py
│       │   ├── plate_pipeline.py
│       │   └── video_pipeline.py
│       ├── detect_tracking_boundingbox/
│       │   ├── botsort_tracker.py
│       │   ├── empty_scene_gate.py
│       │   └── yolo_detector.py
│       ├── recognition/
│       │   ├── model.py
│       │   ├── config.py
│       │   ├── decoder.py
│       │   ├── preprocessing.py
│       │   ├── errors.py
│       │   ├── inference.py
│       │   └── track_predictor.py
│       ├── video/
│       │   └── frame_extractor.py
│       └── settings.py
│
├── checkpoints/
│   └── single_model_best/
│
├── data/
│   └── model-cache/
│
├── tests/
│   ├── test_plate_jobs.py
│   ├── test_video_pipeline.py
│   └── fixtures/
│       └── test_track/
│           ├── lr-001.jpg ... lr-005.jpg
│           └── annotations.json
│
├── scripts/
│   ├── smoke_local.py
│   ├── test_live_api.py
│   ├── prepare_models.py
│   └── run_inference.py
│
├── main.py                 # Entrypoint tương thích ngược
├── requirements.txt
├── .env.example
├── .gitignore
├── README.md
└── TESTING.md
```

Cây trên chỉ liệt kê các thành phần hiện đã có và đang được sử dụng; các module camera/vehicle,
Celery/Redis, ORM, Docker và migrations chưa được tạo. `app/worker.py` cũng giữ entrypoint worker cũ.

## Thiết lập trên Windows / PowerShell

Dùng Python 3.12 trở lên. Pipeline video nằm trong backend; không cần cài package `plate_pipeline` riêng.

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
# Cài PyTorch/torchvision theo nền tảng và thiết bị tại pytorch.org.
.\.venv\Scripts\python.exe -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
Copy-Item .env.example .env
.\.venv\Scripts\python.exe -m scripts.prepare_models
```

Chỉ sao chép `.env.example` nếu chưa có cấu hình riêng trong `.env`. Bốn checkpoint YOLO được tải và kiểm tra inference
trong bước chuẩn bị; checkpoint nhận dạng phải tồn tại tại `MODEL_CHECKPOINT`. Cần Internet lần đầu; worker dùng cache offline.
Sau khi đổi interpreter, thiết bị hoặc checkpoint, chạy lại `scripts.prepare_models`.

Muốn chạy GPU: cài cặp PyTorch/torchvision có CUDA theo [hướng dẫn PyTorch](https://pytorch.org/get-started/locally/)
trong môi trường ML, đặt `PLATE_DEVICE=cuda`, kiểm tra lệnh sau trả `True` rồi chạy lại bước chuẩn bị:

```powershell
.\.venv\Scripts\python.exe -c "import torch; print(torch.__version__, torch.cuda.is_available())"
```

Có GPU NVIDIA không đồng nghĩa PyTorch hiện tại có CUDA. Không tự chuyển về CPU khi cấu hình `cuda` bị lỗi.
Có thể tách worker khỏi API bằng `PLATE_PIPELINE_PYTHON`; môi trường worker cần `requirements.txt`
và PyTorch/torchvision.
Endpoint inference trong API cần PyTorch, NumPy và OpenCV cài trong chính interpreter chạy FastAPI.
Đường dẫn tương đối trong `.env` được tính từ thư mục backend.

## Chạy

Terminal thứ nhất:

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Terminal thứ hai:

```powershell
.\.venv\Scripts\python.exe -m app.workers.job_executor
```

Mở [Swagger](http://127.0.0.1:8000/docs). API và worker phải dùng cùng `.env`.
Worker có khóa độc quyền trên `PLATE_DATA_DIR`, xử lý lần lượt. Dùng `--once` để xử lý tối đa một job.
Khi worker khởi động lại, job `running` cũ thành `failed/WORKER_INTERRUPTED`; job `queued` được giữ.
Windows Job Object dừng cả cây tiến trình model nếu worker chết hoặc job hết thời gian.

## API

```powershell
curl.exe -X POST http://127.0.0.1:8000/api/v1/plate-jobs `
  -F "file=@D:/videos/traffic.mp4" -F "model=yolo11l"
```

Trả `202` với `job_id`, `status=queued`, `status_url`. Sau đó:

- `GET /api/v1/plate-jobs/{job_id}`: poll mỗi hai giây; `queued`, `running`, `succeeded` hoặc `failed`.
- `GET /api/v1/plate-jobs/{job_id}/plates?limit=50&offset=0`: kết quả khi `succeeded`; `limit` từ 1–200.
- `GET /api/v1/plate-jobs/{job_id}/crops/{crop_id}`: ảnh JPEG; dùng `crop_url` trả về trong danh sách.
- `DELETE /api/v1/plate-jobs/{job_id}`: xóa dữ liệu của job đã kết thúc, trả `204`.

Mỗi crop gồm `frame_index` (1-based), `timestamp_seconds`, `confidence`, `bbox` và `crop_bbox`
dạng `[x1,y1,x2,y2]` theo pixel ảnh gốc. `crop_bbox` gồm padding và clamp theo Pipeline.
Timestamp dùng FPS của sampler, không phải PTS chính xác của video biến thiên FPS. Số crop không phải số xe duy nhất.
Model detect có thể chọn từ FE: `yolo11l`, `yolo11n`, `yolo11m` hoặc `yolo26n`; mặc định là `yolo11l`.
Ngưỡng detect cố định phía backend là `0.25`, cấu hình trong `app/core/config.py`; FE không cần gửi `confidence`.

## API inference 5 frame

Inference 5 frame được phục vụ chung trên FastAPI hiện tại. Cài môi trường ML, đặt `MODEL_CHECKPOINT` trỏ tới file
checkpoint hoặc thư mục checkpoint PyTorch đã bung; mặc định là `checkpoints/single_model_best`. Model được nạp khi
gọi inference lần đầu. Decoder dùng constrained CTC beam search; `MODEL_PLATE_POSITION_CLASSES` mặc định là
`LLLDDDD` (3 chữ và 4 số). Gọi endpoint:

```powershell
curl.exe -X POST http://127.0.0.1:8000/api/v1/model/predict `
  -F "frames=@D:/frames/lr-001.jpg" -F "frames=@D:/frames/lr-002.jpg" `
  -F "frames=@D:/frames/lr-003.jpg" -F "frames=@D:/frames/lr-004.jpg" `
  -F "frames=@D:/frames/lr-005.jpg"
```

Gửi đúng 5 ảnh theo thứ tự bằng multipart field `frames` tới `POST /api/v1/model/predict`. Mỗi ảnh được resize về `128x32` và
chuẩn hóa như nhau; phản hồi gồm text giải mã CTC và trọng số fusion của từng frame. `MODEL_DEVICE` nhận `cpu` hoặc
`cuda`; cấu hình checkpoint, thiết bị, định dạng biển số và giới hạn dung lượng ảnh nằm trong `.env`. Kiểm tra trạng thái
model tại `GET /api/v1/model/health`. `MODEL_MAX_IMAGE_PIXELS` giới hạn tổng số pixel mỗi ảnh; mặc định là 40 triệu.

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

Unit/integration tests dùng pipeline giả, không cần checkpoint. Smoke test chạy toàn bộ video với cả bốn model,
poll health/trạng thái trong khi worker chạy, đối chiếu mọi bbox/timestamp/confidence và nội dung crop với manifest.
Dữ liệu smoke được giữ riêng trong `data/smoke-*/`; `verification.json` ghi bằng chứng và thiết bị thực tế.
Smoke test cần môi trường ML và cả bốn model đã chuẩn bị; thời gian CPU có thể dài.
