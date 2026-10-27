# Vận hành backend NestJS

Thực hiện các lệnh từ thư mục `Vehicle_Tracking_BE`. Hai tiến trình `npm start` và `npm run worker` phải dùng cùng `DATABASE_URL`, `PLATE_DATA_DIR`, Python và cấu hình pipeline. `.env` được đọc từ thư mục đang chạy lệnh; đường dẫn storage và Python tương đối cũng tính từ đó. Đường dẫn bên trong JSON pipeline tính từ thư mục chứa JSON.

## Chuẩn bị lần đầu

1. Cài Node.js >=22.12, PostgreSQL >=16 và Python 3.12 (tracking/OCR nằm trong `app/recognition`).
2. Cài dependency và biên dịch:

   ```powershell
   npm ci
   npm run build
   # Chỉ tạo virtual environment nếu chưa có.
   py -3.12 -m venv .venv
   # GPU NVIDIA (bản notebook dùng): torch 2.10.0 + CUDA 12.8. Không có GPU: dùng index whl/cpu.
   .\.venv\Scripts\python.exe -m pip install "torch==2.10.0+cu128" "torchvision==0.25.0+cu128" --index-url https://download.pytorch.org/whl/cu128
   .\.venv\Scripts\python.exe -m pip install -r requirements-inference.txt
   ```

3. Tạo database và role riêng. Với PostgreSQL local, mở `psql` bằng tài khoản quản trị PostgreSQL, rồi thực hiện một lần:

   ```sql
   CREATE ROLE plate LOGIN;
   \password plate
   CREATE DATABASE plate OWNER plate;
   ```

   `\password` hỏi mật khẩu tương tác. Nếu database/role đã được chuẩn bị, dùng chúng; không chạy lại các lệnh tạo. Trên Windows có thể gọi `& 'C:\Program Files\PostgreSQL\18\bin\psql.exe' -h 127.0.0.1 -U postgres -d postgres`.

   Cách khác: khi Docker Desktop đang chạy, cấu hình `POSTGRES_PASSWORD` rồi chạy `docker compose up -d postgres`. Compose tạo role/database tên `plate`; `DATABASE_URL` phải dùng cùng mật khẩu và cổng. Đổi `POSTGRES_PORT` nếu cổng 5432 đã được dùng. Compose hiện chỉ chạy PostgreSQL; API và worker chạy trên host để truy cập repo Pipeline và môi trường ML.

4. Thêm biến từ [`.env.nest.example`](../.env.nest.example) vào `.env` hiện có, giữ các cấu hình Python/cache cần thiết. Đặt mật khẩu tự chọn, không giữ giá trị mẫu `change-me`. URL có dạng `postgresql://plate:PASSWORD@127.0.0.1:5432/plate`; percent-encode ký tự đặc biệt trong phần mật khẩu của URL. API không tự tạo database hoặc tự chạy migration.
5. Chạy migration và tạo Admin:

   ```powershell
   npm run db:migrate
   $adminSecret = Read-Host 'Admin password (12-128 characters)' -AsSecureString
   $env:PLATE_ADMIN_PASSWORD = [System.Net.NetworkCredential]::new('', $adminSecret).Password
   try {
     npm run admin:create -- --email admin@example.com --display-name 'Administrator'
   } finally {
     Remove-Item Env:PLATE_ADMIN_PASSWORD -ErrorAction SilentlyContinue
     $adminSecret.Dispose()
   }
   ```

   Admin email là email bạn chọn. Không có tài khoản hoặc mật khẩu mặc định. Chạy lại lệnh tạo cùng email báo tài khoản đã tồn tại; lệnh không đặt lại mật khẩu. Sau khi đăng nhập, Admin tạo User hoặc đổi mật khẩu qua API.

## Khởi động và kiểm tra

Terminal 1 chạy API:

```powershell
npm start
```

Terminal 2, cũng ở thư mục backend và dùng cùng cấu hình, chạy worker:

```powershell
npm run worker
```

