## 7 Quy trình nghiệp vụ và sơ đồ hoạt động

Các activity diagram mô tả hành động, quyết định và nhánh kết thúc của backend hiện có. Trách nhiệm của từng thành phần được giải thích trong phần mô tả và sequence diagram. Tương tác trên màn hình là yêu cầu cho client; không xác nhận dự án đã có frontend hoàn chỉnh.

### 7.1 Xử lý video và nhận diện năm crop

Người dùng upload một video, chọn profile và tạo job. API kiểm tra phiên, quyền sở hữu và cấu hình trước khi ghi trạng thái `queued`, rồi trả `202`. Worker nhận việc độc lập. Một HTTP request không phải chờ hết quá trình chạy model.

Worker kiểm tra nguồn và snapshot; adaptive sampling (8/12/15 fps theo mức chuyển động) chọn frame, empty-scene gate (MOG2) bỏ qua frame nghi trống khi không còn track, YOLO11l phát hiện biển số và BoT-SORT nối các quan sát. Mỗi track đủ điều kiện cung cấp đúng năm crop từ năm frame khác nhau: chọn trong nhóm crop nét/lớn/tin cậy nhất rồi trải đều theo thời gian. Track thiếu bằng chứng bị loại khỏi nhánh nhận diện và được thống kê; không lặp ảnh để đủ năm.

Model SE-ResNet34-C nhận đồng thời năm crop RGB 192×48 để tạo một chuỗi cho track; decoder `beam_filter` ưu tiên chuỗi đúng định dạng biển Brazil/Mercosul. Chuỗi rỗng có trạng thái `unreadable`; chuỗi khác rỗng là `readable`, vẫn chưa được con người xác nhận. `agreement_count` để NULL vì không có năm phiếu OCR độc lập. Model không cung cấp confidence đã định nghĩa nên `ocr_score` là NULL. `frame_weights` chỉ mô tả trọng số tổng hợp đặc trưng. `decoding` lưu greedy text, `format_valid` và beam score heuristic; `statistics.vehicle_groups` gợi ý các track nhiều khả năng cùng một xe.

![Hoạt động nhận diện video](diagrams/02-activity-video.png)

Nếu không có track hợp lệ, job vẫn `succeeded` với kết quả rỗng. Nếu checkpoint thay đổi, video không giải mã được, subprocess lỗi, timeout hoặc manifest không hợp lệ, job chuyển `failed`. Kết quả chỉ được công bố sau transaction lưu toàn bộ dữ liệu thành công.

### 7.2 Chuẩn bị ảnh và kiểm duyệt thủ công

Nguồn ảnh hỗ trợ `scene` và `plate_crop`. Với scene, mỗi detection tạo một appearance. Với plate_crop, hệ thống dùng toàn ảnh làm vùng biển số và bỏ qua detector. Profile prepare không gọi OCR: `machine_status=not_run`, `machine_text=null`, không có prediction. Người dùng có thể đọc bằng chứng rồi dùng `correct`, `unreadable` hoặc `reject`; không thể `confirm` khi chưa có text máy.

![Hoạt động chuẩn bị ảnh](diagrams/03-activity-image.png)

Nhận diện tự động ảnh đơn là một phần của phạm vi mục tiêu ban đầu nhưng chưa được checkpoint Kaggle hiện tại hỗ trợ. Backend đã có hợp đồng adapter một crop để mở rộng; cấu hình mẫu chưa phải model ảnh đang sẵn sàng sử dụng.

### 7.3 Kiểm duyệt kết quả

Tại thời điểm mở chi tiết, client nhận bằng chứng, dự đoán và `revision`. Mọi thao tác kiểm duyệt phải gửi lại `expected_revision`. API khóa appearance trong transaction; nếu revision đã đổi, trả `409`, client tải lại kết quả để tránh ghi đè ý kiến của người khác.

![Hoạt động kiểm duyệt](diagrams/04-activity-review.png)

`confirm` đặt text hiệu lực bằng text máy; `correct` đặt bằng text đã chuẩn hóa do người duyệt nhập. `unreadable` và `reject` đặt text hiệu lực NULL, nhưng giữ nguyên dự đoán và lịch sử. Không có thao tác sửa hay xóa một bản ghi review riêng trong API hiện hành. Sau khi một kết quả đã bị reject, người có quyền vẫn có thể tạo review mới ở revision hiện tại để đưa ra kết luận khác.

### 7.4 Tra cứu và xuất dữ liệu

Tra cứu áp dụng quyền sở hữu trước khi trả kết quả. Với mỗi media, hệ thống chọn job v2 thành công mới nhất theo `created_at` và ID; profile prepare cũng thuộc nhóm này. Sau đó mới lọc text hiệu lực, trạng thái kiểm duyệt, nguồn và thời gian upload. Job failed/queued/running không thay thế kết quả thành công trước đó. Job thành công mới có kết quả rỗng vẫn thay thế lượt cũ trong tìm kiếm mặc định.

![Hoạt động tra cứu và xuất CSV](diagrams/05-activity-search.png)

CSV xuất theo một job cụ thể và kiểm tra quyền độc lập. Mỗi dòng là một appearance, có cả text máy và text hiệu lực, trạng thái duyệt, phương pháp nhận diện, vị trí frame/timestamp. CSV không phải bộ nhãn chuẩn đánh giá model. Không sử dụng text đã sửa để báo accuracy máy một cách tự động.

## 9 Mô hình trạng thái

### 9.1 Trạng thái job

`status` mô tả vòng đời xử lý; `stage` cho biết bước đang chạy. Stage gồm validating, detection_tracking, recognition, persisting và kết thúc complete/failed. Prepare không có bước recognition. API không tự suy ra phần trăm tiến độ nếu worker không có số liệu.

