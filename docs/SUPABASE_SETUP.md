# Triển khai Supabase cho Vehicle Tracking

`PLATE_DB_BACKEND=sqlite` giữ dữ liệu local. `supabase` lưu metadata trong PostgreSQL (`videos`, `jobs`, `plate_sightings`, `crops`) và crop JPEG trong bucket private `vehicle-frames`. Dữ liệu SQLite cũ không tự chuyển sang PostgreSQL.

Không còn `teams`, `team_members` hay `PLATE_TEAM_ID`. **Mọi tài khoản Supabase Auth đã đăng nhập đều xem, gửi và xóa được dữ liệu chung.** Hãy tắt đăng ký công khai trong Supabase Auth và chỉ mời người trong nhóm dev. Nếu cần vai trò khác nhau hoặc giới hạn theo từng người, phải bổ sung cơ chế phân quyền mới trước khi mở đăng ký.

## Cấu hình `.env`

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
SUPABASE_DB_URL=postgresql://USER:PASSWORD@HOST:5432/postgres?sslmode=require
SUPABASE_SECRET_KEY=your-server-secret-key
PLATE_DB_BACKEND=supabase
PLATE_NODE_ID=dev-huan
```

Sao chép chuỗi PostgreSQL từ Supabase **Connect → Direct → Session pooler**. Dùng endpoint direct nếu môi trường của bạn có IPv6. Worker cần kết nối giữ session để dùng advisory lock; không dùng Transaction pooler. `SUPABASE_SECRET_KEY` và `SUPABASE_DB_URL` chỉ nằm trên backend/worker. Publishable key không thay thế secret key hay mật khẩu PostgreSQL.

API và worker cùng node cần dùng cùng `PLATE_NODE_ID` và thư mục dữ liệu local. Node khác dùng ID khác, vì video nguồn/working files vẫn trên local. Metadata và ảnh crop được chia sẻ qua Supabase.

## Migration

Nếu database chưa có các bảng nghiệp vụ, chạy toàn bộ migration từ repo root:

```bash
python -m scripts.migrate_db
```

Nếu muốn xóa toàn bộ metadata Vehicle Tracking hiện có để làm lại từ đầu, dán [reset_vehicle_tracking.sql](../supabase/reset_vehicle_tracking.sql) vào SQL Editor, chạy, rồi dán [initial_schema.sql](../supabase/migrations/20261017000100_initial_schema.sql) và chạy. Reset sẽ xóa job, video, sighting và crop metadata; nó không xóa tài khoản Auth, bucket hoặc ảnh Storage cũ. Xóa ảnh cũ trong Storage Dashboard nếu muốn giải phóng dung lượng. Không dùng `DROP TABLE ... CASCADE`.

`scripts.migrate_db` lưu lịch sử/checksum trong `vehicle_private.schema_migrations`. Nếu tạo schema trực tiếp bằng SQL Editor, không chạy script migration lại trên cùng schema khi chưa có bản ghi lịch sử; reset rồi chọn một cách triển khai thống nhất.

## Đăng nhập và API

Tạo/invite các tài khoản ở Supabase Dashboard → Authentication → Users. Frontend đăng nhập qua Supabase Auth rồi gửi access token cho tất cả `/api/v1/plate-jobs` và `/api/v1/plate-sightings`:

```http
Authorization: Bearer <access_token>
```

Backend xác minh token bằng Supabase Auth. RLS chỉ cho role `authenticated` đọc bốn bảng và ảnh crop có metadata; client không được tự sửa bảng. Backend dùng DB credential/Storage secret để xử lý ghi/xóa sau khi xác minh token. Endpoint inference `/api/v1/model/*` vẫn giữ hành vi cũ và chưa nằm trong lớp xác thực job API.

API crop trả redirect 307 tới signed URL 60 giây. Frontend cần gọi endpoint với Bearer token trước; thẻ `<img>` không tự thêm header. API tìm biển chính xác:

```http
GET /api/v1/plate-sightings?plate=30A12345&limit=50&offset=0
Authorization: Bearer <access_token>
```

Worker upload crop trước rồi nhập kết quả và đánh dấu succeeded trong một PostgreSQL transaction. `storage-uploads.json` giữ danh sách path cho cleanup nếu cần; Storage và PostgreSQL không có transaction chung. Xóa job qua API node nguồn để dọn cả local files và Storage.

## Kiểm thử

```bash
python -m pytest -q
```

Test PostgreSQL cần database trống, dùng một lần, có `VEHICLE_TEST_PG_DSN`. Fixture tạo stub Auth/Storage để kiểm thử migration, RLS, rollback, worker lock và kết quả OCR; không dùng database dev thật làm database test.
