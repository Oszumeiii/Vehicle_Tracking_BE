# Kịch bản demo

Demo khoảng 10 phút, đi qua cả hai nguồn của hệ thống: video upload và camera live. Chạy trên máy dev Windows có GPU (RTX 4060 8 GB).

## Chuẩn bị (làm trước buổi demo)

1. **Môi trường:**
   - có `.env` (copy từ `.env.example`), `.venv` cài `requirements-inference.txt`, checkpoint trong `models/` (xem README, mục *Chuẩn bị inference*);
   - FE `../Vehicle_Tracking_FE` đã `npm install`.
2. **Tài khoản admin:**
   ```powershell
   $env:PLATE_ADMIN_PASSWORD = '<mật khẩu 12-128 ký tự>'
   npm run admin:create -- --email admin@example.com
   ```
   Camera demo chỉ admin mới tạo được.
3. **Video demo cho camera offline:**
   - chép 1–2 video giao thông vào `data/demo-videos/` (`.mp4`, `.mov`, `.mkv`, `.avi`, `.webm`), không commit vào git;
   - nên dùng đoạn ghi từ chính camera YouTube, ví dụ 3 phút luồng Camboriú, 1080p30, khoảng 110 MB;
   - **ghi vào ban ngày theo giờ Brazil** (khoảng 11:00–22:00 UTC, tức 18:00–05:00 giờ Việt Nam). Đo trên một vòng 3 phút có vùng loại trừ: clip ghi lúc 4h sáng ở Brazil cho khoảng 2 track, còn clip ghi lúc 13h (`camboriu-day.mp4`) cho **35 track, trong đó 9 track `readable`**, bỏ 0,3% frame. Luồng YouTube thật cũng vậy: demo vào ban ngày Việt Nam là đêm ở Camboriú, nên camera video demo thường đông xe hơn;
   - có thể ghi bằng yt-dlp + ffmpeg (`-c:v copy`, xem `app/live/source.py:resolve_youtube` để lấy URL HLS).
4. **Một video ngắn** (15–60 s) để demo phần upload.
5. **Chạy thử lần cuối** trước giờ demo: nhấp đúp `start-all.cmd`.
   - Lần đầu script tự sao lưu DB vào `data/backups/` rồi migrate.
   - Bật một phiên trên camera demo để model nạp sẵn vào cache và kiểm tra GPU.

## Thời gian đo được (để chia giờ demo)

Đo trên máy dev ngày 25/10/2026, qua các lần chạy thật trong `TESTING.md`:

| Bước | Thời gian |
|---|---|
| `start-all.cmd` khi Docker đã tắt (bật Docker, build, migrate) | khoảng 2–3 phút; chạy trước khi lên trình bày |
| Bật phiên camera, lần đầu sau khi khởi động (nạp model) | 40–75 s đến *Đang chạy* |
| Bật phiên khi model đã nằm trong cache đĩa | khoảng 35–40 s |
| Biển số đầu tiên trên feed (camera ban ngày) | thường dưới 20 s sau *Đang chạy* |
| Job upload video 20 s, 1080p | khoảng 40 s |
| Cảnh báo watchlist trên camera demo | khi clip lặp lại, tối đa khoảng 3 phút |
| Dừng phiên | vài giây đến khi *Đã dừng* |

Vì việc bật phiên mất gần một phút, nên bật camera demo ngay sau khi chuyển sang tab **Camera live**, rồi nói phần kiến trúc trong lúc chờ. Thêm biển watchlist sớm (ngay khi thấy biển đầu tiên) để cảnh báo kịp xuất hiện trong buổi demo.

## Khởi động

```powershell
.\start-all.cmd            # Docker, PostgreSQL, build, migrate, API, worker, FE, mở trình duyệt
```

Có 3 cửa sổ: **API**, **WORKER**, **WEB**. Đợi dòng `Ready: web http://localhost:5173`.

## Kịch bản

| # | Thao tác | Điểm cần nói |
|---|---|---|
| 1 | Đăng nhập; tab **Video mới**, upload video ngắn, chọn pipeline joint | Detector YOLO11l, tracking BoT-SORT, OCR joint 5 frame; job chạy trong worker riêng |
| 2 | Khi job xong: xem các biển, mở crop/keyframe, sửa một biển (review) | Kết quả máy giữ nguyên; review có revision. Xuất CSV |
| 3 | Thanh bên: **Tìm biển số** | Tra cứu kết quả đã lưu, không xử lý lại |
| 4 | Tab **Camera live** → camera **Demo (video)** → **Bật phiên** | Khoảng 40 s để nạp model và mở nguồn; trạng thái chuyển *Đang chạy* |
| 5 | Xem feed **Biển số real-time** và stats (frame, độ trễ, track đang mở) | Mỗi track đã chốt là một kết quả, đẩy qua SSE trong khoảng 4 s |
| 6 | Bấm một thẻ biển → hộp bằng chứng 5 keyframe | Bằng chứng giống luồng upload; sau 24 h chỉ giữ 1 keyframe |
| 7 | Tab **Watchlist**: thêm một biển vừa thấy | Khi xe đó xuất hiện lại sẽ có toast cảnh báo và âm báo. Video demo lặp mỗi 3 phút nên cảnh báo xuất hiện trong buổi demo |
| 8 | Tab **Vùng loại trừ**: kéo một vùng quanh biển tên đường | Detector hay nhầm bảng cố định là biển số; áp dụng từ phiên kế tiếp |
| 9 | Tab **Lịch sử** | Gộp theo lượt xuất hiện: cùng biển trong 5 phút là một dòng |
| 10 | (Nếu mạng tốt) camera **YouTube** Camboriú → **Bật phiên** | Luồng thật, giờ chụp lấy theo đồng hồ của luồng HLS |
| 11 | Công tắc **Chạy 24/7**; dừng phiên | Worker tự bật lại sau sự cố; dừng tay thì tắt 24/7 |

Mỗi lúc chỉ chạy được một phiên live (GPU 8 GB), và job upload chờ trong lúc có phiên live. Vì vậy hãy demo phần upload (bước 1–3) trước, hoặc dừng phiên live trước khi upload.

## Phương án dự phòng

- **Mạng tới YouTube yếu** (1080p cần khoảng 4 Mbit/s ổn định): dùng camera demo, hoặc bật phiên với `max_height: 720` (API hoặc `auto_settings`).
- **Phiên đứng ở *Đang chờ*:** một job upload đang chạy, chờ job xong hoặc hủy job.
- **Phiên lỗi `CHECKPOINT_MISSING` / `CUDA_UNAVAILABLE`:** kiểm tra `models/` và driver GPU (`nvidia-smi`), rồi chạy lại.
- **Không thấy biển nào:** kiểm tra vùng loại trừ có che mất đường không; thử video demo khác.
- **Lỡ đóng cửa sổ worker:** chạy lại `start-all.cmd`. Dịch vụ đang chạy được giữ nguyên; phiên cũ chuyển *Bị gián đoạn*, camera 24/7 tự bật lại.

## Sau buổi demo

- Đóng các cửa sổ API, WORKER, WEB. `docker compose stop` để tắt PostgreSQL.
- Dữ liệu demo: xóa phiên trong API (`DELETE /api/v2/live-sessions/{id}`) hoặc để retention tự dọn (track không review sau 7 ngày).
- Bản sao lưu nằm ở `data/backups/*.dump`; khôi phục bằng `pg_restore` (xem [OPERATIONS.md](OPERATIONS.md)).