![Trạng thái job](diagrams/11-state-job.png)

Worker đang chạy giữ advisory lock ở cấp database. Khi một worker hợp lệ khởi động lại, các job còn `running` được đánh dấu `failed` với `WORKER_INTERRUPTED`; không âm thầm tiếp tục từ file kết quả dở. Người dùng tạo job mới trên cùng media để chạy lại. Bản đầu không có retry theo cùng ID hoặc hủy job đang chạy.

### 9.2 Trạng thái kiểm duyệt và trạng thái máy

Hai trạng thái độc lập. Máy có thể `readable`, `unreadable`, `ambiguous` hoặc `not_run`. `ambiguous` có ý nghĩa ở nhánh OCR từng crop và bỏ phiếu; profile joint hiện tại không tạo trạng thái này. Review bắt đầu `pending`, sau đó phản ánh hành động mới nhất.

![Trạng thái kiểm duyệt](diagrams/14-state-review.png)

Mọi trạng thái review đều có thể nhận thao tác tiếp theo hợp lệ. Sơ đồ rút gọn các chuyển tiếp lặp bằng trạng thái lựa chọn hành động; đây không phải một trạng thái được lưu trong DB. Mỗi lần commit tăng revision một đơn vị và thêm lịch sử, không thay đổi trạng thái máy.

## 12 Kiến trúc hệ thống và triển khai

### 12.1 Ranh giới hệ thống

Client gọi API NestJS bằng Bearer token. API chịu trách nhiệm xác thực, phân quyền, validation, upload, query và review. Worker Node là tiến trình riêng, lấy việc từ PostgreSQL và điều khiển subprocess Python. Python chạy detector, tracking và OCR; không trực tiếp quản lý tài khoản hoặc ghi bảng nghiệp vụ.

![Kiến trúc thành phần](diagrams/15-architecture.png)

PostgreSQL giữ trạng thái hàng đợi và metadata; filesystem riêng giữ media, crop, keyframe, log và manifest. Nhóm bảng `plate_appearances`, `plate_detections`, `ocr_predictions`, `recognition_reviews` phân biệt lần xuất hiện, bằng chứng, kết luận máy và kết luận con người. Không xây bảng phương tiện hoặc chủ xe vì vượt phạm vi hiện hành.

### 12.2 Thành phần triển khai

API và worker có thể chạy hai terminal trên một host ở bản đầu, cùng truy cập database và storage. Máy phải có Node.js, PostgreSQL, môi trường Python tương thích và các checkpoint được cấu hình trước. File JSON profile là cấu hình quản trị phía server; client chỉ gửi `pipeline_id`.

![Triển khai bản đầu](diagrams/16-deployment.png)

Khi đóng gói hoặc chuyển host, phải đưa theo migration SQL, mã `app/recognition`, checkpoint detector/OCR đúng checksum, đồng thời cấu hình storage dùng chung giữa API/worker. Đường dẫn local trong snapshot phục vụ tái lập trên môi trường đã cấu hình; không trả ra API. `ready=true` của profile chỉ xác nhận file/cấu hình/checksum, không thay thế một job smoke test để kiểm chứng Python/CUDA và model load.

### 12.3 An toàn dữ liệu và vận hành

- Session token được sinh ngẫu nhiên và DB chỉ lưu hash; password dùng scrypt. Khóa tài khoản hoặc đổi mật khẩu thu hồi các phiên của tài khoản.
- Nguồn và bằng chứng chỉ được đọc qua endpoint kiểm tra quyền. Không public thư mục data. Media content hỗ trợ Range, `206` và `416`; lỗi trả JSON và không lộ path server.
- Review và nhập kết quả dùng transaction PostgreSQL. Xóa sử dụng quarantine file rồi commit DB, restore khi transaction lỗi. PostgreSQL và filesystem không tạo thành transaction phân tán; cần kiểm tra rác/dữ liệu sau sự cố nguồn điện hoặc ổ đĩa.
- `/health` là liveness. `/health/ready` kiểm tra database cùng tập version/checksum migration. Không endpoint health nào hiện xác nhận worker đang sống hoặc GPU đủ bộ nhớ.
- Backup phải ghép một bản database nhất quán với storage tương ứng. Khôi phục cần đối chiếu các storage key và checkpoint trước khi mở lại job; đây là quy trình vận hành đề xuất, chưa có API backup/restore.
- Logging không được ghi password hoặc access token. Quyền đọc log/checkpoint chỉ dành cho người vận hành host. API chỉ trả thông báo lỗi an toàn; log giữ chi tiết để chẩn đoán.

### 12.4 Các quyết định thiết kế

| Quyết định | Lý do và hệ quả |
|---|---|
| NestJS cho API và worker điều phối | Gom nghiệp vụ TypeScript, tách xử lý ML nặng ra Python subprocess. |
| PostgreSQL thay SQLite nghiệp vụ | FK, transaction và khóa hỗ trợ nhiều tài khoản cùng kiểm duyệt. Dữ liệu SQLite của bản FastAPI đầu đã ngừng sử dụng. |
| Upload tách tạo job | Nhiều lượt chạy trên cùng media; giữ lịch sử và snapshot độc lập. |
| Một worker với hàng đợi DB | Đủ phạm vi bản đầu, chưa cần Redis/Celery; advisory lock chặn hai worker cùng điều phối. |
| Prediction bất biến ở tầng ứng dụng | Giữ bằng chứng đánh giá; `effective_text` là bản chiếu cập nhật theo review trong cùng transaction. |
| Joint OCR lưu ở appearance | Biểu diễn đúng model nhận năm frame đồng thời, không tạo năm kết quả giả. |
| File ngoài DB | Tránh ảnh/video Base64 trong bảng; phải quản lý sao lưu và xóa file cùng metadata. |
