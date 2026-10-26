# Chạy bằng Docker

Cách này chạy cả hệ thống trong container (PostgreSQL, API, worker có GPU, giao diện web), để máy khác trong nhóm không phải cài Node, Python hay CUDA. `start-all.cmd` vẫn dùng như cũ; không có `--profile app` thì compose chỉ bật PostgreSQL.

## Yêu cầu

- **Docker Desktop**, dùng backend WSL 2, có Docker Compose v2.
- **GPU NVIDIA và driver mới** cho Windows. Docker Desktop tự chuyển GPU vào WSL 2; trên Linux cần thêm NVIDIA Container Toolkit.
  - Kiểm tra: `docker run --rm --gpus all nvidia/cuda:12.8.0-base-ubuntu24.04 nvidia-smi` phải in ra tên GPU.
- **Hai repo đặt cạnh nhau**, vì service `web` build từ `../Vehicle_Tracking_FE`:

  ```
  PBL6/
    Vehicle_Tracking_BE/
    Vehicle_Tracking_FE/
  ```

- **Model** trong `Vehicle_Tracking_BE/models/` (không có trong git, xem README):
  - `license-plate-finetune-v1l.pt`
  - `icpr_resnet34c_single_model_best.pt`

  Checksum được kiểm tra khi tạo pipeline, nên file sai sẽ bị từ chối.
- **File `.env`** tạo từ `.env.example`, ít nhất có `POSTGRES_PASSWORD`, `POSTGRES_PORT` và các biến `PLATE_*`. Compose tự ghi đè `DATABASE_URL`, đường dẫn Python và thư mục dữ liệu cho container.

## Chạy

```powershell
cd Vehicle_Tracking_BE
docker compose --profile app up -d --build
docker compose --profile app ps          # api và postgres phải là healthy
```

| Địa chỉ | Dùng để |
|---|---|
| http://localhost:8080 | Giao diện web (nginx, chuyển `/api` sang API) |
| http://localhost:3000/docs | Swagger của API |

- Đổi cổng bằng `WEB_PORT` và `API_PORT` trong `.env`.
- Tạo tài khoản admin lần đầu (mật khẩu 12–128 ký tự, truyền qua biến môi trường, không qua tham số):
  ```powershell
  docker compose exec -e PLATE_ADMIN_PASSWORD api node dist/src/cli.js create-admin --email EMAIL
  ```
  Đặt `$env:PLATE_ADMIN_PASSWORD` trong PowerShell trước khi chạy. Database dùng chung với `start-all`, nên tài khoản cũ vẫn đăng nhập được.
- Dừng: `docker compose --profile app down`. Dữ liệu vẫn giữ trong volume `plate-postgres` và thư mục `data/`.

## Cách hoạt động

- **`api`:**
  - migrate database rồi mới chạy API;
  - chỉ báo healthy khi `/health/ready` OK, tức database đã migrate đủ;
  - có Python nhẹ (Pillow, OpenCV) để đọc thông tin video upload.
- **`worker`:** chạy job upload và camera live trên GPU.
  - Có PyTorch CUDA 12.8 (CUDA nằm sẵn trong wheel), ultralytics, yt-dlp và ffmpeg.
  - Bắt đầu sau khi `api` healthy.
- **`web`:** bản build Vite chạy trên nginx. `/api` và `/health` được chuyển sang `api:3000`, không buffer để sự kiện live (SSE) đến ngay.
- **Dữ liệu dùng chung với cách chạy thường:**
  - `data/` và `models/` được mount từ repo (models chỉ đọc);
  - database là cùng volume `plate-postgres` với `start-all`.
  - **Không chạy hai cách cùng lúc.** Worker thứ hai sẽ tự thoát vì chỉ một worker được giữ database, và hai API sẽ tranh cổng 3000.
- **Code nằm ở `/app` trong cả hai image.** Pipeline ghim đường dẫn và checksum code inference khi tạo job. Vì vậy:
  - job tạo trên Windows không chạy lại được trong container, và ngược lại;
  - job và phiên mới thì không bị ảnh hưởng.

## Giới hạn

- **RAM:** Docker Desktop mặc định cấp cho WSL 2 một nửa RAM máy (máy 16 GB: khoảng 7,4 GB). Mỗi job upload nạp model riêng, tốn khoảng 3 GB RAM.
  - Lần thử với `PLATE_WORKER_CONCURRENCY=2`: job thứ hai lỗi `Cannot allocate memory`. Vì vậy compose đặt worker chạy **1 job một lúc**.
  - Muốn chạy 2 job song song: tăng RAM của WSL trong `%UserProfile%\.wslconfig` (`[wsl2]` rồi `memory=12GB`), chạy `wsl --shutdown`, sau đó sửa `PLATE_WORKER_CONCURRENCY` trong `compose.yaml`.
- **Chậm hơn chạy native:** job upload clip 20 s mất khoảng 70–120 s, so với khoảng 40 s khi chạy native. Lý do có thể là model và dữ liệu đọc qua bind mount của Windows. Live không bị ảnh hưởng: camera demo vào *Đang chạy* sau khoảng 80 s và track đến qua SSE bình thường.
- Image worker nặng khoảng **13 GB** (API 1,1 GB, web 74 MB), phần lớn là PyTorch CUDA. Lần build đầu phải tải vài GB; các lần sau dùng cache.
- Bind mount `data/` trên Windows chậm hơn ổ trong WSL. Với dữ liệu lớn, nên đặt repo trong ổ WSL.
- Máy không có GPU NVIDIA: xóa khối `deploy` của `worker` và đặt `PLATE_DEVICE=cpu`. Image vẫn cài bản CUDA (vẫn chạy được trên CPU nhưng nặng). YOLO11l ở 1280 px trên CPU chậm, không đủ cho live.
