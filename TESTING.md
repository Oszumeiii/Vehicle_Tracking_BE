# Kiểm thử backend NestJS + PostgreSQL

Xem cách chuẩn bị Node, PostgreSQL và Python tại [README.md](README.md).

## Kiểm thử tự động

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
npm test
.\.venv\Scripts\python.exe -m pytest -q
npm run format:check
```

`npm test` build TypeScript rồi kiểm thử HTTP NestJS, migration, quyền sở hữu,
review đồng thời, import SQLite và worker với PostgreSQL thật trong database tạm.
Chi tiết cấu hình và phạm vi: [TESTING_NEST.md](docs/TESTING_NEST.md).

Python kiểm thử các primitive extraction cũ, giao diện tracking 5 frame, adapter
ICPR và công cụ đánh giá. Fixture model chỉ phục vụ kiểm tra luồng; không chứng
minh accuracy OCR.

Lần chạy toàn bộ trước đợt rà soát API ngày 09/10/2026: **48 test Node và 98 test Python đều đạt**.
Node gồm 17 test API, 8 test DB/CLI, 4 test joint OCR, 5 test OpenAPI và 14 test
worker/registry/sidecar (tính cả test cha). Các suite tích hợp dùng PostgreSQL 18
tạm độc lập. TypeScript build và Prettier cũng đạt.

Sau đợt rà soát API cùng ngày, đã sửa Range ngoài file trả `416`/JSON thay vì
`500`, bổ sung kiểm tra version/checksum migration cho readiness và cập nhật
Swagger. Chạy lại **24/24 test API/OpenAPI đạt** (18 API + 6 OpenAPI, tính cả test
cha); build và format check đạt. Test mới xác nhận thiếu/sai migration OCR trả
`503` nhưng liveness vẫn hoạt động. Phần ML không thay đổi trong đợt rà soát này.

Checkpoint Kaggle thật đã strict-load và chạy inference thành công trên CPU.
Smoke test qua ML subprocess trên clip thật khoảng 3 giây xử lý 85 frame, chọn
43 frame và tạo một track với 5 crop ở frame `1, 21, 43, 65, 85`; manifest vượt
qua validator Node. Kết quả này xác nhận tích hợp chạy được, chưa đo accuracy do
chưa có nhãn chuẩn. Chi tiết tại [OCR_KAGGLE.md](docs/OCR_KAGGLE.md).

Đợt rà soát source ngày **11/10/2026**: **50 test Node và 98 test Python đạt**;
TypeScript build và Prettier đạt. Node chạy đủ các suite theo hai đợt: 18 API +
8 DB/CLI đã đạt trước khi phiên thực thi bị ngắt; sau đó chạy riêng ba suite
joint-results/OpenAPI/recognition, đạt 24 test (tính cả test cha), không fail,
cancel hoặc skip. `pip check` không thấy dependency hỏng; `npm audit --omit=dev`
trả 0 advisory production tại thời điểm kiểm tra.

Rà soát thêm bằng ca tái hiện độc lập phát hiện **6 lỗi P2 chưa nằm trong bộ test**:
EXIF orientation, checksum LF/CRLF, độ dài sau chuẩn hóa, NUL trong đầu vào,
oversized JSON và ánh xạ lỗi ảnh vượt giới hạn pixel. Test đạt không có nghĩa các
lỗi này đã được sửa. Chi tiết trigger, vị trí code và regression test cần thêm ở
[SOURCE_REVIEW_2026-10-11.md](docs/SOURCE_REVIEW_2026-10-11.md).

## Nghiệm thu qua Swagger

Chạy migration, tạo Admin và mở hai terminal `npm start`, `npm run worker` theo
README. Swagger ở `http://127.0.0.1:3000/docs`.

1. Login Admin bằng `/api/v2/auth/login`, copy access token vào **Authorize**.
2. Tạo hai User bằng `/api/v2/users`. Dùng hai phiên riêng để kiểm tra quyền.
3. User A upload một PNG/JPG bằng `/api/v2/media`. Đối chiếu kích thước, MIME,
   `content_url`; User B không đọc được URL này.
4. Gọi `/api/v2/pipelines`. Cấu hình Kaggle có profile `task=prepare` không yêu
   cầu OCR và `pbl6-resnet34c-joint5-v1` nhận diện video. Thiếu checkpoint/code/Python
   phải thấy `ready=false` và tạo job trả `503`.
5. Với detector đã cấu hình, tạo job từ `media_id` và `pipeline_id`, đợi trạng
   thái kết thúc. Ảnh đã crop dùng `input_mode=plate_crop`; video dùng `scene`.
6. Mở results/detail: ảnh có một kết quả cho mỗi detection; video mỗi track hợp
   lệ có đúng năm crop từ năm frame khác nhau. Track thiếu năm frame nằm trong
   thống kê bị loại, không được nhân bản crop cho đủ.
7. Với prepare, OCR phải `not_run` và predictions rỗng. Nhập tay bằng `correct`
   với `expected_revision=0`; gửi lại revision cũ phải nhận `409`. Trạng thái OCR
   còn nguyên, review mới tăng revision và đổi effective text; `confirm` trả `422`.
   Với Kaggle joint, mỗi track có một prediction cấp appearance, liên kết đúng
   năm detection theo thời gian; `agreement_count=null`, `ocr_score=null` và năm
   `frame_weights`. Không có prediction riêng từng crop. Ảnh đơn hoặc video
   `plate_crop` gửi vào profile joint phải trả `422` trước khi tạo job.
8. Tra cứu bằng effective text mới. Chạy lại cùng media phải tạo ID job khác;
   tra cứu dùng lượt nhận diện thành công mới nhất. Lượt cũ còn xem qua job ID.
9. Xuất CSV có cả kết quả máy, kết quả hiệu lực và vị trí frame/timestamp. User B
   không đọc được job, result, crop, keyframe hoặc CSV của User A.
10. Xóa job đã kết thúc: nguồn vẫn còn. Media còn job tham chiếu phải trả `409`
    khi xóa. Job queued/running không được xóa.
11. Admin khóa tài khoản A: token cũ của A phải trả `401`. Logout và reset password
    cũng thu hồi phiên theo hợp đồng API.

Với dữ liệu thật, thử thêm ảnh không/một/nhiều biển số, video thiếu năm frame,
track ghép sai, OCR rỗng/sai, file hỏng và worker bị gián đoạn. Với adapter đọc
từng crop riêng, thử thêm các dự đoán bất đồng. Sau restart,
job đang chạy bị gián đoạn chuyển `failed` với lỗi `WORKER_INTERRUPTED`; chạy lại
bằng một job mới. `succeeded` chỉ khẳng định xử lý hoàn tất.

Độ chính xác phải đo với nhãn độc lập theo [EVALUATION.md](docs/EVALUATION.md).
