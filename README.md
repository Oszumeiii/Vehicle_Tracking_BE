# Low-resolution License Plate Recognition — NestJS + PostgreSQL

Backend nghiệp vụ dùng **NestJS 12 / TypeScript / PostgreSQL**. Python chỉ chạy inference và công cụ đánh giá offline. API có hai vai trò Admin/User, dữ liệu riêng theo chủ sở hữu, xử lý bất đồng bộ, kiểm duyệt có lịch sử, tra cứu và xuất CSV.

Luồng model đã đối chiếu với chat **Gộp pipeline cắt frame và detection**:

**Video → Adaptive Sampling → empty-scene gate → YOLO11l → BoT-SORT → 5 crop/track (chọn theo chất lượng) → OCR joint 5 frame (beam_filter) → kiểm duyệt.**

Pipeline và OCR theo notebook nhóm [PBL6 PIPELINE](https://www.kaggle.com/code/trnvnhun/pbl6-pipeline): STN → SE-ResNet34-C `[3,4,6,3]` → quality fusion → height attention → Transformer → CTC, nhận **đồng thời 5 crop RGB 192×48**, giải mã `beam_filter` theo định dạng biển Brazil/Mercosul. Nhánh này lưu một dự đoán cho mỗi track kèm `decoding` (greedy text, `format_valid`, beam score); không tạo năm dự đoán riêng hoặc dùng bỏ phiếu 3/5.

Profile `prepare` vẫn chạy độc lập không cần OCR: kết quả `machine_status=not_run`, `machine_text=null`, predictions rỗng; người dùng nhập biển số thủ công nếu cần. Ảnh đơn dùng profile prepare hoặc adapter một ảnh riêng; không nhân bản ảnh để đưa vào model joint-frame.

Giữ keyframe nguồn; một frame có thể có nhiều biển số. Ảnh đơn nhận `scene` hoặc `plate_crop`. Track ID không phải danh tính xe; job thành công không đồng nghĩa OCR đúng.

## Chạy ứng dụng

Cần Node.js >=22.12 và PostgreSQL >=16. Máy hiện tại có PostgreSQL 18. Chạy từ thư mục repository.

```powershell
npm ci
npm run build
```

Thêm các biến từ `.env.nest.example` vào `.env` hiện có (không ghi đè cấu hình Python/cache của bạn). `DATABASE_URL` phải trỏ đến database PostgreSQL riêng đã tạo. Ví dụ hình thức URL: `postgresql://USER:PASSWORD@127.0.0.1:5432/DATABASE`.

Nếu muốn dùng Docker và Docker Desktop đang chạy, đặt `POSTGRES_PASSWORD` và `DATABASE_URL` nhất quán rồi chạy `docker compose up -d postgres`. Nếu cổng 5432 đã được PostgreSQL local sử dụng, đổi `POSTGRES_PORT` và cổng trong URL. Không cần Docker nếu dùng PostgreSQL local.

```powershell
npm run db:migrate
# Mật khẩu Admin được đọc từ biến môi trường, không có tài khoản mặc định.
$env:PLATE_ADMIN_PASSWORD = Read-Host 'Initial admin password (12+ characters)' -MaskInput
npm run admin:create -- --email admin@example.com
Remove-Item Env:PLATE_ADMIN_PASSWORD
```

Terminal API:

```powershell
npm start
```

Terminal worker:

```powershell
npm run worker
# Hoặc xử lý tối đa một job:
npm run worker -- --once
```

Mở Swagger tại `http://127.0.0.1:3000/docs`. `POST /api/v2/auth/login`, lấy `access_token`, bấm **Authorize** và nhập token. Mọi endpoint nghiệp vụ đều cần Bearer token. `/health` chỉ là liveness; `/health/ready` kiểm tra database/schema, không xác nhận model hoặc worker đang chạy.

## Chuẩn bị inference

Dùng Python 3.12. Tracking và OCR nằm trong `app/recognition` (không còn cần repo `../Pipeline`). Cài PyTorch đúng phiên bản notebook đã chạy (CUDA 12.8; cần driver NVIDIA hỗ trợ CUDA 12.x), rồi dependency còn lại:

```powershell
.\.venv\Scripts\python.exe -m pip install "torch==2.10.0+cu128" "torchvision==0.25.0+cu128" --index-url https://download.pytorch.org/whl/cu128
.\.venv\Scripts\python.exe -m pip install -r requirements-inference.txt
```

Máy không có GPU NVIDIA thì cài bản CPU (`--index-url https://download.pytorch.org/whl/cpu`) và đặt `PLATE_DEVICE=cpu`; YOLO11l ở imgsz 1280 chạy chậm hơn nhiều trên CPU.

Đặt `PLATE_PIPELINE_PYTHON`, `PLATE_DEVICE`, `PLATE_PIPELINES_CONFIG=config/pipelines.kaggle.json`. Có hai profile: `pbl6-resnet34c-joint5-v1` cho video nhận diện đầy đủ và `pbl6-yolo11l-botsort-prepare-v1` cho ảnh/video lấy bằng chứng. Checkpoint/interpreter thiếu hoặc sai checksum thì profile tương ứng trả `ready=false`, tạo job trả `503`.

Checkpoint OCR `models/icpr_resnet34c_single_model_best.pt` và detector `models/license-plate-finetune-v1l.pt` được kiểm checksum và không đưa vào Git. Cách tải lại, kiến trúc, decoder và đối chiếu với notebook tại [OCR_KAGGLE.md](docs/OCR_KAGGLE.md). File `config/pipelines.example.json` chỉ là mẫu adapter OCR một ảnh để mở rộng sau này.

Chi tiết hợp đồng model, phiên bản và crop: [MODEL_INTEGRATION.md](docs/MODEL_INTEGRATION.md).

## Luồng sử dụng

1. Admin tạo User bằng `POST /api/v2/users`; User đăng nhập.
2. `POST /api/v2/media`: upload JPG/PNG/MP4/AVI/MOV, lấy `media_id`.
3. `GET /api/v2/pipelines`: chọn profile sẵn sàng.
4. `POST /api/v2/recognition-jobs`: JSON `{ "media_id": "...", "pipeline_id": "...", "input_mode": "scene" }`.
5. Poll `GET /api/v2/recognition-jobs/{id}` mỗi khoảng 2 giây.
6. `GET /api/v2/recognition-jobs/{id}/results`, rồi `GET /api/v2/recognition-results/{id}` để xem bằng chứng.
7. `POST /api/v2/recognition-results/{id}/reviews`: `confirm` xác nhận OCR; `correct` kèm `corrected_text` để sửa/nhập biển số; hoặc `unreadable`/`reject`. Luôn gửi `expected_revision` hiện tại. Prepare chưa có OCR thì không dùng `confirm`.
8. Tra cứu `GET /api/v2/recognition-results?plate=ABC1234`; dùng text kiểm duyệt của job thành công mới nhất theo từng nguồn.
9. Xuất `GET /api/v2/recognition-jobs/{id}/export?format=csv`.

Xem [API.md](docs/API.md), [TESTING.md](TESTING.md), [hướng dẫn vận hành](docs/OPERATIONS.md) và [request mẫu](examples/api.http).

## Phân tích nghiệp vụ và thiết kế

[Bộ tài liệu phân tích](docs/analysis/README.md) gồm PDF, HTML, Markdown và 16 sơ đồ UML có nguồn chỉnh sửa: use case, activity, sequence, state, ERD, kiến trúc và triển khai. Nội dung đối chiếu API NestJS, PostgreSQL và model OCR joint-five hiện hành, kèm yêu cầu, quy tắc nghiệp vụ, từ điển DB, nghiệm thu và thiết kế đánh giá đồ án.

## Dữ liệu và migration

8 bảng nghiệp vụ: `users`, `auth_sessions`, `media_assets`, `recognition_jobs`, `plate_appearances`, `plate_detections`, `ocr_predictions`, `recognition_reviews`. Thêm bảng kỹ thuật `schema_migrations` lưu checksum migration. Schema SQL nằm ở `src/database/migrations/`.

- PostgreSQL giữ metadata; `data/media/{id}` giữ nguồn; `data/recognition/{job_id}` giữ crop/keyframe/log.
- Password dùng scrypt; session token chỉ lưu SHA-256 và có thể thu hồi.
- Prediction máy giữ nguyên; mỗi review thêm một bản ghi và tăng revision trong transaction.
- Job đang chờ/chạy không được xóa. Xóa job giữ nguồn; chỉ xóa nguồn khi không còn job tham chiếu.
- Một tiến trình worker giữ advisory lock và chạy song song tối đa `PLATE_WORKER_CONCURRENCY` job (mặc định 1; mỗi job là một tiến trình Python riêng, nên VRAM tăng theo số job). Job running cũ được đánh dấu `WORKER_INTERRUPTED` khi worker khởi động lại. Chạy lại bằng job mới.
- Không công khai thư mục data bằng static serving.

## Kiểm thử

Để chạy test Python, cài `requirements-dev.txt` vào cùng môi trường inference.

```powershell
npm test
.\.venv\Scripts\python.exe -m pytest -q
npm run format:check
```

Test Node dùng PostgreSQL thật trong cluster/database tạm, không sửa database đang sử dụng. Nếu máy không có binaries PostgreSQL, đặt `PG_BIN` hoặc `TEST_DATABASE_URL` trỏ server cho phép tạo database test. Python tests kiểm tra model OCR/decoder, tracking 5 frame và evaluator; không thay cho kiểm thử API NestJS.

Đánh giá accuracy/CER: [EVALUATION.md](docs/EVALUATION.md). Chạy inference thành công chưa chứng minh độ chính xác trên dữ liệu ứng dụng; cần nhãn chuẩn độc lập. Test với runner fixture chỉ chứng minh luồng nghiệp vụ/transaction.

