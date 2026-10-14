# Kiểm thử NestJS và PostgreSQL

Chạy từ thư mục backend sau khi cài dependency Node và môi trường Python phục vụ
kiểm tra nội dung ảnh/video:

```powershell
npm test
```

`npm test` biên dịch TypeScript và dùng Node test runner trên `dist/tests/*.test.js`.
Kiểm thử API/DB dùng **PostgreSQL thật**, HTTP qua ứng dụng NestJS thật, transaction,
constraint và quyền sở hữu thật. Bộ test API không cần checkpoint ML/GPU: các kết
quả hoàn tất là fixture được khai báo rõ; một test gọi worker với manifest lỗi giả
để kiểm tra không công bố kết quả từng phần. Upload ảnh vẫn được giải mã bởi Python.

## Database tạm độc lập

Nếu không đặt `TEST_DATABASE_URL`, helper tìm PostgreSQL 18/17/16/15 trong
`C:/Program Files/PostgreSQL/<version>/bin` trên Windows hoặc dùng `initdb` và
`pg_ctl` trên PATH ở Linux/macOS. Có thể đặt `PG_BIN` để chọn thư mục binary:

```powershell
$env:PG_BIN = 'C:/Program Files/PostgreSQL/18/bin'
npm test
```

Mỗi file test tạo cluster trong `data/test-postgres-<uuid>`, chọn cổng trống,
chỉ nghe `127.0.0.1`, dùng trust cho cluster tạm, áp dụng migration và dừng/xóa
đúng cluster đó sau test. Không khởi động/dừng service PostgreSQL đang cài trên máy.
`initdb --no-sync` chỉ dùng cho cluster dùng một lần này để giảm thời gian tạo DB.
Test Linux không chạy `initdb` bằng root; dùng tài khoản thường hoặc server test.

Nếu đã có một server **dành riêng cho kiểm thử**, có thể dùng:

```powershell
$env:TEST_DATABASE_URL = 'postgresql://test_user:password@127.0.0.1:5432/postgres'
npm test
```

Tài khoản này cần quyền `CREATEDB`. Helper tạo database `test_<uuid>` trên server,
chạy migration trong database mới rồi xóa riêng database đó khi kết thúc. Không
truncate, drop schema hoặc chạy migration vào database được chỉ trực tiếp bởi URL.
Không dùng thông tin truy cập production cho kiểm thử.

## Phạm vi kiểm tra

- Đăng nhập, giữ nguyên khoảng trắng mật khẩu, token băm trong DB, logout, thu hồi
  phiên sau đổi mật khẩu/vô hiệu hóa tài khoản, từ chối phiên hết hạn và chặn sửa
  admin cuối cùng. Tạo tài khoản chuẩn hóa email unique, không trả password hash;
  thay đổi vai trò có hiệu lực với cả phiên đang đăng nhập.
- User không truy cập được nguồn, job, kết quả, crop/frame, review hoặc CSV của
  user khác; admin có quyền xem. Không công bố storage key nội bộ trong response.
- Upload PNG được giải mã thật, từ chối ảnh giả/định dạng không hỗ trợ/file quá
  giới hạn và PNG đổi tên thành MP4; không để lại file tạm sau lỗi. Response file
  riêng tư gửi `no-store`, `nosniff`.
- Tạo nhiều job từ cùng nguồn giữ riêng snapshot cấu hình; không xóa job đang
  chạy/chờ hoặc media còn được tham chiếu.
- Hai review cùng revision chỉ một request thành công; output máy bất biến,
  text hiệu lực và tra cứu đổi theo review; lịch sử review được giữ.
- Không xác nhận được kết quả chưa đọc được; sửa văn bản không đổi `O` thành `0`;
  reject giữ lịch sử và xóa text hiệu lực khỏi tra cứu biển số.
- Tra cứu chỉ dùng lượt nhận dạng thành công mới nhất trên mỗi media; không bị
  lượt failed/running/detect-only mới hơn che mất; vẫn xem được lượt cũ qua ID.
- CSV có cả kết quả máy và sửa tay, escape dấu nháy và công thức bảng tính.
- Worker từ chối manifest lỗi, ghi trạng thái thất bại và không nhập kết quả dở.
- Pipeline thiếu model báo chưa sẵn sàng và không đưa job vào hàng đợi; video không
  được dùng chế độ `plate_crop`. Readiness trả 503 khi DB lỗi, liveness vẫn trả 200.
- Các test DB kiểm tra migration, FK/cascade và rollback.
- Joint OCR chỉ nhận video scene; mỗi prediction thuộc đúng một appearance hoặc
  detection. Kiểm tra năm crop từ năm frame khác nhau, thứ tự input, trọng số
  hợp lệ, agreement để NULL, và lưu transaction không tạo OCR giả từng crop.
- Swagger có schema response, phân trang, lỗi và endpoint tải file; hợp đồng
  metadata không công bố storage key hay đường dẫn model nội bộ.

Chạy riêng API sau build:

```powershell
npm run build
node --test dist/tests/api.test.js
```

Đánh giá độ chính xác OCR là công việc khác: dùng ground truth độc lập theo
[EVALUATION.md](EVALUATION.md). Test fixture thành công không chứng minh model
nhận dạng đúng hay pipeline đã được kiểm chứng trên video thật.