`npm run worker -- --once` xử lý tối đa một job rồi thoát; nếu hàng đợi rỗng thì thoát ngay. Chỉ một worker được giữ advisory lock trên mỗi database. Tiến trình thứ hai báo lỗi thay vì giành job của worker đang chạy. Muốn xử lý nhiều job cùng lúc thì tăng `PLATE_WORKER_CONCURRENCY` (1-8) cho worker đó, không chạy thêm tiến trình worker: các luồng nhận job bằng `FOR UPDATE SKIP LOCKED` nên không trùng job. Mỗi job chạy một tiến trình Python và nạp model riêng; với GPU 8 GB nên để 2. `--once` luôn xử lý tối đa một job.

Kiểm tra `GET http://127.0.0.1:3000/health/ready`, rồi mở [Swagger](http://127.0.0.1:3000/docs), đăng nhập và Authorize bằng `access_token`. Có bộ request chạy từng bước tại [`examples/api.http`](../examples/api.http), dùng [REST Client cho VS Code](https://github.com/Huachao/vscode-restclient#usage). Request sau lấy token/ID từ response trước; gửi lần lượt và kiểm tra status. Mật khẩu được hỏi khi gửi. Vì biến được chèn vào JSON, giá trị chứa dấu nháy kép hoặc dấu gạch chéo ngược cần JSON escaping; có thể dùng Swagger để nhập trực tiếp các giá trị đó.

- `/health`: API đang trả lời HTTP.
- `/health/ready`: kết nối được PostgreSQL và có bảng nghiệp vụ. Endpoint này không kiểm tra worker hoặc chạy thử model.
- `/api/v2/pipelines`: sau đăng nhập, xem profile và `ready`. Đây là kiểm tra cấu hình, file và checksum; vẫn cần một job thực để kiểm chứng dependency Python, CUDA và inference.

Cấu hình mặc định là `PLATE_PIPELINES_CONFIG=config/pipelines.kaggle.json`, gồm hai profile:

- `pbl6-yolo11l-botsort-prepare-v1`, `task=prepare`: phát hiện biển số trong ảnh hoặc sampling/tracking và chọn 5 crop/track trong video. Profile cần Python và checkpoint detector. Kết quả có `machine_status=not_run`, danh sách OCR prediction rỗng; người dùng xem bằng chứng rồi nhập nội dung bằng review `correct`, hoặc đánh dấu `unreadable`/`reject`.
- `pbl6-resnet34c-joint5-v1`, `task=recognize`: video với `input_mode=scene`, thêm checkpoint OCR SE-ResNet34-C của notebook PBL6. Mỗi track đủ điều kiện đưa đúng 5 crop từ 5 frame khác nhau vào một lần inference. Kết quả có một joint prediction cấp appearance, `recognition_method=joint_multiframe`, `agreement_count=null` và `ocr_score=null`; `frame_weights` chỉ là trọng số tổng hợp feature. Gửi ảnh đơn vào profile này trả `422`.

Đặt checkpoint OCR tại `models/icpr_resnet34c_single_model_best.pt` và detector tại `models/license-plate-finetune-v1l.pt`, kiểm tra checksum và cách tải trong [OCR_KAGGLE.md](OCR_KAGGLE.md). API và worker mặc định dùng CPU; YOLO11l ở imgsz 1280 chậm trên CPU, nên đặt `PLATE_DEVICE=cuda` cho cả hai tiến trình khi PyTorch/CUDA phù hợp. Profile prepare vẫn sử dụng được khi chưa có checkpoint OCR. Có thể chọn riêng `config/pipelines.prepare.json` nếu chỉ muốn công bố luồng prepare. `config/pipelines.example.json` là mẫu cho adapter OCR đọc từng crop khác, theo [MODEL_INTEGRATION.md](MODEL_INTEGRATION.md).

Cả hai profile dùng kiểm duyệt, tra cứu và CSV chung. Với OCR, mở đầy đủ 5 crop và frame nguồn để kiểm tra chuỗi nhận diện và việc ghép track trước khi `confirm` hoặc `correct`. Nếu không có track đủ 5 frame, job vẫn có thể `succeeded` với danh sách kết quả rỗng và thống kê loại track.

## Theo dõi và chạy lại

Poll `GET /api/v2/recognition-jobs/{id}` khoảng 2 giây một lần. Giai đoạn gồm `validating`, `detection_tracking`, `recognition` khi có chạy OCR, `persisting`, sau đó `complete` hoặc `failed`. `succeeded` có thể có không kết quả; không đồng nghĩa OCR đúng. Video chỉ tạo appearance cho track có đủ 5 frame hợp lệ.

Job lỗi trả `error_code` và thông báo an toàn. Chi tiết phía server nằm trong `PLATE_DATA_DIR/recognition/{job_id}/worker.log`. Log, JSON nội bộ và đường dẫn checkpoint không được public qua HTTP. Kiểm tra đồng thời console API/worker khi lỗi xảy ra trước khi tạo thư mục job.

- `ENVIRONMENT_ERROR`: kiểm tra Python, dependency và cấu hình môi trường.
- `CHECKPOINT_MISSING`: file/checksum checkpoint hoặc source khác snapshot lúc tạo job. Không sửa snapshot trong DB; tạo job mới sau khi hoàn tất cấu hình.
- `INPUT_CHANGED`: file nguồn thiếu hoặc checksum khác. Khôi phục đúng file từ backup hoặc upload nguồn mới.
- `JOB_TIMEOUT`: thời gian vượt `PLATE_JOB_TIMEOUT_SECONDS`, mặc định 7200 giây.
- `WORKER_INTERRUPTED`: worker dừng trước khi hoàn tất.
- `RESULT_INVALID`: đầu ra không đáp ứng hợp đồng; xem log và adapter.

Phiên live lỗi có `error_code` trên `GET /api/v2/live-sessions/{id}`. Chi tiết nằm ở `PLATE_DATA_DIR/live/{session_id}/live.log` và `GET /api/v2/live-sessions/{id}/events`. Khi `PLATE_LIVE_MAX_SESSIONS` lớn hơn 1, các phiên chạy chung một host: traceback và log chẩn đoán của host nằm ở `PLATE_DATA_DIR/live/host.log`. Host thoát bất thường thì mọi phiên trong đó cùng chuyển `failed`/`LIVE_PROCESS_EXITED`.

- `STREAM_FAILED`: kết nối lại thất bại quá số lần cho phép.
- `LIVE_PROCESS_EXITED`: tiến trình live thoát bất thường.
- `AUTO_RESTART_FAILED` (event trên phiên gần nhất của camera 24/7): không dựng được snapshot pipeline để bật lại; worker thử lại sau 1, 2, 4… tối đa 30 phút.
- `LIVE_STALLED`: tiến trình live không báo gì trong `PLATE_LIVE_STALL_SECONDS` và đã bị kill. Nguyên nhân thường gặp: GPU hết VRAM vì có tiến trình khác dùng chung. Với host dùng chung, cả host bị kill, vì một lần gọi model bị treo không thể hủy riêng cho một phiên.
- `WORKER_INTERRUPTED`: worker dừng hoặc khởi động lại giữa phiên.
- Các mã khởi động (`CHECKPOINT_MISSING`, `ENVIRONMENT_ERROR`, `CUDA_*`, `PIPELINE_FAILED`): giống job upload.

Stream SSE (`/api/v2/live-events/stream`) dùng một kết nối PostgreSQL riêng để `LISTEN`. Mất kết nối thì API tự kết nối lại (chờ lùi dần tối đa 30 s), và client nhận đủ sự kiện nhờ id. Reverse proxy phải tắt buffer cho đường dẫn này; API đã gửi `X-Accel-Buffering: no` và heartbeat mỗi `PLATE_SSE_HEARTBEAT_SECONDS`. Mỗi stream mở tính vào `PLATE_SSE_MAX_CLIENTS`.

Track không nhập được (bằng chứng hỏng) được ghi thành event `track_rejected` và để nguyên trong `live/{session_id}/tracks/`. Bật phiên mới để chạy tiếp.

Chạy lại bằng `POST /api/v2/recognition-jobs` với cùng `media_id`. Job cũ và review cũ còn nguyên. API không có retry/cancel riêng. Tra cứu chung chọn lượt xử lý nghiệp vụ succeeded mới nhất của mỗi nguồn; vẫn xem lịch sử qua job cụ thể.

## Dừng, khởi động lại và cập nhật

Để bảo trì, ngừng nhận request mới bằng cách dừng API; chờ job hiện tại kết thúc nếu muốn giữ lần xử lý đó, rồi dừng worker bằng Ctrl+C. Dừng worker trong lúc inference sẽ ngắt subprocess và job có thể thành `WORKER_INTERRUPTED`. Nếu tiến trình bị tắt đột ngột, lần khởi động worker tiếp theo chuyển các job còn `running` sang `failed/WORKER_INTERRUPTED`.

Worker dọn bằng chứng live mỗi `PLATE_RETENTION_INTERVAL_MINUTES` theo thời hạn của từng camera (xem README). Cột `recognition_jobs.evidence_bytes` cho biết dung lượng từng track; tổng theo phiên có ở `GET /live-sessions/{id}`. Bản sao lưu nên chạy sau một lượt dọn để không mang theo keyframe sắp bị xóa.

Phiên live khi worker dừng bằng Ctrl+C sẽ chốt track đang mở (tối đa `PLATE_LIVE_STOP_SECONDS`, mặc định 120 s) rồi chuyển `interrupted`. Nếu worker bị tắt đột ngột, lần khởi động sau sẽ chuyển phiên sang `interrupted` và nhập các track đã ghi xuống đĩa.

**Bản ghi và clip:**
- Bản ghi đệm nằm ở `data/live/<phiên>/record/eNNN/`, gồm `seg_*.mp4` và `index.jsonl`.
- Tiến trình live tự xóa đoạn cũ hơn `PLATE_LIVE_RECORD_MINUTES`; worker dọn bản ghi của phiên đã dừng và video cắt tạm (`cache/`, `live/recording-cache/`) sau 1 giờ.
- Clip lưu lâu dài nằm cùng bằng chứng của job: `recognition/<job>/clip.mp4`.
- Tắt ghi bằng `PLATE_LIVE_RECORD=false`.
- Ước tính dung lượng: 4 giờ × 1080p ≈ 7 GB mỗi camera.

Một phiên live chiếm GPU liên tục. Với `PLATE_LIVE_MAX_SESSIONS` ≥ 2, job video dùng pipeline joint chạy trong host live (dùng chung model, giữ ở tốc độ thời gian thực khi có camera). Job quá `PLATE_JOB_TIMEOUT_SECONDS` được yêu cầu dừng; nếu 30 s sau vẫn chưa dừng thì host bị kill, kéo theo các phiên live trong đó. Các job khác vẫn theo quy tắc cũ: mặc định (`PLATE_LIVE_EXCLUSIVE_GPU=true`) chúng chờ trong lúc phiên live chạy và ngược lại. Muốn xử lý video upload thì dừng phiên live, hoặc chạy worker trên máy có GPU đủ lớn rồi đặt `false`. Số đo nằm trong `TESTING.md`. Các job `queued` tiếp tục được lấy; job `failed` không tự chạy lại.

Sau khi sao lưu, cập nhật code/dependency, chạy `npm ci`, `npm run build`, `npm run db:migrate`, rồi khởi động API và worker. Migration đã áp dụng có checksum; không sửa nội dung migration cũ để cập nhật schema, hãy thêm migration mới. Cập nhật source hoặc checkpoint có thể làm job đang queued không còn khớp snapshot; giữ bộ model/source cũ cho đến khi hàng đợi hoàn tất hoặc tạo job mới sau cập nhật.

## Sao lưu nhất quán PostgreSQL và file

DB chỉ chứa metadata/storage key. Một bản dump SQL riêng lẻ không đủ khôi phục bằng chứng. Dừng cả API, worker và mọi công cụ import trước khi sao lưu; giữ chúng dừng đến khi xong cả dump và sao chép file. Dùng `pg_dump` có cùng major version với server (ví dụ dưới là PostgreSQL 18).

Ví dụ cho database local tên `plate`, storage `data`; thay đường dẫn/cổng theo cấu hình thực tế. Chọn thư mục backup ở ngoài storage và repository:

```powershell
$pgBin = 'C:\Program Files\PostgreSQL\18\bin'
$storageRoot = (Resolve-Path -LiteralPath '.\data').Path
$backupRoot = 'D:\Backups\plate-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
New-Item -ItemType Directory -Path $backupRoot -ErrorAction Stop | Out-Null
& "$pgBin\pg_dump.exe" -h 127.0.0.1 -p 5432 -U plate -W -d plate -Fc -f "$backupRoot\database.dump"
if ($LASTEXITCODE -ne 0) { throw 'Database backup failed; do not treat this as a complete backup.' }
Copy-Item -LiteralPath $storageRoot -Destination "$backupRoot\files" -Recurse -ErrorAction Stop
Get-FileHash -LiteralPath "$backupRoot\database.dump" -Algorithm SHA256
```

Lưu cùng đợt backup: phiên bản code/lockfile, repo Pipeline, file cấu hình pipeline và checkpoint cần tái lập inference. Lưu `.env` trong nơi giữ bí mật được kiểm soát quyền truy cập, không commit vào Git. Ghi lại thời điểm backup và đường dẫn storage. Nếu bất kỳ bước sao chép nào thất bại, chưa coi backup hoàn tất. Sau khi hoàn thành mới khởi động lại dịch vụ.

## Khôi phục vào đích mới

Khôi phục thử vào database và storage mới để kiểm tra trước khi chuyển ứng dụng. Ví dụ dưới giả định database `plate_restore` và thư mục `D:\PlateRestore\files` chưa tồn tại; PostgreSQL role `plate` đã tồn tại. Dùng tài khoản PostgreSQL được phép tạo database ở bước `createdb`:

```powershell
$pgBin = 'C:\Program Files\PostgreSQL\18\bin'
$backupRoot = Read-Host 'Absolute path of a completed backup'
& "$pgBin\createdb.exe" -h 127.0.0.1 -p 5432 -U postgres -W -O plate plate_restore
if ($LASTEXITCODE -ne 0) { throw 'Could not create the restore database.' }
& "$pgBin\pg_restore.exe" -h 127.0.0.1 -p 5432 -U plate -W -d plate_restore --no-owner --no-acl --exit-on-error "$backupRoot\database.dump"
if ($LASTEXITCODE -ne 0) { throw 'Restore failed; do not start the application against this database.' }
if (Test-Path -LiteralPath 'D:\PlateRestore\files') { throw 'Choose an empty restore destination.' }
New-Item -ItemType Directory -Path 'D:\PlateRestore' -Force | Out-Null
Copy-Item -LiteralPath "$backupRoot\files" -Destination 'D:\PlateRestore\files' -Recurse -ErrorAction Stop
& "$pgBin\psql.exe" -h 127.0.0.1 -p 5432 -U plate -W -d plate_restore -v ON_ERROR_STOP=1 -c 'UPDATE auth_sessions SET revoked_at=now() WHERE revoked_at IS NULL;'
if ($LASTEXITCODE -ne 0) { throw 'Session revocation on the restored database failed.' }
```

Thu hồi phiên trong DB khôi phục để các token có trong backup không trở lại hiệu lực. Khi API và worker đều dừng, cấu hình chúng dùng `plate_restore` và `PLATE_DATA_DIR=D:/PlateRestore/files`; chạy `npm run db:migrate` bằng phiên bản code phù hợp, rồi khởi động. Kiểm tra login, danh sách job, file nguồn, crop và CSV của một job đã biết. `pipeline_snapshot` giữ đường dẫn model/source lúc tạo job; nếu chuyển máy/đường dẫn, lịch sử vẫn đọc được nhưng cần tạo job mới với cấu hình mới để inference. Không ghép database của một đợt backup với file của đợt khác.
