# Phân tích nghiệp vụ và thiết kế hệ thống

Nhận diện biển số độ phân giải thấp

Phiên bản 1.1 · 14/10/2026

## 1. Mục tiêu, bối cảnh và thuật ngữ

### 1.1. Bài toán

Ảnh biển số nhỏ, mờ hoặc xuất hiện ngắn trong video khiến việc đọc tự động thiếu ổn định. Hệ thống tiếp nhận ảnh/video, tìm vùng biển số, lưu bằng chứng, nhận diện khi có model phù hợp, cho phép con người kiểm duyệt và tra cứu kết quả. Mỗi lần chạy phải giữ cấu hình và dự đoán gốc để giải thích, đối chiếu và đánh giá đồ án.

Đơn vị quản lý là **một lần xuất hiện của biển số trong một job**. Đây không phải hồ sơ phương tiện. Hai lần xuất hiện có cùng chuỗi biển số vẫn là hai kết quả; hệ thống không suy ra chủ xe hay hành trình liên camera.

### 1.2. Mục tiêu nghiệp vụ

- Giảm thao tác tìm/cắt biển số và đọc thủ công trên dữ liệu tải lên.
- Tách dự đoán máy khỏi kết luận người kiểm duyệt, có lịch sử sửa đổi.
- Tái sử dụng nguồn để chạy cấu hình khác, truy lại bằng chứng và phiên bản model.
- Phân quyền dữ liệu theo tài khoản, hỗ trợ xuất kết quả và đánh giá có nhãn chuẩn.

Pipeline và model OCR được tích hợp theo notebook Kaggle của nhóm `trnvnhun/pbl6-pipeline` (checkpoint SE-ResNet34-C `single_model_best.pt`, dataset `trnvnhun/icpr-2026-model`); miền huấn luyện là biển số Brazil/Mercosul. Chất lượng trên Việt Nam cần đánh giá riêng. Tài liệu này không đặt mục tiêu accuracy hoặc thời gian đáp ứng khi chưa có phép đo và điều kiện nghiệm thu thống nhất.

### 1.3. Thuật ngữ

| Thuật ngữ | Ý nghĩa trong dự án |
|---|---|
| Media | Một ảnh/video nguồn do tài khoản upload; có thể dùng cho nhiều job. |
| Job | Một lượt xử lý nguồn với cấu hình đã đóng băng. |
| Appearance | Một biển số phát hiện trong ảnh hoặc một track đủ điều kiện trong video. |
| Detection / crop | Một quan sát biển số và ảnh cắt tương ứng; bbox gốc có thể khác crop có padding. |
| Track | Chuỗi quan sát được tracker liên kết trong một job; không phải danh tính xe. |
| Joint-five OCR | Model nhận đồng thời năm crop để tạo một dự đoán cho track. |
| Prepare | Chỉ chuẩn bị detection/tracking và bằng chứng, chưa chạy OCR. |
| Machine text | Chuỗi máy dự đoán, không bị ghi đè khi kiểm duyệt. |
| Effective text | Chuỗi có hiệu lực để hiển thị/tra cứu sau quy tắc kiểm duyệt. |
| Review / revision | Một thao tác kiểm duyệt / số phiên bản để phát hiện sửa đồng thời. |
| Pipeline snapshot | Phiên bản, checksum và cấu hình thực tế của lượt chạy. |

## 2. Bên liên quan và phân quyền

**User** chuẩn bị nguồn, theo dõi job, đối chiếu bằng chứng và xử lý kết quả thuộc dữ liệu của mình. **Admin** có các chức năng đó trên toàn hệ thống và quản lý tài khoản. Người vận hành triển khai API/worker, backup và chuẩn bị checkpoint; đây là trách nhiệm vận hành, không phải một vai trò đăng nhập bổ sung. Nhóm nghiên cứu chuẩn bị nhãn chuẩn và thực hiện đánh giá offline.

| Chức năng | Chưa đăng nhập | User | Admin |
|---|---|---|---|
| Đăng nhập | Có, nếu được cấp tài khoản | Có | Có |
| Đăng xuất, xem tài khoản hiện tại | Không | Phiên của mình | Phiên của mình |
| Upload, xem danh sách/nguồn | Không | Dữ liệu của mình | Toàn hệ thống |
| Xem pipeline được phép chạy | Không | Có | Có |
| Tạo/chạy lại, theo dõi, xóa job | Không | Nguồn của mình | Toàn hệ thống |
| Xem bằng chứng, kiểm duyệt | Không | Dữ liệu của mình | Toàn hệ thống |
| Tra cứu, xuất CSV, xóa nguồn | Không | Dữ liệu của mình | Toàn hệ thống |
| Tạo, khóa, đổi vai trò/reset mật khẩu | Không | Không | Có |
| Sửa checkpoint, interpreter qua API | Không | Không | Không |

Quyền kế thừa từ `media_assets.owner_id` sang job, appearance, detection và export. Admin được xử lý nguồn của người khác nhưng quyền sở hữu nguồn không đổi. Request truy cập ID không thuộc quyền trả `404`; truy cập chức năng quản trị bằng User trả `403`.

## 3. Phạm vi và trạng thái triển khai

### 3.1. Phạm vi bản đầu

Đã có các nhóm chức năng tài khoản, upload, pipeline/job, bằng chứng, kiểm duyệt, tra cứu và CSV: **21 endpoint v2** cùng health check vận hành. API và worker tách tiến trình; PostgreSQL giữ metadata, filesystem riêng giữ nguồn và bằng chứng. Không mở đăng ký công khai.

| Nội dung | Kế hoạch ban đầu | Hiện trạng áp dụng |
|---|---|---|
| Ảnh scene/plate_crop | Phát hiện và đọc từng crop | Prepare hỗ trợ ảnh; OCR ảnh đơn cần adapter/checkpoint phù hợp. |
| Video | Detection/tracking, chọn 5 crop | Adaptive Sampling → empty-scene gate → YOLO11l → BoT-SORT, không ReID → 5 crop khác frame, chọn theo chất lượng. |
| Tổng hợp OCR video | Đọc từng crop, đa số 3/5 | Model Kaggle đọc đồng thời 5 crop; một dự đoán joint, không bỏ phiếu 3/5. |
| Thực hiện thủ công | Xác nhận/sửa kết quả | Có; prepare cho phép nhập bằng `correct`, không `confirm` khi chưa có text máy. |
| Dự đoán từng ảnh | Lưu prediction theo detection | Hợp đồng mở rộng vẫn hỗ trợ; profile OCR hiện hành dùng prediction cấp appearance. |
| Tăng độ phân giải | Tùy model | Chưa có nhánh SR thực trong profile Kaggle; không tạo ảnh enhanced giả. |

### 3.2. Ngoài phạm vi

Camera trực tiếp, bãi xe, vé/thu phí, chủ phương tiện, xử phạt, nhận dạng danh tính xe, chia sẻ dữ liệu công khai, huấn luyện model và tự động sửa biển số theo luật quốc gia không thuộc bản đầu. Không có API hủy job đang chạy hoặc retry tại chỗ; chạy lại tạo job mới. Frontend hoàn chỉnh, OCR ảnh đơn và thẩm định accuracy trên tập nhãn độc lập là các hạng mục riêng cần tiếp tục khi triển khai sản phẩm/đánh giá.

## 4. Yêu cầu chức năng và phi chức năng

### 4.1. Yêu cầu chức năng

| Mã | Yêu cầu và tiêu chí chấp nhận | Use case |
|---|---|---|
| FR01 | Đăng nhập tài khoản hoạt động; cấp phiên có hạn; logout thu hồi phiên; xem thông tin hiện tại. | UC01 |
| FR02 | Admin tạo/cập nhật/khóa tài khoản, đặt lại mật khẩu; bảo vệ Admin hoạt động cuối cùng. | UC02 |
| FR03 | Kiểm tra quyền trên metadata, file, bằng chứng, review và CSV. | UC02-UC12 |
| FR04 | Upload một file, kiểm tra loại/dung lượng/giải mã, ghi owner và metadata. | UC03 |
| FR05 | Liệt kê nguồn, đọc nội dung có xác thực, hỗ trợ byte range cho video. | UC03, UC06 |
| FR06 | Liệt kê profile và khả năng xử lý; client chỉ chọn ID được cấu hình trên server. | UC04 |
| FR07 | Tạo job bất đồng bộ từ nguồn có sẵn; mỗi lần chạy tạo ID và snapshot riêng. | UC04 |
| FR08 | Worker nhận job, cập nhật trạng thái/giai đoạn/thống kê; lỗi không thành kết quả thành công. | UC05 |
| FR09 | Prepare ảnh scene phát hiện nhiều biển số; plate_crop bỏ qua detector. | UC12 |
| FR10 | Video tracking, chọn đúng 5 crop từ 5 frame khác nhau theo thời gian; thống kê track bị loại. | UC04, UC12 |
| FR11 | OCR Kaggle nhận 5 crop thật, trả prediction joint có provenance; score không có thì để null. | UC04, UC06 |
| FR12 | Xem kết quả job thành công, crop/keyframe, dự đoán và lịch sử review. | UC06 |
| FR13 | Confirm/correct/unreadable/reject với expected_revision; lưu lịch sử và text hiệu lực nguyên tử. | UC07 |
| FR14 | Tra cứu khớp text chuẩn hóa, lọc nguồn/trạng thái duyệt/thời gian upload, có phân trang. | UC08 |
| FR15 | Mặc định tra cứu job v2 thành công mới nhất mỗi nguồn; giữ khả năng xem job cũ. | UC08 |
| FR16 | Xuất CSV job thành công, có kết quả máy, hiệu lực, trạng thái và vị trí xuất hiện. | UC09 |
| FR17 | Xóa job kết thúc, giữ nguồn; xóa nguồn chỉ khi hết tham chiếu job. | UC10, UC11 |
| FR18 | Quản lý phiên bản schema bằng migration có checksum; dữ liệu lịch sử (job `detect_only` cũ) vẫn đọc được qua API hiện hành, không suy diễn OCR. | UC05, UC06; vận hành |

### 4.2. Yêu cầu phi chức năng

| Mã | Yêu cầu | Cách kiểm chứng / giới hạn |
|---|---|---|
| NFR01 | Bảo mật truy cập và bí mật xác thực | Test tài khoản chéo; mật khẩu hash scrypt, DB chỉ lưu hash token; không lộ đường dẫn nội bộ. |
| NFR02 | Toàn vẹn dữ liệu và cập nhật đồng thời | FK, unique/check, transaction; test hai review cùng revision chỉ một lần thành công. |
| NFR03 | Tái lập và truy vết | Giữ snapshot/checksum, raw/normalized text, input crop và lịch sử; đối chiếu lại một lượt chạy. |
| NFR04 | Xử lý dài không giữ request HTTP | Tạo job trả 202; inference trong worker riêng; đo thời gian theo thiết bị và nguồn thực. Chưa cam kết SLA. |
| NFR05 | Phục hồi lỗi có trạng thái rõ | Worker khởi động lại đánh dấu job running cũ là failed/WORKER_INTERRUPTED; người dùng tạo lượt mới. |
| NFR06 | Giới hạn tài nguyên và đầu vào | Upload mặc định 500 MiB, ảnh tối đa 25 MP; limit tối đa 200; cấu hình timeout phía server. |
| NFR07 | Khả năng vận hành/bảo trì | Migration có checksum, health DB/schema, tách API/worker, hướng dẫn backup và log; health không thay kiểm tra inference. |
| NFR08 | Đánh giá khoa học | Nhãn độc lập, chia tập theo nguồn/identity khi biết; đo exact accuracy, CER, unreadable và latency; báo riêng lỗi bỏ sót. |

Giới hạn upload có thể cấu hình; giới hạn 25 MP hiện được kiểm tra trong mã probe ảnh. Đây là các giới hạn đầu vào, không phải kết quả benchmark. Mục tiêu concurrency, p95 latency, thời gian phục hồi và accuracy cần chốt sau khi xác định phần cứng, dữ liệu và quy mô vận hành. Bản đầu vận hành một worker xử lý hàng đợi tuần tự; không diễn giải kiến trúc này là đã hỗ trợ nhiều worker đồng thời.

## 5. Quy tắc nghiệp vụ

| Mã | Quy tắc |
|---|---|
| BR01 | Chỉ tài khoản được cấp và đang hoạt động được dùng nghiệp vụ; không đăng ký công khai. |
| BR02 | User chỉ thao tác dữ liệu mình; Admin toàn hệ thống; kiểm tra quyền cả file và export. |
| BR03 | Email trim/chữ thường, duy nhất; API tạo/reset mật khẩu nhận 12-1024 ký tự. Khóa/reset thu hồi phiên; không khóa/hạ quyền Admin hoạt động cuối cùng. |
| BR04 | Upload tạo nguồn độc lập theo owner; hash chỉ kiểm tra nội dung, không gộp sở hữu giữa tài khoản. |
| BR05 | JPG/PNG/MP4/AVI/MOV được kiểm tra nội dung thực; nguồn lỗi không tạo job thành công. Upload time khác capture time. |
| BR06 | Một nguồn có nhiều job; snapshot của job giữ nguyên. Client không truyền interpreter/checkpoint/path tùy ý. |
| BR07 | Video chỉ dùng scene. Ảnh prepare dùng scene hoặc plate_crop; crop sẵn bỏ detector, detector score có thể null. |
| BR08 | Mỗi detection ảnh hoặc track video hợp lệ tạo appearance riêng; không unique text biển số; track ID chỉ có nghĩa trong job. |
| BR09 | Video cần 5 crop thật, 5 frame khác nhau, theo thứ tự thời gian. Thiếu frame thì loại track và ghi thống kê; không nhân bản ảnh. |
| BR10 | Video upload thông thường dùng toàn khung hình; không tự áp ROI/bộ lọc màu riêng của camera Captures. |
| BR11 | Profile Kaggle tạo một prediction joint từ 5 input; không contact sheet, không phiếu 3/5; agreement_count=null. |
| BR12 | Prepare chưa chạy OCR: machine_status=not_run, machine_text=null, predictions rỗng; cho phép correct để nhập thủ công. |
| BR13 | Raw text và normalized text được giữ riêng; chuẩn hóa chữ hoa, bỏ khoảng trắng/dấu gạch nối; không tự đổi O↔0 hoặc I↔1. |
| BR14 | Detector score, OCR score và frame_weights khác nghĩa. Không suy diễn confidence/accuracy; score model không cung cấp là null. |
| BR15 | Succeeded chỉ nghĩa xử lý/lưu hoàn tất; có thể không phát hiện hoặc đọc sai. Không tự xác nhận kết quả theo confidence. |
| BR16 | Kết quả mới pending. Confirm lấy text máy; correct nhận text mới; unreadable/reject đặt effective_text=null. Machine text/prediction không đổi. |
| BR17 | Mỗi review tăng revision, thêm lịch sử và cập nhật effective_text trong cùng transaction. Revision cũ trả 409, không ghi đè âm thầm. |
| BR18 | Tra cứu dùng effective_text của job succeeded mới nhất theo created_at rồi ID mỗi nguồn. Job queued/failed không che job thành công cũ. |
| BR19 | Chỉ xóa job succeeded/failed; xóa job v2 giữ nguồn. Nguồn còn job tham chiếu trả 409; bằng chứng chia sẻ trong job được xử lý theo thư mục job. |
| BR20 | CSV và truy vấn không phải bộ nhãn đánh giá. Accuracy dùng nhãn độc lập; dữ liệu lịch sử `detect_only` không được tạo OCR/track giả. |

## 6. Use case

### 6.1. Sơ đồ và quy ước

![Use case tổng quan](diagrams/01-use-case.svg)

Nguồn chỉnh sửa: [01-use-case.puml](diagrams/01-use-case.puml). Admin kế thừa các khả năng của User, đồng thời được quản lý tài khoản; phạm vi dữ liệu khác nhau như mục 2. Worker và DB là thành phần nội bộ, không phải actor nghiệp vụ. UC12 mở rộng UC04 tại bước chọn profile nếu chọn `task=prepare`; đây là luồng thay thế OCR. Sau khi job hoàn tất, nhập thủ công là lựa chọn của người dùng qua UC07, không phải bước bắt buộc để tạo job thành công.

**Quy ước chung:** UC03-UC12 yêu cầu phiên còn hiệu lực và quyền trên tài nguyên; lỗi xác thực `401`, ngoài quyền tài nguyên `404`. Danh sách phân trang mặc định 50, tối đa 200. Các bước “mở”, “chọn”, “hiển thị” mô tả tương tác client với API, không xác nhận frontend đã xây.

### UC01 - Đăng nhập, đăng xuất và xem tài khoản

- **Actor:** User, Admin.
- **Tiền điều kiện:** Được cấp tài khoản; logout/me cần phiên hợp lệ.
- **Luồng chính:** (1) Gửi email/mật khẩu. (2) Hệ thống kiểm tra tài khoản và tạo phiên. (3) Client nhận token, hạn dùng; dùng token gọi me/nghiệp vụ. (4) Logout thu hồi phiên hiện tại.
- **Thay thế/lỗi:** Sai mật khẩu, tài khoản khóa hoặc hết phiên trả 401; dữ liệu sai cấu trúc trả 422. Các phiên khác không bị logout theo thao tác này.
- **Hậu điều kiện:** Phiên mới được lưu dạng hash hoặc phiên hiện tại bị thu hồi; không trả password_hash.
- **Truy vết:** FR01; BR01, BR03; `/auth/login`, `/auth/logout`, `/auth/me`.

### UC02 - Quản lý tài khoản

- **Actor:** Admin.
- **Tiền điều kiện:** Admin đang hoạt động; bootstrap Admin đầu tiên bằng CLI vận hành.
- **Luồng chính:** (1) Xem danh sách. (2) Tạo tài khoản hoặc chọn người cần cập nhật. (3) Gửi tên, vai trò, trạng thái/mật khẩu theo thao tác. (4) Hệ thống kiểm tra, lưu và trả dữ liệu công khai.
- **Thay thế/lỗi:** Email trùng hoặc khóa/hạ quyền Admin cuối cùng: 409; mật khẩu không hợp lệ: 422; User thực hiện: 403. Khóa/reset mật khẩu thu hồi toàn bộ phiên của đối tượng.
- **Hậu điều kiện:** Tài khoản có trạng thái/quyền mới; không tự xóa dữ liệu đã upload.
- **Truy vết:** FR02-03; BR02-03; `/users`, `/users/{id}`.

### UC03 - Quản lý nguồn tải lên

- **Actor:** User, Admin.
- **Tiền điều kiện:** Có file ảnh/video hỗ trợ, dung lượng trong giới hạn.
- **Luồng chính:** (1) Gửi một file multipart. (2) Kiểm tra loại, dung lượng và giải mã. (3) Tính hash/metadata, lưu file và owner. (4) Trả media_id. (5) Người dùng xem danh sách hoặc đọc nguồn khi cần.
- **Thay thế/lỗi:** Quá lớn 413; sai loại 415; file hỏng 422; môi trường probe chưa sẵn sàng 503; byte range ngoài file 416. Thất bại upload không để lại nguồn nghiệp vụ hợp lệ.
- **Hậu điều kiện:** Có media tái sử dụng; chưa tự tạo job.
- **Truy vết:** FR03-05; BR04-05; `/media`, `/media/{id}/content`.

### UC04 - Tạo hoặc chạy lại job

- **Actor:** User, Admin.
- **Tiền điều kiện:** Có media thuộc quyền, profile sẵn sàng và phù hợp loại nguồn.
- **Luồng chính:** (1) Xem pipeline. (2) Chọn media/profile/input_mode. (3) Hệ thống kiểm tra và đóng băng cấu hình. (4) Lưu job queued, trả 202/job_id/status_url. (5) Worker lấy job để xử lý. Chạy lại lặp bước 2 với nguồn cũ.
- **Thay thế/lỗi:** Profile thiếu file/checksum không đúng: 503; gửi ảnh vào Kaggle joint-five hoặc video plate_crop: 422. Job cũ không bị thay thế.
- **Hậu điều kiện:** Tạo lượt chạy độc lập; nguồn vẫn dùng được cho job khác.
- **Truy vết:** FR06-11; BR06-11; `/pipelines`, `/recognition-jobs`.

### UC05 - Theo dõi xử lý

- **Actor:** User, Admin.
- **Tiền điều kiện:** Có job thuộc quyền.
- **Luồng chính:** (1) Xem lịch sử/lọc job. (2) Đọc trạng thái. (3) Worker chuyển queued → running, báo giai đoạn và thống kê quan sát được. (4) Job kết thúc succeeded hoặc failed; client tải kết quả khi succeeded.
- **Thay thế/lỗi:** Không phát hiện biển số vẫn succeeded với danh sách rỗng. Worker/model lỗi trả failed và mã lỗi an toàn; restart đánh dấu running cũ WORKER_INTERRUPTED. Không dựng % khi thiếu số liệu.
- **Hậu điều kiện:** Biết trạng thái, thời gian và kết quả xử lý; failed có thể chạy lại qua UC04.
- **Truy vết:** FR08, FR18; BR15; `/recognition-jobs`, `/recognition-jobs/{id}`.

### UC06 - Xem kết quả và bằng chứng

- **Actor:** User, Admin.
- **Tiền điều kiện:** Job succeeded, dữ liệu thuộc quyền.
- **Luồng chính:** (1) Lấy danh sách appearances của job. (2) Mở chi tiết. (3) Xem crop, frame, vị trí xuất hiện, machine/effective text, trạng thái và review. (4) Với joint-five, xem một prediction cùng năm detection theo thứ tự đầu vào.
- **Thay thế/lỗi:** Job chưa succeeded: kết quả job trả 409; bằng chứng không có: 404. Prepare có predictions rỗng; enhanced chỉ tồn tại nếu pipeline thực sự tạo.
- **Hậu điều kiện:** Người dùng có bằng chứng đối chiếu; dữ liệu không bị sửa.
- **Truy vết:** FR12; BR08, BR11-15; `/recognition-jobs/{id}/results`, `/recognition-results/{id}`, `/detections/{id}/artifacts/{kind}`.

### UC07 - Kiểm duyệt kết quả

- **Actor:** User, Admin.
- **Tiền điều kiện:** Xem được kết quả succeeded và biết revision hiện tại.
- **Luồng chính:** (1) Đối chiếu bằng chứng. (2) Chọn confirm, correct, unreadable hoặc reject. (3) Gửi expected_revision, note và corrected_text chỉ khi correct. (4) Hệ thống khóa bản ghi, kiểm phiên bản, ghi lịch sử và cập nhật effective_text/revision. (5) Trả review mới.
- **Thay thế/lỗi:** Revision đã đổi: 409, tải lại trước khi sửa tiếp. Confirm khi không có machine_text, correction rỗng sau chuẩn hóa: 422. Track ghép sai hoặc không phải biển số dùng reject; không tự sửa cấu trúc track.
- **Hậu điều kiện:** Text hiệu lực/trạng thái thay đổi; dự đoán máy giữ nguyên, lịch sử được thêm.
- **Truy vết:** FR13; BR13, BR16-17; `/recognition-results/{id}/reviews`.

### UC08 - Tra cứu biển số

- **Actor:** User, Admin.
- **Tiền điều kiện:** Phiên hợp lệ; không cần có kết quả để thực hiện truy vấn.
- **Luồng chính:** (1) Nhập biển số hoặc lọc nguồn/trạng thái duyệt/thời gian upload. (2) Chuẩn hóa truy vấn và áp quyền. (3) Chọn job v2 succeeded mới nhất mỗi nguồn. (4) Trả kết quả phân trang và nhãn review_status.
- **Thay thế/lỗi:** Không khớp trả danh sách rỗng; truy vấn text rỗng sau chuẩn hóa/thời gian sai trả 422. Kết quả pending có machine_text vẫn là dự đoán chưa xác nhận; pending của prepare có thể chưa có text. Job prepare thành công mới hơn cũng được chọn, kể cả khi chưa nhập thủ công hoặc không có appearance. Job cũ xem qua UC06, không trộn vào tìm kiếm mặc định; lịch sử review không tự chuyển sang lượt chạy mới.
- **Hậu điều kiện:** Có danh sách theo effective_text hiện hành; không gộp các appearances cùng biển số.
- **Truy vết:** FR14-15; BR13, BR16, BR18; `/recognition-results`.

### UC09 - Xuất CSV

- **Actor:** User, Admin.
- **Tiền điều kiện:** Job succeeded và thuộc quyền.
- **Luồng chính:** (1) Chọn export CSV. (2) Hệ thống kiểm quyền/trạng thái. (3) Xuất các appearances với text máy, hiệu lực, review, recognition_method và vị trí. (4) Trả file UTF-8 BOM, escape ô có tiền tố công thức.
- **Thay thế/lỗi:** Chưa succeeded: 409; format khác csv: 422; không có appearance thì chỉ có dòng tiêu đề.
- **Hậu điều kiện:** Có bản xuất tại thời điểm request; DB không đổi, file không phải nhãn chuẩn tự động.
- **Truy vết:** FR16; BR02, BR20; `/recognition-jobs/{id}/export?format=csv`.

### UC10 - Xóa job đã kết thúc

- **Actor:** User, Admin.
- **Tiền điều kiện:** Job succeeded/failed, thuộc quyền.
- **Luồng chính:** (1) Gửi yêu cầu xóa. (2) Hệ thống kiểm trạng thái/quyền. (3) Xóa job, appearances, detections, predictions/reviews và bằng chứng phát sinh theo cơ chế lưu trữ. (4) Trả 204.
- **Thay thế/lỗi:** Queued/running: 409; ID không tồn tại/ngoài quyền: 404. Nếu xóa lượt thành công mới nhất, tìm kiếm sẽ chọn lượt thành công còn lại nếu có.
- **Hậu điều kiện:** Job v2 và lịch sử của nó không còn; file nguồn và các job khác được giữ.
- **Truy vết:** FR17; BR19; `/recognition-jobs/{id}`.

### UC11 - Xóa nguồn không còn sử dụng

- **Actor:** User, Admin.
- **Tiền điều kiện:** Media thuộc quyền, không còn job tham chiếu.
- **Luồng chính:** (1) Gửi yêu cầu xóa nguồn. (2) Hệ thống kiểm quyền/tham chiếu trong transaction. (3) Xóa metadata và file nguồn theo cơ chế lưu trữ. (4) Trả 204.
- **Thay thế/lỗi:** Còn bất kỳ job nào kể cả failed: 409; cần xử lý các job qua UC10 trước. Không tồn tại/ngoài quyền: 404.
- **Hậu điều kiện:** Nguồn không còn; không ảnh hưởng file độc lập của người khác dù hash giống nhau.
- **Truy vết:** FR17; BR04, BR19; `/media/{id}`.

### UC12 - Chuẩn bị bằng chứng và nhập thủ công

- **Actor:** User, Admin.
- **Tiền điều kiện:** Có nguồn, profile prepare sẵn sàng; không yêu cầu checkpoint OCR.
- **Điểm mở rộng của UC04:** Tại bước chọn profile, chọn `task=prepare` để tạo bằng chứng mà không chạy nhận diện ký tự.
- **Luồng chính:** (1) Tạo job prepare. (2) Ảnh scene chạy detector; plate_crop dùng crop nguồn; video tracking chọn năm frame. (3) Lưu appearances/evidence với machine_status=not_run. (4) Người dùng có thể xem và nhập biển số bằng correct hoặc đánh dấu unreadable/reject qua UC07 sau khi job hoàn tất.
- **Thay thế/lỗi:** Ảnh không phát hiện hoặc video không có track đủ frame trả succeeded với kết quả rỗng/thống kê. Không cho confirm khi chưa có chuỗi máy.
- **Hậu điều kiện:** Job lưu bằng chứng của các appearance hợp lệ; nếu người dùng kiểm duyệt thì kết luận thủ công có lịch sử. Không tạo prediction OCR giả.
- **Truy vết:** FR09-10, FR12-13; BR07, BR09, BR12, BR16; sử dụng API media/job/results/reviews hiện có, không thêm endpoint riêng.

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

## 8. Sơ đồ sequence và ranh giới transaction

### 8.1. Đăng nhập và thu hồi phiên - UC01

![Sequence đăng nhập](diagrams/06-seq-login.svg)

Nguồn chỉnh sửa: [06-seq-login.puml](diagrams/06-seq-login.puml).

Client gửi email/mật khẩu qua API. Backend chuẩn hóa email, xác minh mật khẩu bằng scrypt và từ chối tài khoản không hoạt động. Sau khi tạo token ngẫu nhiên, backend khóa bản ghi tài khoản trong transaction và kiểm tra lại trạng thái/password hash trước khi ghi phiên. Bước kiểm tra lần hai ngăn một lần đăng nhập đồng thời với thao tác khóa hoặc reset mật khẩu tạo ra phiên dựa trên thông tin cũ.

Token trả về client là bí mật để sử dụng trong header Bearer; PostgreSQL chỉ lưu hash token. Guard đọc phiên còn hạn/chưa thu hồi và quyền hiện tại của tài khoản ở mỗi request. Logout thu hồi phiên đang dùng; khóa tài khoản hoặc reset mật khẩu thu hồi toàn bộ phiên của tài khoản đó. Đổi vai trò có hiệu lực khi guard đọc lại user, không đòi client đăng nhập lại để cập nhật role.

### 8.2. Upload, tạo lượt chạy và theo dõi - UC03, UC04, UC05

![Sequence upload và tạo job](diagrams/07-seq-submit.svg)

Nguồn chỉnh sửa: [07-seq-submit.puml](diagrams/07-seq-submit.puml).

Upload và tạo job là hai giao dịch nghiệp vụ tách biệt. Upload hợp lệ tạo `media_id`; nguồn này có thể tồn tại mà chưa được xử lý. API kiểm dung lượng, loại file, khả năng giải mã, ghi metadata và hash, rồi trả `201`. Python probe chỉ kiểm nguồn; đây không phải lần chạy detector/OCR.

Khi tạo job, API kiểm quyền nguồn trước khi resolve profile để hạn chế lộ thông tin tài nguyên. Profile chỉ được chọn bằng ID cấu hình trên server. Trong transaction tạo job, khóa `media_assets` đồng bộ với xóa nguồn, sau đó chèn job `queued` kèm snapshot. API trả `202` khi việc xếp hàng hoàn tất; không giữ HTTP request đến khi ML xử lý xong. Client dùng `status_url` để thăm dò; retry nghiệp vụ là một POST tạo job mới trên cùng nguồn.

Kaggle joint-five chỉ nhận video `scene`. Ảnh sử dụng prepare `scene` hoặc `plate_crop`; ảnh đưa vào profile joint-five trả `422`. Những nhánh lỗi này không tạo job mới. `pipelines.ready` là kiểm cấu hình/file/checksum, không thay thế việc chạy thử model thực.

### 8.3. Worker và công bố kết quả - UC04, UC05, UC06, UC12

![Sequence worker joint-five](diagrams/08-seq-worker.svg)

Nguồn chỉnh sửa: [08-seq-worker.puml](diagrams/08-seq-worker.puml).

Worker Node giữ một PostgreSQL advisory lock cho toàn vòng đời để bảo đảm bản đầu chỉ có một worker quản lý queue trên DB. Khi khởi động, worker đánh dấu job `running` còn lại là `failed/WORKER_INTERRUPTED`. Nhận job dùng `FOR UPDATE SKIP LOCKED` trong một transaction ngắn; transaction đó hoàn tất trước khi chạy inference. Không giữ khóa hàng job suốt thời gian xử lý video.

Worker xác minh hash nguồn, checkpoint, mã tích hợp và interpreter của snapshot rồi chạy Python supervisor. Python thực hiện Adaptive Sampling → empty-scene gate → YOLO11l → BoT-SORT không ReID → chọn năm crop theo chất lượng và thời gian → OCR joint một lần cho mỗi track → decoder `beam_filter` → gợi ý gộp track. Track thiếu năm frame hợp lệ bị loại và ghi thống kê. Runner ghi bằng chứng, progress và manifest vào thư mục riêng của job; **Python ML không trực tiếp ghi PostgreSQL**.

Node nhận manifest, kiểm tra đường dẫn nằm trong job, file bằng chứng tồn tại, kích thước/bbox hợp lệ, năm frame và timestamp khác nhau theo thứ tự, liên kết prediction với đúng năm input. Sau đó Node mở transaction thứ hai, khóa job còn `running`, chèn toàn bộ appearance/detection/prediction và chuyển job sang `succeeded`. Nếu ghi dữ liệu lỗi, transaction rollback nên không công bố một phần kết quả.

Kết quả joint có `recognition_method=joint_multiframe`, `agreement_count=null` và một prediction cấp appearance. `frame_weights` là trọng số kết hợp đặc trưng; `ocr_score=null` vì model không có xác suất đã hiệu chuẩn; `decoding` ghi decoder, greedy text, `format_valid` và beam score chỉ để xếp hạng. Profile prepare không gọi OCR, giữ `machine_status=not_run`, `machine_text=null`, predictions rỗng. Nhánh adapter đọc từng crop còn được hỗ trợ về hợp đồng nhưng quy tắc đa số 3/5 không áp dụng cho model Kaggle hiện hành.

Timeout, gián đoạn, nguồn thay đổi, model lỗi hoặc manifest sai làm job `failed` với mã lỗi an toàn; stack trace nằm trong log máy chủ. Supervisor/dừng cây tiến trình tránh inference tiếp tục chạy khi worker mất quyền điều khiển. Không có retry tự động hoặc API hủy job trong bản đầu.

### 8.4. Kiểm duyệt và xung đột phiên bản - UC07

![Sequence kiểm duyệt](diagrams/09-seq-review.svg)

Nguồn chỉnh sửa: [09-seq-review.puml](diagrams/09-seq-review.puml).

Hai client có thể cùng đọc revision 0. Request review đầu khóa appearance bằng `FOR UPDATE OF a`, kiểm quyền và job thành công, so sánh `expected_revision`, cập nhật `effective_text`, `review_status`, tăng revision, rồi thêm lịch sử trong cùng transaction. Request tiếp theo đọc revision mới sau khi lấy được khóa; nếu vẫn gửi revision cũ thì nhận `409`.

Client phải tải lại kết quả và chủ động gửi quyết định mới. Không nên tự động gửi lại review với revision tăng lên vì có thể ghi đè một kết luận chưa được người dùng xem. `confirm` cần `machine_text` đọc được; `correct` cần chuỗi mới còn nội dung sau chuẩn hóa; `unreadable` hoặc `reject` đặt `effective_text=null`. Mọi action giữ nguyên dự đoán máy. Track ghép sai dùng `reject`; bản đầu chưa có công cụ tách/gộp lại track.

### 8.5. Xóa dữ liệu và phối hợp lưu trữ - UC10, UC11

![Sequence xóa job và nguồn](diagrams/10-seq-delete.svg)

Nguồn chỉnh sửa: [10-seq-delete.puml](diagrams/10-seq-delete.puml).

Xóa job v2 khóa media rồi khóa job, chỉ cho `succeeded` hoặc `failed`. Xóa nguồn khóa media và chỉ tiếp tục khi không còn job tham chiếu, kể cả job failed. Cùng thứ tự khóa giúp phối hợp với tạo job mới. FK/cascade xử lý metadata phát sinh; source của job v2 được giữ để tái sử dụng.

Trong transaction, backend rename thư mục cần xóa sang `trash/<uuid>` trước khi DELETE metadata. Nếu giao dịch lỗi, backend cố khôi phục thư mục; nếu commit thành công, purge trash là bước dọn sau cùng. Lỗi purge không biến một lần xóa đã commit thành thất bại và file trong trash không được endpoint nghiệp vụ phục vụ. Không xóa từng file frame theo detection vì nhiều detection có thể tham chiếu cùng frame.

**Giới hạn vận hành:** PostgreSQL và filesystem không tham gia transaction phân tán. Crash đúng giữa rename và commit/restore có thể cần đối chiếu DB với thư mục trash; bản đầu chưa có bộ đối soát tự động cho mọi trạng thái crash. Backup cần chứa cả DB và file tại thời điểm nhất quán.

## 9 Mô hình trạng thái

### 9.1 Trạng thái job

`status` mô tả vòng đời xử lý; `stage` cho biết bước đang chạy. Stage gồm validating, detection_tracking, recognition, persisting và kết thúc complete/failed. Prepare không có bước recognition. API không tự suy ra phần trăm tiến độ nếu worker không có số liệu.

![Trạng thái job](diagrams/11-state-job.png)

Worker đang chạy giữ advisory lock ở cấp database. Khi một worker hợp lệ khởi động lại, các job còn `running` được đánh dấu `failed` với `WORKER_INTERRUPTED`; không âm thầm tiếp tục từ file kết quả dở. Người dùng tạo job mới trên cùng media để chạy lại. Bản đầu không có retry theo cùng ID hoặc hủy job đang chạy.

### 9.2 Trạng thái kiểm duyệt và trạng thái máy

Hai trạng thái độc lập. Máy có thể `readable`, `unreadable`, `ambiguous` hoặc `not_run`. `ambiguous` có ý nghĩa ở nhánh OCR từng crop và bỏ phiếu; profile joint hiện tại không tạo trạng thái này. Review bắt đầu `pending`, sau đó phản ánh hành động mới nhất.

![Trạng thái kiểm duyệt](diagrams/14-state-review.png)

Mọi trạng thái review đều có thể nhận thao tác tiếp theo hợp lệ. Sơ đồ rút gọn các chuyển tiếp lặp bằng trạng thái lựa chọn hành động; đây không phải một trạng thái được lưu trong DB. Mỗi lần commit tăng revision một đơn vị và thêm lịch sử, không thay đổi trạng thái máy.

## 10. Thiết kế cơ sở dữ liệu PostgreSQL

**Ngày đối chiếu:** 14/10/2026. Đây là thiết kế vật lý đang được mã nguồn sử dụng sau ba migration, không phải một schema đề xuất chưa triển khai. Có **8 bảng nghiệp vụ và 1 bảng kỹ thuật**. Các bảng dùng tên tiếng Anh; ý nghĩa và quy tắc được giải thích bằng tiếng Việt.

### 10.1. Nguyên tắc mô hình hóa

Đơn vị nghiệp vụ trung tâm là `plate_appearances`: một lần biển số xuất hiện trong **một job cụ thể**. Ảnh tạo một appearance cho mỗi detection; video tạo một appearance cho mỗi track đủ điều kiện. Cùng văn bản biển số xuất hiện ở hai nguồn hoặc hai lượt chạy vẫn là hai bản ghi khác nhau. Không đặt unique trên `machine_text`, `effective_text` hoặc `source_track_id` toàn hệ thống.

`media_assets` tách khỏi `recognition_jobs` để chạy lại một nguồn với cấu hình khác. Quyền sở hữu đặt ở nguồn: appearance, detection và prediction truy ngược qua job đến `media_assets.owner_id`. `reviewer_id` là người thực hiện kiểm duyệt, có thể là Admin và không nhất thiết là chủ nguồn. Không có bảng phương tiện, chủ xe, giao dịch bãi xe hoặc liên kết danh tính giữa các track.

Ảnh/video/crop nằm trên filesystem; DB giữ metadata và storage key tương đối. Hash nguồn phục vụ đối chiếu nội dung, **không** là khóa sở hữu dùng chung giữa tài khoản. DB không chứa Base64. Snapshot pipeline là dữ liệu nội bộ và có thể chứa đường dẫn checkpoint; API lọc thông tin đó trước khi trả về client.

ID nghiệp vụ được ứng dụng sinh bằng UUID bỏ dấu gạch nối, lưu trong `varchar(32)`; cột không có default UUID và DB không có CHECK định dạng hex. `timestamptz` lưu một thời điểm tuyệt đối; client có thể hiển thị theo múi giờ người dùng. `uploaded_at` là lúc upload, không phải lúc quay. `frame_index` và `timestamp_seconds` mô tả vị trí tương đối trong video. Giá trị chưa biết để `NULL`, không thay bằng 0.

### 10.2. ERD và quan hệ

![ERD tổng thể](diagrams/12-erd.svg)

Nguồn chỉnh sửa: [12-erd.puml](diagrams/12-erd.puml). Sơ đồ thể hiện các khóa và trường chính; từ điển bên dưới là danh sách đầy đủ. Bảng kỹ thuật `schema_migrations` độc lập, không tham gia quan hệ nghiệp vụ.

- Một user có nhiều session và nguồn; mỗi nguồn có đúng một chủ sở hữu.
- Một nguồn có nhiều job; một job có từ 0 đến nhiều appearance. Job thành công có thể không phát hiện biển số nào.
- Một appearance có nhiều detection và lịch sử review; luồng hiện hành dùng một detection cho ảnh, năm detection được chọn cho video.
- OCR theo crop tham chiếu một detection. OCR joint tham chiếu một appearance và danh sách năm đầu vào có thứ tự. **Mỗi prediction chỉ thuộc đúng một nhánh**, không đồng thời cả hai.
- Một user có thể tạo nhiều review; mỗi review có đúng một người thực hiện.

### 10.3. Quy ước từ điển dữ liệu

Cột **NULL** ghi “Không” nếu NOT NULL/PK, “Có” nếu được phép NULL. **PK** là khóa chính; **FK →** là khóa ngoại; **UQ** là unique. `D=...` là default của PostgreSQL. Nếu không ghi `D`, cột không có default khai báo; ứng dụng phải cung cấp giá trị cho cột bắt buộc. CHECK không làm một cột nullable thành NOT NULL: PostgreSQL chấp nhận kết quả CHECK là NULL.

#### 10.3.1. `users` - tài khoản

| Trường | Kiểu PostgreSQL | NULL | Ràng buộc và ý nghĩa |
|---|---|---|---|
| `id` | `varchar(32)` | Không | PK; ID tài khoản. |
| `email` | `varchar(320)` | Không | UQ; CHECK `email = lower(btrim(email))`. API chuẩn hóa email trước khi lưu. |
| `password_hash` | `text` | Không | Hash mật khẩu có salt; không lưu mật khẩu rõ. |
| `display_name` | `varchar(200)` | Không | D=`''`; tên hiển thị. |
| `role` | `varchar(16)` | Không | D=`'user'`; CHECK trong `admin`, `user`. |
| `is_active` | `boolean` | Không | D=`true`; trạng thái được phép đăng nhập/truy cập. |
| `created_at` | `timestamptz` | Không | D=`now()`; thời điểm tạo. |

Khóa tài khoản là cập nhật `is_active=false`, không xóa user. Runtime ngăn vô hiệu hóa/hạ quyền Admin hoạt động cuối cùng; không có CHECK hoặc trigger tương ứng trong DB. Email unique theo chuỗi chuẩn hóa, không dùng `citext`.

#### 10.3.2. `auth_sessions` - phiên đăng nhập

| Trường | Kiểu PostgreSQL | NULL | Ràng buộc và ý nghĩa |
|---|---|---|---|
| `id` | `varchar(32)` | Không | PK; ID phiên. |
| `user_id` | `varchar(32)` | Không | FK → `users.id`, ON DELETE CASCADE. |
| `token_hash` | `varchar(64)` | Không | UQ; SHA-256 của bearer token ngẫu nhiên, không lưu token rõ. DB không CHECK dạng hex. |
| `expires_at` | `timestamptz` | Không | Hạn phiên do ứng dụng tính. |
| `revoked_at` | `timestamptz` | Có | Lúc thu hồi; NULL nghĩa là chưa được thu hồi, không bảo đảm phiên chưa hết hạn. |
| `created_at` | `timestamptz` | Không | D=`now()`. |

Phiên có hiệu lực khi chưa thu hồi, chưa hết hạn và user còn hoạt động. Không có CHECK `expires_at > created_at`; đây là quy tắc ứng dụng. Đăng xuất thu hồi phiên hiện tại; khóa tài khoản hoặc đặt lại mật khẩu thu hồi các phiên của tài khoản trong transaction quản lý user.

#### 10.3.3. `media_assets` - nguồn ảnh/video

| Trường | Kiểu PostgreSQL | NULL | Ràng buộc và ý nghĩa |
|---|---|---|---|
| `id` | `varchar(32)` | Không | PK; `media_id` dùng cho API tạo job. |
| `owner_id` | `varchar(32)` | Không | FK → `users.id`, ON DELETE RESTRICT. |
| `original_name` | `varchar(255)` | Không | Tên file lúc upload; không dùng trực tiếp làm đường dẫn lưu. |
| `media_type` | `varchar(16)` | Không | CHECK trong `image`, `video`. |
| `storage_key` | `text` | Không | UQ; khóa file tương đối trong vùng lưu trữ quản lý. |
| `mime_type` | `varchar(100)` | Không | MIME được kiểm tra; dùng khi phục vụ file nguồn. |
| `size_bytes` | `bigint` | Không | CHECK `>= 0`; dung lượng byte. |
| `sha256` | `varchar(64)` | Không | Hash nội dung; không UQ và không CHECK dạng hex. |
| `width` | `integer` | Có | CHECK `> 0`; chiều rộng pixel khi xác định được. |
| `height` | `integer` | Có | CHECK `> 0`; chiều cao pixel khi xác định được. |
| `duration_seconds` | `double precision` | Có | CHECK `>= 0`; thời lượng video; ảnh không áp dụng. |
| `uploaded_at` | `timestamptz` | Không | D=`now()`; dùng lọc thời gian upload. |

Luồng upload hiện hành kiểm tra giải mã và metadata; các cột kích thước nullable để hỗ trợ dữ liệu lịch sử thiếu metadata. DB không tự kiểm tra MIME với nội dung file hoặc bắt buộc thời lượng NULL khi là ảnh.

#### 10.3.4. `recognition_jobs` - lượt xử lý

| Trường | Kiểu PostgreSQL | NULL | Ràng buộc và ý nghĩa |
|---|---|---|---|
| `id` | `varchar(32)` | Không | PK; ID lượt chạy. |
| `media_id` | `varchar(32)` | Không | FK → `media_assets.id`, ON DELETE RESTRICT. |
| `job_kind` | `varchar(16)` | Không | D=`'recognize'`; CHECK trong `detect_only`, `recognize`. Prepare và job lịch sử dùng `detect_only`. |
| `input_mode` | `varchar(16)` | Không | D=`'scene'`; CHECK trong `scene`, `plate_crop`. |
| `pipeline_snapshot` | `jsonb` | Không | D=`'{}'::jsonb`; CHECK kiểu JSON là object. Cấu hình và phiên bản/checksum lúc chạy. |
| `status` | `varchar(16)` | Không | D=`'queued'`; CHECK trong `queued`, `running`, `succeeded`, `failed`. |
| `stage` | `varchar(32)` | Không | D=`'queued'`; giai đoạn hiện tại. DB không CHECK tập giá trị stage. |
| `statistics` | `jsonb` | Không | D=`'{}'::jsonb`; CHECK kiểu JSON là object. Số frame/track, loại bỏ và số kết quả. |
| `created_at` | `timestamptz` | Không | D=`now()`. |
| `started_at` | `timestamptz` | Có | Thời điểm worker nhận và bắt đầu xử lý. |
| `finished_at` | `timestamptz` | Có | Thời điểm kết thúc thành công/thất bại. |
| `error_code` | `varchar(100)` | Có | Mã lỗi khi có. |
| `error_message` | `text` | Có | Thông báo lỗi phù hợp để API hiển thị. |

Video chỉ dùng `scene`; profile Kaggle joint chỉ nhận video. Hai điều kiện này được API/worker kiểm tra, không phải CHECK xuyên bảng. `succeeded` chỉ xác nhận xử lý hoàn tất, không xác nhận accuracy. DB chưa có CHECK ghép trạng thái với các mốc thời gian.

#### 10.3.5. `plate_appearances` - kết quả trung tâm

| Trường | Kiểu PostgreSQL | NULL | Ràng buộc và ý nghĩa |
|---|---|---|---|
| `id` | `varchar(32)` | Không | PK; ID kết quả để kiểm duyệt/tra cứu. |
| `job_id` | `varchar(32)` | Không | FK → `recognition_jobs.id`, ON DELETE CASCADE. |
| `source_track_id` | `varchar(100)` | Có | ID tracker trong job; ảnh/dữ liệu lịch sử có thể NULL. Không UQ ở DB. |
| `first_frame` | `integer` | Có | CHECK `>= 0`; frame đầu phạm vi track. |
| `last_frame` | `integer` | Có | CHECK `>= first_frame`; DB không bắt buộc hai đầu cùng NULL hoặc cùng có giá trị. |
| `start_seconds` | `double precision` | Có | CHECK `>= 0`; đầu phạm vi track theo thời gian tương đối. |
| `end_seconds` | `double precision` | Có | CHECK `>= start_seconds`; cùng lưu ý NULL như hai đầu frame. |
| `machine_text` | `varchar(128)` | Có | Kết luận máy chuẩn hóa; NULL nếu không có kết luận đọc được. Không UQ. |
| `machine_status` | `varchar(16)` | Không | D=`'not_run'`; CHECK trong `readable`, `ambiguous`, `unreadable`, `not_run`. |
| `agreement_count` | `integer` | Có | D=`0` vẫn được giữ sau migration 0002; CHECK từ 0 đến 5 khi có giá trị. Joint bắt buộc NULL. |
| `effective_text` | `varchar(128)` | Có | Chuỗi đang có hiệu lực để tra cứu; lưu cùng transaction kiểm duyệt. Không UQ. |
| `review_status` | `varchar(16)` | Không | D=`'pending'`; CHECK trong `pending`, `confirmed`, `corrected`, `unreadable`, `rejected`. |
| `revision` | `integer` | Không | D=`0`; CHECK `>= 0`; tăng mỗi lần review. |
| `recognition_method` | `varchar(32)` | Có | Thêm ở 0002; CHECK trong `single_image`, `per_crop_majority`, `joint_multiframe`; NULL cho chưa OCR/dữ liệu lịch sử. |

CHECK `plate_appearances_joint_agreement` yêu cầu `recognition_method='joint_multiframe'` thì `agreement_count IS NULL`. Vì default của count vẫn là 0, thao tác insert joint phải truyền NULL rõ ràng. Kết quả joint là **một suy luận từ năm ảnh**, không có số phiếu 3/5. Không thêm ràng buộc giả định mọi appearance đều đã chạy OCR; prepare có `not_run`, text NULL và count 0.

#### 10.3.6. `plate_detections` - bằng chứng

| Trường | Kiểu PostgreSQL | NULL | Ràng buộc và ý nghĩa |
|---|---|---|---|
| `id` | `varchar(32)` | Không | PK; dùng URL artifact sau kiểm tra quyền. |
| `appearance_id` | `varchar(32)` | Không | FK → `plate_appearances.id`, ON DELETE CASCADE. |
| `selected_order` | `integer` | Không | D=`0`; CHECK `>= 0`; UQ ghép `(appearance_id, selected_order)`. Runtime mới dùng 1..N. |
| `frame_index` | `integer` | Có | CHECK `>= 0`; runtime video mới dùng chỉ số bắt đầu 1; ảnh NULL. |
| `timestamp_seconds` | `double precision` | Có | CHECK `>= 0`; timestamp video tương đối; ảnh NULL. |
| `timestamp_source` | `varchar(32)` | Có | Nguồn timestamp: runtime dùng `video_pts`, `still_image`; dữ liệu lịch sử có thể là `legacy`. DB không enum. |
| `bbox` | `jsonb` | Có | Bbox detector `[x1,y1,x2,y2]`; DB không CHECK cấu trúc JSON. |
| `crop_bbox` | `jsonb` | Có | Vùng crop thực tế, gồm padding nếu có; DB không CHECK cấu trúc JSON. |
| `detection_score` | `double precision` | Có | CHECK từ 0 đến 1; confidence detector, không phải confidence OCR. |
| `crop_storage_key` | `text` | Không | Khóa ảnh crop; không UQ ở DB. |
| `frame_storage_key` | `text` | Có | Khóa frame nguồn; nhiều detection có thể dùng chung frame. |
| `crop_width` | `integer` | Có | CHECK `> 0`; kích thước crop trước resize OCR. |
| `crop_height` | `integer` | Có | CHECK `> 0`; dùng phân nhóm chất lượng low-resolution. |
| `legacy_crop_id` | `varchar(100)` | Có | ID crop của dữ liệu lịch sử (bản FastAPI đầu); runtime hiện hành để NULL. Có index, không UQ. |

Frame nguồn không có bảng riêng trong bản đầu. Runtime lưu/xóa theo thư mục job nên không xóa file frame dùng chung theo từng detection. DB không thể xác nhận storage key trỏ tới file tồn tại; worker xác minh đường dẫn an toàn, kích thước ảnh và hình học crop trước lưu.

#### 10.3.7. `ocr_predictions` - dự đoán máy và provenance

| Trường | Kiểu PostgreSQL | NULL | Ràng buộc và ý nghĩa |
|---|---|---|---|
| `id` | `varchar(32)` | Không | PK; ID dự đoán. |
| `detection_id` | `varchar(32)` | Có | FK → `plate_detections.id`, ON DELETE CASCADE; parent của OCR một crop. Nullable từ 0002. |
| `variant` | `varchar(32)` | Không | D=`'original'`; UQ ghép `(detection_id, variant)` và `(appearance_id, variant)`. DB không CHECK tập variant. |
| `raw_text` | `text` | Có | Văn bản OCR nguyên gốc. |
| `normalized_text` | `varchar(128)` | Có | Chữ hoa, bỏ khoảng trắng/dấu gạch nối; không tự đổi `O` và `0`. |
| `ocr_score` | `double precision` | Có | Confidence nếu model cung cấp; model Kaggle hiện để NULL. DB không CHECK khoảng xác suất. |
| `character_scores` | `jsonb` | Có | Score từng ký tự khi có; DB không CHECK cấu trúc JSON. |
| `input_storage_key` | `text` | Có | Khóa một đầu vào cho OCR theo detection; nullable từ 0002 và buộc NULL cho joint. |
| `latency_ms` | `double precision` | Có | CHECK `>= 0`; thời gian suy luận được adapter đo. |
| `created_at` | `timestamptz` | Không | D=`now()`. |
| `appearance_id` | `varchar(32)` | Có | Thêm ở 0002; FK → `plate_appearances.id`, ON DELETE CASCADE; parent của joint OCR. |
| `input_storage_keys` | `jsonb` | Có | Thêm ở 0002; mảng đúng 5 khóa đầu vào cho joint, theo thứ tự thời gian. |
| `frame_weights` | `jsonb` | Có | Thêm ở 0002; NULL hoặc mảng đúng 5 phần tử. Trọng số hợp nhất model, không phải accuracy hoặc số phiếu. |
| `decoding` | `jsonb` | Có | Thêm ở 0003; NULL hoặc object: `decoder`, `beam_width`, `use_tta`, `plate_text`, `greedy_text`, `format_valid`, `greedy_symbol_confidence`, `beam_log_score`, `beam_confidence_proxy`. Score là heuristic, không phải xác suất đúng. |

Bốn CHECK bổ sung tạo hợp đồng rõ ràng:

1. `ocr_predictions_one_parent`: `(detection_id IS NOT NULL) <> (appearance_id IS NOT NULL)`; đúng một parent có giá trị.
2. `ocr_predictions_input_provenance`: nhánh detection phải có `input_storage_key`, hai trường `input_storage_keys`/`frame_weights` phải NULL. Nhánh appearance phải có mảng `input_storage_keys` dài 5 và `input_storage_key` NULL.
3. `ocr_predictions_frame_weights`: nếu có weights thì phải là mảng dài 5. DB chưa kiểm tra phần tử là số, khoảng [0,1], tổng bằng 1 hay alignment với đầu vào; worker kiểm tra các điều kiện này.
4. `ocr_predictions_decoding_object`: nếu có `decoding` thì phải là object JSON. Worker kiểm tra đủ khóa, decoder hợp lệ, `plate_text` trùng `raw_text` và các score hữu hạn.

Hai UQ ghép cho phép mỗi parent có tối đa một dự đoán cho mỗi variant. Với XOR, giá trị NULL ở khóa của nhánh còn lại không gây trùng giả. Runtime joint hiện ghi một bản ghi `variant='joint'` ở appearance; danh sách prediction của từng detection rỗng. API trả `detection_ids` có thứ tự thay storage key nội bộ.

![Chi tiết quan hệ OCR](diagrams/13-erd-ocr.svg)

Nguồn chỉnh sửa: [13-erd-ocr.puml](diagrams/13-erd-ocr.puml).

#### 10.3.8. `recognition_reviews` - lịch sử kiểm duyệt

| Trường | Kiểu PostgreSQL | NULL | Ràng buộc và ý nghĩa |
|---|---|---|---|
| `id` | `varchar(32)` | Không | PK; ID thao tác. |
| `appearance_id` | `varchar(32)` | Không | FK → `plate_appearances.id`, ON DELETE CASCADE. |
| `reviewer_id` | `varchar(32)` | Không | FK → `users.id`, ON DELETE RESTRICT. |
| `action` | `varchar(16)` | Không | CHECK trong `confirm`, `correct`, `unreadable`, `reject`. |
| `corrected_text` | `varchar(128)` | Có | Nội dung sửa đã chuẩn hóa; runtime chỉ lưu khi action=`correct`. |
| `note` | `text` | Có | Ghi chú; API giới hạn 2.000 ký tự, DB không giới hạn riêng. |
| `revision` | `integer` | Không | CHECK `> 0`; UQ ghép `(appearance_id, revision)`. |
| `created_at` | `timestamptz` | Không | D=`now()`. |

DB không có CHECK ghép action với corrected_text hoặc FK ghép revision đến appearance. API yêu cầu `corrected_text` chỉ cho action `correct`, giới hạn đầu vào 64 ký tự trước chuẩn hóa, đồng thời đồng bộ revision trong transaction. Không có endpoint sửa/xóa riêng lịch sử review.

#### 10.3.9. `schema_migrations` - quản lý phiên bản schema

| Trường | Kiểu PostgreSQL | NULL | Ràng buộc và ý nghĩa |
|---|---|---|---|
| `version` | `text` | Không | PK; tên file migration như `0003_ocr_decoding.sql`. |
| `checksum` | `char(64)` | Không | SHA-256 nội dung SQL đã áp dụng. |
| `applied_at` | `timestamptz` | Không | D=`now()`; thời điểm áp dụng. |

Bảng này được tạo bởi `migrate.ts`, không nằm trong file 0001. Migration chạy dưới transaction và advisory lock, chỉ áp dụng phiên bản chưa có; checksum phát hiện việc sửa một migration đã chạy. Readiness kiểm tra đủ tập phiên bản/checksum và báo lỗi nếu schema lệch. Không sửa nội dung migration đã dùng cho môi trường triển khai; thay đổi tiếp theo cần file migration mới.

### 10.4. Thiết kế JSONB và dữ liệu bất biến

`pipeline_snapshot` lưu cấu hình server đã resolve: ID/version/task pipeline, detector, tracker, recognizer, preprocessing/fusion, device, interpreter và checksum checkpoint/code tùy nhánh. Snapshot hiện hành gồm thêm `sampling`, `tracking`, `empty_scene_gate` và `recognizer.config` (decoder, beam_width, use_tta); job lịch sử có cấu trúc riêng, không chạy lại được. Mặc dù SQL chỉ CHECK object, registry và worker xác minh cấu hình, file và checksum khi nhận/chạy job. Client gửi `pipeline_id`, không được gửi đường dẫn checkpoint hoặc interpreter tùy ý.

`statistics` là object thống kê của lần chạy, có thể chứa số frame lấy mẫu, track đủ/thiếu điều kiện và lý do loại bỏ. Không có cột phần trăm suy đoán. `bbox`/`crop_bbox` dùng tọa độ pixel của frame, không phải ảnh OCR đã resize; worker kiểm tra bốn số hữu hạn, vùng hợp lệ trong frame và kích thước crop thực tế. `character_scores` để NULL nếu model không cung cấp.

`input_storage_keys` và `frame_weights` là hai mảng đồng thứ tự với năm detection được chọn. Chẳng hạn khóa số 1 và trọng số số 1 đều nói về crop ở `selected_order=1`. Tính duy nhất, thứ tự thời gian và sự trùng khớp giữa keys với bằng chứng được worker xác minh trước transaction lưu. PostgreSQL chỉ kiểm tra hình dạng mảng cơ bản như đã liệt kê.

Prediction và snapshot được coi là bất biến qua luồng API. Đây là chính sách ứng dụng, **không phải trigger chống UPDATE** hay quyền DB chỉ append. Review cập nhật kết luận hiệu lực và tạo lịch sử mới, không sửa `raw_text`, `normalized_text`, `machine_text` hay prediction joint. Người vận hành có quyền SQL vẫn phải tuân thủ quy trình này.

### 10.5. Index đang triển khai

Mỗi PK/UQ nêu trong từ điển được PostgreSQL bảo vệ bằng unique index. Các index không unique được khai báo riêng:

| Tên index | Cột / điều kiện | Truy vấn được hỗ trợ |
|---|---|---|
| `auth_sessions_user_expiry` | `(user_id, expires_at)` | Tra phiên theo user; phục vụ quản lý/thu hồi phiên. |
| `media_assets_owner_uploaded` | `(owner_id, uploaded_at DESC)` | Danh sách nguồn theo chủ và thời gian. |
| `recognition_jobs_queue` | `(status, created_at, id)` | Claim job chờ theo thứ tự ổn định. |
| `recognition_jobs_media_created` | `(media_id, created_at DESC, id DESC)` | Lịch sử và job mới nhất của một nguồn. |
| `plate_appearances_job` | `(job_id)` | Kết quả/CSV theo job; xóa theo cascade. |
| `plate_appearances_effective_text` | `(effective_text)` | Tìm kiếm chuỗi chuẩn hóa chính xác. |
| `plate_appearances_review_status` | `(review_status)` | Lọc trạng thái duyệt. |
| `plate_detections_legacy_crop` | `(legacy_crop_id)` | Giữ từ 0001 cho dữ liệu lịch sử; API hiện hành không truy vấn. |
| `ocr_predictions_appearance` | `(appearance_id) WHERE appearance_id IS NOT NULL` | Truy vấn dự đoán joint theo appearance. |
| `recognition_reviews_reviewer` | `(reviewer_id)` | Truy vết người kiểm duyệt. |

UQ `(appearance_id, selected_order)` hỗ trợ tải detection có thứ tự. UQ `(appearance_id, revision)` hỗ trợ lịch sử review; UQ `(detection_id, variant)` hỗ trợ OCR từng crop. Không giả định PostgreSQL tự tạo index cho mọi FK. Chưa có GIN cho JSONB hoặc trigram để tìm gần đúng; chức năng hiện hành tìm bằng `effective_text = giá_trị_chuẩn_hóa`. Tối ưu thêm phải dựa trên dữ liệu và execution plan, không chỉ số lượng endpoint.

### 10.6. Transaction và cạnh tranh cập nhật

**Tạo job:** API kiểm tra quyền, resolve profile, sau đó khóa nguồn để tạo job. Nhiều job được phép tham chiếu cùng media. Bản snapshot thuộc job mới, không ghi đè lượt chạy cũ.

**Hàng đợi và lưu kết quả:** worker dùng khóa advisory cho mô hình một worker, claim queued job bằng khóa hàng với `FOR UPDATE SKIP LOCKED`. Sau inference và kiểm tra bằng chứng, transaction khóa job đang running, insert toàn bộ appearance/detection/prediction rồi chuyển sang succeeded. Nếu lưu lỗi, transaction rollback; không công bố một nửa tập kết quả thành công. Việc ghi file và commit SQL không phải distributed transaction; xử lý lỗi và dọn thư mục do runtime đảm nhiệm.

**Kiểm duyệt:** client đọc `revision=r` và gửi `expected_revision=r`. API khóa appearance bằng `FOR UPDATE`, kiểm tra quyền và trạng thái job, so sánh revision, tính kết luận mới, cập nhật appearance rồi insert review revision `r+1` trong cùng transaction. Hai người cùng sửa từ revision r: chỉ lần đầu thành công, lần sau nhận 409 và cần tải lại kết quả.

`effective_text` là dữ liệu lưu sẵn có kiểm soát, giúp tra cứu không phải tổng hợp toàn bộ review mỗi lần. Lúc tạo kết quả, nó bằng `machine_text`, `review_status='pending'`, revision 0. Các action tạo trạng thái sau:

- `confirm`: lấy lại machine_text; yêu cầu máy có chuỗi đọc được; trạng thái `confirmed`.
- `correct`: lấy corrected_text đã chuẩn hóa và không rỗng; trạng thái `corrected`.
- `unreadable`: effective_text NULL; trạng thái `unreadable`.
- `reject`: effective_text NULL; trạng thái `rejected`.

Vì confirm luôn xác nhận **kết quả máy**, thực hiện confirm sau một lần correct sẽ đưa effective_text về machine_text. Kết luận mới nhất quyết định hiển thị/tra cứu; toàn bộ review cũ vẫn còn.

### 10.7. Quy tắc xóa và vòng đời dữ liệu

FK từ nguồn đến job là RESTRICT: phải xóa tất cả job tham chiếu rồi mới xóa nguồn. API chỉ cho xóa job đã succeeded/failed. Xóa job cascade đến appearances, detections, reviews và prediction ở cả hai nhánh; không xóa media. Người gọi phải có quyền trên nguồn.

Runtime khóa media theo cùng thứ tự khi tạo/xóa job hoặc xóa nguồn, đưa thư mục cần xóa vào vùng cách ly, rồi xóa dữ liệu trong transaction. Nếu SQL thất bại thì phục hồi thư mục; nếu commit thành công nhưng purge file lỗi, phần tồn dư nằm ở vùng rác không được API phục vụ và cần dọn theo quy trình vận hành. Không mô tả cơ chế này là giao dịch nguyên tử tuyệt đối giữa DB và filesystem.

Không có API xóa tài khoản trong bản đầu. FK owner/reviewer RESTRICT bảo vệ chủ nguồn và người đã kiểm duyệt; session CASCADE chỉ áp dụng nếu một user thực sự bị xóa bằng thao tác quản trị phù hợp. Sao lưu cần gồm **PostgreSQL và cây file bằng chứng tương ứng**, vì backup DB đơn lẻ không tái tạo ảnh/video.

### 10.8. Kiểm tra tại DB và tại API/worker

DB bảo đảm quan hệ FK, PK/UQ, tập status/role/action, các CHECK số cơ bản, hai object JSON, XOR parent OCR, số lượng phần tử mảng joint và count NULL cho joint. DB không tự thực hiện phân quyền theo tài khoản bằng Row Level Security trong schema này; `AuthGuard`/`Ownership` và câu truy vấn lọc owner thực thi quyền truy cập.

API/worker bảo đảm tài khoản còn hoạt động, Admin cuối cùng, kiểu file hợp lệ, path nằm trong storage, pipeline sẵn sàng, five-frame-joint chỉ nhận video, năm frame **khác nhau theo thứ tự thời gian**, track không bị lặp trong một job, crop/frame đúng geometry, normalized_text khớp raw_text, weights hữu hạn trong [0,1] với tổng xấp xỉ 1, và kết luận tổng hợp nhất quán với prediction. Không có CHECK đếm đúng năm detection hoặc FK từ từng phần tử `input_storage_keys` đến crop. Mọi công cụ import/ghi DB trực tiếp phải giữ những bất biến này.

Số frame ở DB cho phép 0 để tương thích dữ liệu cũ; worker video mới yêu cầu >=1. Số lần xuất hiện, thứ tự selected_order và trạng thái review không nên được suy ra từ giới hạn rộng hơn của SQL. Đây là khác biệt chủ ý giữa schema lưu trữ và hợp đồng đầu vào hiện hành.

### 10.9. Dữ liệu lịch sử

Bản FastAPI/SQLite đầu và API v1 `/api/v1/plate-jobs` đã ngừng sử dụng; công cụ nhập SQLite đã được gỡ. Job đã nhập trước đó vẫn nằm trong cùng schema với `job_kind='detect_only'`, mỗi crop là một appearance `machine_status='not_run'`, `legacy_crop_id` giữ ID crop cũ. Các bản ghi này vẫn xem, kiểm duyệt và xuất CSV qua API v2; worker từ chối chạy lại snapshot không có `task` (`PIPELINE_FAILED`). Schema giữ nguyên cột/index lịch sử vì migration đã áp dụng không được sửa.

### 10.10. Ví dụ SQL chỉ đọc

Các truy vấn sau minh họa nghiệp vụ cho công cụ backend hoặc tài khoản DB có quyền đọc. `$1`, `$2` là tham số bind, không nối trực tiếp chuỗi do người dùng nhập. Đây không phải API thay thế và không tự cấp quyền Admin.

**Nguồn của một tài khoản và số lần chạy:**

```sql
SELECT m.id, m.original_name, m.media_type, m.uploaded_at,
       count(j.id) AS job_count
FROM media_assets m
LEFT JOIN recognition_jobs j ON j.media_id = m.id
WHERE m.owner_id = $1
GROUP BY m.id
ORDER BY m.uploaded_at DESC, m.id
LIMIT 50;
```

**Tra biển số trên job thành công mới nhất của từng nguồn thuộc user:**

```sql
WITH latest AS (
    SELECT DISTINCT ON (j.media_id) j.id, j.media_id
    FROM recognition_jobs j
    JOIN media_assets m ON m.id = j.media_id
    WHERE m.owner_id = $1 AND j.status = 'succeeded'
      AND (j.job_kind = 'recognize' OR j.pipeline_snapshot->>'task' = 'prepare')
    ORDER BY j.media_id, j.created_at DESC, j.id DESC
)
SELECT a.id, a.machine_text, a.effective_text, a.review_status,
       a.recognition_method, a.revision, l.media_id
FROM latest l
JOIN plate_appearances a ON a.job_id = l.id
WHERE a.effective_text = $2
ORDER BY a.id
LIMIT 50;
```

`$2` đã được chuẩn hóa bởi cùng hàm ứng dụng. Bộ lọc `effective_text` đặt **sau** việc chọn job mới nhất: không lấy job cũ chỉ vì job mới không còn biển số cần tìm. Prepare thành công cũng được tính là lần xử lý mới nhất; dữ liệu lịch sử luôn xem được qua job cụ thể.

**Kiểm tra lịch sử một kết quả trong phạm vi user:**

```sql
SELECT r.revision, r.action, r.corrected_text, r.note, r.created_at,
       u.display_name AS reviewer_name
FROM recognition_reviews r
JOIN plate_appearances a ON a.id = r.appearance_id
JOIN recognition_jobs j ON j.id = a.job_id
JOIN media_assets m ON m.id = j.media_id
JOIN users u ON u.id = r.reviewer_id
WHERE m.owner_id = $1 AND a.id = $2
ORDER BY r.revision;
```

### 10.11. Nguồn đối chiếu và giới hạn

- [Migration 0001](../../src/database/migrations/0001_business.sql): tám bảng, FK/UQ/CHECK và index gốc.
- [Migration 0002](../../src/database/migrations/0002_joint_ocr.sql): joint OCR, nullable count, parent XOR và provenance.
- [Migration 0003](../../src/database/migrations/0003_ocr_decoding.sql): bằng chứng decoder CTC `decoding`.
- [Migration runner](../../src/database/migrate.ts): bảng schema_migrations, checksum và readiness.
- [Worker engine](../../src/recognition/engine.ts): claim, validation năm crop, lưu kết quả trong transaction.
- [Results controller](../../src/results/results.controller.ts): review, effective_text, tìm kiếm mới nhất, CSV và lọc storage key.
- [Jobs controller](../../src/jobs/jobs.controller.ts), [Media controller](../../src/media/media.controller.ts): tạo/xóa và khóa nguồn.
- [Ownership](../../src/common/ownership.ts): quyền truy cập xuyên quan hệ.

Tài liệu ghi nhận schema hiện tại, không khẳng định đã có chính sách retention tự động, mã hóa từng file, tìm kiếm gần đúng, RLS, audit mọi hành động Admin, hay benchmark tải lớn. Khi bổ sung các yêu cầu này, cần cập nhật nghiệp vụ, migration và kiểm thử tương ứng.

## 11. Thiết kế API nghiệp vụ

### 11.1. Quy ước chung

- Prefix nghiệp vụ mới là `/api/v2`. Các đường dẫn rút gọn ở bảng dưới được ghép với prefix này.
- Login và health không cần token. Mọi endpoint dữ liệu đều xác thực `Authorization: Bearer <access_token>`.
- User thao tác nguồn của mình; Admin toàn hệ thống. Kiểm quyền áp dụng cả metadata, media, crop/frame, review và CSV. Tài nguyên không tồn tại hoặc không thuộc quyền trả `404`; chức năng chỉ Admin trả `403` khi User gọi.
- List phân trang trả `{total, limit, offset, items}`; `limit` mặc định 50, miền 1-200; `offset>=0`. `/pipelines` là danh mục cấu hình trả `{items}`, không phải list phân trang.
- Filter thời gian dùng ISO 8601 có timezone. Lịch sử job lọc theo `created_at`; tìm kết quả lọc theo `uploaded_at` của nguồn. Timestamp trong video là vị trí tương đối, không phải ngày giờ camera quay.
- Chuẩn hóa biển số: uppercase, bỏ khoảng trắng và dấu gạch nối; không tự đổi `O/0`, `I/1`. Tìm `plate` khớp chính xác chuỗi đã chuẩn hóa, chưa có fuzzy search.
- JSON công khai không trả storage key, đường dẫn model/interpreter, password hash hoặc token hash. Các API đặt `Cache-Control: private, no-store` và `X-Content-Type-Options: nosniff`.
- Body sai cấu trúc/giá trị trả `422`. Không nhận checkpoint hoặc đường dẫn nội bộ tùy ý từ client.

### 11.2. Danh mục 21 endpoint v2

Quyền “chủ sở hữu/Admin” trong bảng được tính theo owner của nguồn; các lần chạy và bằng chứng kế thừa quyền này.

| Mã | Method và đường dẫn | Input chính | Kết quả thành công | Quyền / use case |
|---|---|---|---|---|
| API01 | `POST /auth/login` | `email`, `password` | `200` token Bearer, hạn dùng | Tài khoản hoạt động; UC01 |
| API02 | `POST /auth/logout` | Bearer hiện tại | `204`, thu hồi phiên hiện tại | Đã đăng nhập; UC01 |
| API03 | `GET /auth/me` | Bearer hiện tại | `200` user công khai, role, trạng thái | Đã đăng nhập; UC01 |
| API04 | `GET /users` | `limit`, `offset` | `200` danh sách tài khoản | Admin; UC02 |
| API05 | `POST /users` | `email`, `password`, `display_name`, `role` tùy chọn | `201` tài khoản mới | Admin; UC02 |
| API06 | `PATCH /users/{id}` | Ít nhất một trường `display_name`, `role`, `is_active`, `password` | `200` tài khoản sau cập nhật | Admin; UC02 |
| API07 | `POST /media` | Multipart một `file` | `201` `media_id`, metadata, `content_url` | Đã đăng nhập, nguồn mới gán cho người upload; UC03 |
| API08 | `GET /media` | `limit`, `offset` | `200` danh sách nguồn | Chủ sở hữu/Admin; UC03 |
| API09 | `GET /media/{id}/content` | ID, header `Range` tùy chọn | `200` file hoặc `206` byte range | Chủ sở hữu/Admin; UC06 |
| API10 | `DELETE /media/{id}` | ID | `204` khi hết tham chiếu | Chủ sở hữu/Admin; UC11 |
| API11 | `GET /pipelines` | Không cần body | `200` profile, task, media_types, version, ready | Đã đăng nhập; UC04, UC12 |
| API12 | `POST /recognition-jobs` | `media_id`, `pipeline_id`, `input_mode=scene\|plate_crop` | `202` job_id, queued, status_url | Chủ sở hữu/Admin; UC04, UC12 |
| API13 | `GET /recognition-jobs` | `media_id`, `status`, `created_from/to`, phân trang | `200` lịch sử lượt chạy | Chủ sở hữu/Admin; UC05 |
| API14 | `GET /recognition-jobs/{id}` | ID | `200` status, stage, statistics, thời gian, lỗi | Chủ sở hữu/Admin; UC05 |
| API15 | `GET /recognition-jobs/{id}/results` | ID, phân trang | `200` danh sách appearance của lượt thành công | Chủ sở hữu/Admin; UC06 |
| API16 | `DELETE /recognition-jobs/{id}` | ID | `204`, xóa lượt đã kết thúc, giữ nguồn | Chủ sở hữu/Admin; UC10 |
| API17 | `GET /recognition-results` | `plate`, `media_id`, `review_status`, `uploaded_from/to`, phân trang | `200` kết quả ở job v2 thành công mới nhất mỗi nguồn | Chủ sở hữu/Admin; UC08 |
| API18 | `GET /recognition-results/{id}` | Appearance ID | `200` kết quả, detections, predictions, reviews | Chủ sở hữu/Admin; UC06 |
| API19 | `GET /detections/{id}/artifacts/{kind}` | Detection ID, `kind=crop\|frame\|enhanced` | `200` file đúng MIME nếu có | Chủ sở hữu/Admin; UC06 |
| API20 | `POST /recognition-results/{id}/reviews` | `action`, `expected_revision`, `note?`, `corrected_text` chỉ khi correct | `201` bản ghi lịch sử/revision mới | Chủ sở hữu/Admin; UC07 |
| API21 | `GET /recognition-jobs/{id}/export` | ID, `format=csv` mặc định | `200` file CSV UTF-8 BOM | Chủ sở hữu/Admin; UC09 |

`role` khi tạo user mặc định `user`; không có API đăng ký công khai, xóa tài khoản hoặc quên mật khẩu qua email. Admin bootstrap bằng CLI, reset bằng API06. Email chuẩn hóa unique; mật khẩu tạo/reset dài 12-1024 ký tự; `display_name` không rỗng, tối đa 120 ký tự.

Upload hỗ trợ JPG/PNG/MP4/AVI/MOV; mặc định tối đa 500 MiB theo cấu hình, ảnh tối đa 25 MP. API07 kiểm giải mã thực, không chỉ tin extension/MIME client. `size_bytes`, width/height và duration là metadata của nguồn; crop_width/height nằm ở detection để đánh giá độ phân giải biển số.

### 11.3. Hợp đồng kết quả và review

Appearance chứa `machine_text`, `machine_status`, `recognition_method`, `agreement_count`, `effective_text`, `review_status`, `revision` và vị trí xuất hiện. `machine_text` là kết luận máy của lượt chạy; `effective_text` ban đầu bằng machine_text nếu có, sau đó theo review. `pending` có nghĩa chưa được con người xác nhận, dù chuỗi đang xuất hiện trong kết quả tìm kiếm.

Detail joint-five trả một prediction trong `predictions[]` cấp appearance, với `raw_text`, `normalized_text`, `ocr_score`, `frame_weights`, `decoding`, `latency_ms` và `detection_ids` theo thứ tự input. Mỗi detection có `crop_url`, `frame_url`, bbox, crop_bbox, detection_score và vị trí frame; không sinh năm prediction độc lập từ một output joint. Prepare có predictions rỗng; enhanced_url chỉ có khi pipeline thực sự sinh nhánh đó, profile hiện tại chưa có SR.

Review đầu tiên gửi `expected_revision=0`. `corrected_text` bắt buộc và chỉ được phép xuất hiện khi `action=correct`; `note` tối đa 2000 ký tự, corrected_text tối đa 64 ký tự trước chuẩn hóa. Response API20 là bản ghi lịch sử mới; client có thể gọi API18 để lấy toàn bộ trạng thái hiệu lực và lịch sử.

| Action | Điều kiện riêng | Text hiệu lực sau review | review_status |
|---|---|---|---|
| `confirm` | Có machine_text | Machine text | `confirmed` |
| `correct` | Chuỗi sửa không rỗng sau chuẩn hóa | Chuỗi sửa đã chuẩn hóa | `corrected` |
| `unreadable` | Không yêu cầu chuỗi | `null` | `unreadable` |
| `reject` | Kết quả không phải biển số hoặc track ghép sai | `null` | `rejected` |

Tra cứu mặc định chỉ chọn job `succeeded` mới nhất mỗi nguồn theo `created_at DESC, id DESC`; prepare cũng là job hợp lệ. Một job queued hoặc failed mới hơn không che kết quả thành công cũ. Nếu một lượt mới thành công nhưng không có appearance, tìm kiếm nguồn đó không trả lại appearances của lượt cũ. Lượt cũ vẫn truy cập theo ID job. Quy tắc này tránh trộn kết quả rerun nhưng không có nghĩa toàn bộ source đã được nhận diện đúng.

CSV gồm ID appearance/job/track, machine/effective text, machine/review status, recognition_method, agreement_count, first/last frame, start/end seconds. Joint-five xuất agreement rỗng do DB NULL. CSV escape dấu nháy và tiền tố có thể trở thành công thức bảng tính; xuất file không thay đổi review hoặc tạo ground truth.

### 11.4. Endpoint vận hành

`GET /` trả thông tin dịch vụ; `GET /health` là liveness; `GET /health/ready` kiểm kết nối PostgreSQL và toàn bộ version/checksum migration, trả `503` khi thiếu/sai schema. Các endpoint này không tính trong 21 API nghiệp vụ. Swagger được phục vụ ở `/docs`; tài liệu API không chứng minh frontend đã xây hoặc worker/model đang chạy.

### 11.5. Mã phản hồi và lỗi

| Mã | Ý nghĩa / ví dụ |
|---|---|
| `200` | Đọc/cập nhật thành công, login hoặc download toàn file. |
| `201` | Tạo tài khoản/media/review. |
| `202` | Job đã được xếp hàng, chưa có kết quả inference. |
| `204` | Logout/xóa thành công, không có body. |
| `206` | Trả một phần file nguồn theo Range hợp lệ. |
| `401` | Thiếu/sai/hết hạn/thu hồi phiên hoặc sai thông tin đăng nhập. |
| `403` | Tài khoản không có role Admin cho API quản trị. |
| `404` | Không tồn tại hoặc không thuộc quyền; artifact chưa có. |
| `409` | Revision cũ; kết quả job chưa succeeded; job chưa kết thúc; media còn tham chiếu; email trùng; khóa/hạ quyền Admin cuối cùng. |
| `413` | File vượt giới hạn upload. |
| `415` | Loại file/extension không hỗ trợ. |
| `416` | Range nằm ngoài file; kèm `Content-Range: bytes */<size>`. |
| `422` | Body/filter sai; file hỏng; input mode không phù hợp; ảnh đơn vào joint-five; confirm khi chưa có text; correction rỗng. |
| `503` | Model/config chưa sẵn sàng; probe không chạy được; readiness DB/schema lỗi. |
| `500` | Lỗi máy chủ ngoài các trường hợp đã ánh xạ; không trả stack trace/đường dẫn nội bộ. |

Body lỗi có dạng `{detail: ...}`. Lỗi xử lý sau khi đã nhận job không đổi response POST cũ: client quan sát `status=failed` cùng `error_code`, `error_message` qua API14. Các mã worker hiện gồm `INPUT_CHANGED`, `CHECKPOINT_MISSING`, `ENVIRONMENT_ERROR`, `JOB_TIMEOUT`, `WORKER_INTERRUPTED`, `INVALID_VIDEO`, `CUDA_ERROR`, `CUDA_UNAVAILABLE`, `RESULT_INVALID`, `PIPELINE_FAILED`.

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

## 13. Nghiệm thu, truy vết và đánh giá đề tài

### 13.1. Ma trận nghiệm thu chức năng

Các tình huống dưới đây là tiêu chí có thể thực hiện lại; một dòng không đồng nghĩa có một test tự động riêng. Test API có fixture không thay thế nghiệm thu model trên nguồn thật.

| Mã | Tình huống / dữ liệu | Kết quả mong đợi | Truy vết |
|---|---|---|---|
| AT01 | Login đúng, sai, tài khoản khóa; logout và dùng lại token | Chỉ phiên hợp lệ được dùng; token sau logout bị từ chối | UC01; FR01; NFR01 |
| AT02 | Admin tạo email trùng, reset, đổi vai trò, khóa Admin cuối | Unique 409; reset/khóa thu hồi phiên; không mất Admin cuối | UC02; FR02; NFR02 |
| AT03 | User B truy cập media/job/result/crop/review/CSV của A | Từ chối cả metadata và file; Admin đọc được | UC02-UC12; FR03; NFR01 |
| AT04 | Upload ảnh/video hợp lệ, file rỗng/hỏng/giả loại/quá lớn | Metadata đúng; 413/415/422 tương ứng; không để nguồn hợp lệ giả | UC03; FR04-05 |
| AT05 | Đọc nguồn toàn bộ, Range hợp lệ, Range ngoài file | 200/206 đúng MIME; 416 đúng Content-Range | UC06; FR05 |
| AT06 | Tạo job khi model thiếu; gửi đường dẫn lạ, mode sai | Không xếp hàng cấu hình tùy ý; 503/422 theo nguyên nhân | UC04; FR06-07 |
| AT07 | Chạy lại cùng media với profile/snapshot khác | Hai ID và kết quả độc lập; nguồn không upload lại | UC04; FR07; NFR03 |
| AT08 | Prepare ảnh không/một/nhiều biển số; plate_crop | 0/1/n appearances theo detector; plate_crop bỏ detector; chưa có OCR | UC12; FR09 |
| AT09 | Video track đủ/thiếu 5 frame; frame lặp hoặc sai thứ tự | Đủ 5 crop thật được xử lý; thiếu bị loại có thống kê; manifest sai bị từ chối | UC04, UC12; FR10 |
| AT10 | Model joint-five đọc được hoặc trả chuỗi rỗng | Một prediction/appearance; readable/unreadable; agreement NULL; không có OCR từng crop giả | UC04, UC06; FR11-12 |
| AT11 | Ảnh đơn gửi profile Kaggle; ảnh prepare nhập tay | OCR joint từ chối 422; prepare cho correct, chưa có model ảnh đơn | UC04, UC12; FR09, FR13 |
| AT12 | Worker timeout/crash/restart, source hoặc checkpoint thay đổi | Failed với mã lỗi; không công bố một phần; tạo job mới để chạy lại | UC05; FR08; NFR05 |
| AT13 | Xem crop, frame, position, prediction, lịch sử | Đúng appearance/track; giữ thứ tự input; enhanced thiếu trả 404 | UC06; FR12; NFR03 |
| AT14 | Confirm/correct/unreadable/reject rồi tìm kiếm | Prediction/machine không đổi; text hiệu lực và lịch sử đúng action | UC07-08; FR13-14 |
| AT15 | Hai review cùng expected_revision | Chỉ một revision được chấp nhận; bên còn lại 409 | UC07; FR13; NFR02 |
| AT16 | Latest succeeded, queued/failed mới hơn, prepare | Tra cứu chọn đúng job thành công mới nhất; ID cũ vẫn xem được | UC08; FR15 |
| AT17 | CSV có ký tự Unicode, dấu nháy, tiền tố công thức, 0 kết quả | UTF-8 BOM; escape đúng; không lộ nguồn khác; 0 kết quả còn header | UC09; FR16 |
| AT18 | Xóa job running, terminal và nguồn còn/hết tham chiếu | Running 409; terminal xóa dữ liệu phát sinh; v2 giữ nguồn; media có job 409 | UC10-11; FR17 |
| AT19 | Chạy migration, FK/cascade, rollback | Schema đúng checksum; migration đã áp dụng không bị sửa; rollback không để dữ liệu dở | FR18; NFR02-03 |
| AT20 | DB mất kết nối/thiếu migration và API còn chạy | Liveness 200, readiness 503; không suy ra model đã sẵn sàng | NFR07 |

### 13.2. Ma trận liên kết yêu cầu với thành phần thực hiện

| Nhóm yêu cầu | API liên quan | Dữ liệu chính | Nơi kiểm chứng |
|---|---|---|---|
| FR01-02: phiên, quản trị tài khoản | API01-06 | users, auth_sessions | `tests/api.test.ts`, `src/auth` |
| FR03: phân quyền xuyên tài nguyên | API04-10, API12-21 | owner nguồn và quan hệ FK | `tests/api.test.ts`, `src/common/ownership.ts` |
| FR04-05: nguồn và file | API07-10 | media_assets, source filesystem | `tests/api.test.ts`, `scripts/probe_media.py` |
| FR06-08: cấu hình, queue, vòng đời | API11-16 | recognition_jobs, snapshot, statistics | `tests/recognition.test.ts`, registry/engine/worker |
| FR09-11: prepare, tracking, OCR | API12, API15, API18 | appearances, detections, predictions | `tests/test_ml_adapter.py`, `tests/test_icpr_adapter.py`, joint worker tests |
| FR12-13: bằng chứng và review | API15, API18-20 | detections, predictions, reviews, revision | `tests/joint-results.test.ts`, `tests/api.test.ts` |
| FR14-16: tra cứu và CSV | API17, API21 | effective_text, latest job | `tests/api.test.ts`, `tests/joint-results.test.ts` |
| FR17-18: xóa, migration | API10, API16 | FK/cascade, storage, schema_migrations | `tests/db.test.ts`, `tests/api.test.ts` |
| NFR07: hợp đồng API/schema | Health, Swagger | schema_migrations | `tests/openapi.test.ts`, `tests/db.test.ts` |
| NFR08: chất lượng nghiên cứu | Đánh giá offline | Ground truth độc lập, output đã cố định | [EVALUATION.md](../EVALUATION.md), evaluator tests |

### 13.3. Mức bằng chứng kiểm thử đã có

Baseline đã ghi nhận trong các lượt triển khai là **48 test Node và 98 test Python đạt**; một lượt kiểm tra API/OpenAPI tiếp theo ghi nhận **24 test có mục tiêu đạt**, kèm build/format. Hai số Node không cộng thành 72 vì lượt 24 là chạy lại một phần phạm vi. Đây là bằng chứng đã ghi nhận của các lượt trước, không phải tuyên bố vừa chạy lại toàn bộ test khi soạn tài liệu.

Test Node dùng NestJS/HTTP và PostgreSQL thật trong DB/cluster tạm; nhiều kết quả ML hoàn tất được tạo bằng fixture để kiểm quyền, transaction và hợp đồng. Test adapter/runner kiểm số frame, preprocessing, output và lỗi nhưng không đo accuracy. Đã ghi nhận smoke inference checkpoint/video thực trong quá trình tích hợp; smoke chứng minh đường chạy thực hiện được trên mẫu đó, không chứng minh chất lượng toàn tập hoặc khả năng tổng quát sang biển số Việt Nam.

Để tái lập xác minh kỹ thuật, dùng [TESTING_NEST.md](../TESTING_NEST.md) và lệnh trong [README](../../README.md). Cần lưu commit, dependency, cấu hình, phần cứng, ngày chạy và log từng đợt nếu dùng các con số này trong báo cáo nghiệm thu. Sau một thay đổi runtime mới, chỉ báo test là hiện hành khi đã chạy lại phạm vi chịu ảnh hưởng.

### 13.4. Thiết kế đánh giá low-resolution

Đánh giá recognizer trên crop và toàn pipeline trên ảnh/video nguồn là hai thí nghiệm khác nhau. Trong thí nghiệm recognizer, đầu vào đã có crop và đúng nhóm năm frame. Trong thí nghiệm toàn pipeline, việc bỏ sót detection, không đủ frame hoặc ghép sai track cũng là lỗi nghiệp vụ cần đếm/báo cáo; không chỉ chấm các appearance pipeline đã tạo thành công.

Các metric tối thiểu:

- **Exact plate accuracy:** số mẫu có chuỗi dự đoán chuẩn hóa khớp toàn bộ nhãn / số mẫu hợp lệ trong tập đánh giá đã định nghĩa. Chốt trước cách xử lý nhãn mơ hồ và ký tự ngoài alphabet.
- **Character error rate (CER):** tổng khoảng cách Levenshtein trên chuỗi dự đoán/nhãn chia tổng số ký tự nhãn. Không coi detector score, frame weight hoặc tỷ lệ review confirm là accuracy.
- **Unreadable rate và coverage:** tỷ lệ dự đoán rỗng/không đọc được; tỷ lệ mẫu tạo được kết quả. Với pipeline cần báo riêng số nguồn/biển số bỏ sót, track bị loại vì thiếu frame và track ghép sai.
- **Latency:** thời gian recognizer và end-to-end tách riêng; ghi cả thời gian chờ queue nếu báo thời gian người dùng phải đợi. Báo thiết bị, batch, độ dài video, số track và warm-up, thay vì một số thời gian thiếu điều kiện.
- **Chất lượng theo kích thước crop:** nhóm theo crop width/height hoặc quy tắc phân nhóm đã công bố. Độ phân giải toàn video không đủ mô tả độ khó của vùng biển số.

Thí nghiệm chính hiện phù hợp là checkpoint Kaggle joint-five trên đúng nhóm năm crop thật và toàn pipeline đã tích hợp. So sánh một ảnh với năm ảnh cần recognizer/baseline một ảnh có preprocessing/checkpoint hợp lệ; không lặp một crop năm lần rồi gọi đó là baseline ảnh đơn của model hiện tại. Nếu bổ sung SR thật, so sánh cùng mẫu trước/sau SR; hiện tại chưa có nhánh SR nên không ghi kết quả SR giả định.

Train/validation/test nên tách theo nguồn và danh tính biển số khi có metadata; các frame gần nhau/crop của cùng track không được chia ngẫu nhiên sang hai tập. Nhãn chuẩn phải độc lập với output máy và lịch sử người dùng xác nhận. Chốt rule chuẩn hóa, ghép output với ground truth, xử lý bỏ sót và khoảng tin cậy trước khi xem test set. Các rule/threshold mới chỉ điều chỉnh trên validation; test dùng cho lần báo cáo cuối.

Model đang phục vụ biển số Brazil. Dữ liệu Việt Nam cần tập đánh giá và công bố riêng; không diễn giải việc model trả được một chuỗi là xác nhận hỗ trợ đúng biển số Việt Nam. Tài liệu này không đặt một mục tiêu accuracy/SLA chưa được đo hoặc phê duyệt.

### 13.5 Ma trận nghiệm thu nghiệp vụ

Các tình huống dưới đây là tiêu chí để nghiệm thu hệ thống. Chúng không thay thế báo cáo chạy test và không khẳng định đã đo chất lượng OCR trên tập nhãn chuẩn.

| Mã | Tình huống | Kết quả cần quan sát | Truy vết |
|---|---|---|---|
| AC01 | User A biết ID nguồn/job/result của User B | Metadata, file, bằng chứng và CSV đều bị chặn; Admin hợp lệ xem được theo quyền. | FR03; UC03, UC05-UC11 |
| AC02 | Admin khóa hoặc đặt lại mật khẩu; hạ quyền Admin cuối cùng | Các phiên đối tượng bị thu hồi khi khóa/reset; thao tác làm mất Admin hoạt động cuối cùng bị từ chối. | FR01-02; UC01-UC02 |
| AC03 | File hợp lệ, quá dung lượng, sai loại và hỏng | Chỉ nguồn hợp lệ được ghi nhận; các lỗi lần lượt trả mã theo UC03, không tự tạo job. | FR04-05; UC03 |
| AC04 | Ảnh không có, một, nhiều biển số và ảnh crop sẵn chạy prepare | Số appearance theo detection; plate_crop bỏ detector; không có OCR giả; có thể nhập tay trên appearance hợp lệ. | FR09; UC12 |
| AC05 | Video có track đủ/thiếu năm frame hoặc track ghép sai | Chỉ track đủ năm frame khác nhau đi tiếp; track thiếu có thống kê loại; người kiểm duyệt có thể reject track sai. | FR10, FR13; UC04, UC07 |
| AC06 | Chạy Kaggle joint-five | Lưu một prediction theo appearance, liên kết đúng năm crop; agreement_count và OCR score không được model cung cấp đều null. | FR11-12; UC04, UC06 |
| AC07 | Chạy lại cùng nguồn hoặc model/worker lỗi giữa lượt chạy | ID/snapshot mới độc lập; job lỗi có trạng thái failed; không làm mất kết quả cũ; running bị gián đoạn được phục hồi thành failed khi worker khởi động lại. | FR07-08; UC04-UC05 |
| AC08 | Hai người gửi review từ cùng revision | Chỉ một thao tác thành công; thao tác còn lại 409; machine text và predictions giữ nguyên. | FR13; UC07 |
| AC09 | Confirm, correct, unreadable, reject rồi tra cứu | effective_text và review_status đúng hành động; text được chuẩn hóa mà không đổi O/0; lịch sử chứa từng revision. | FR13-14; UC07-UC08 |
| AC10 | Nguồn có nhiều lượt succeeded/queued/failed | Tìm kiếm chỉ dùng lượt v2 succeeded mới nhất theo created_at rồi ID, bao gồm prepare; job khác trạng thái không che lượt thành công cũ. | FR15; UC08 |
| AC11 | Export có ký tự phân cách, dấu nháy, tiền tố công thức hoặc không có kết quả | CSV đọc được, escape đúng, có các cột nguồn kết quả/vị trí; không có kết quả vẫn có header. | FR16; UC09 |
| AC12 | Xóa job kết thúc và nguồn còn/không còn tham chiếu | Không xóa queued/running; xóa job giữ nguồn; nguồn còn job bị chặn 409; xóa hợp lệ không ảnh hưởng nguồn độc lập khác. | FR17; UC10-UC11 |

Với nghiệm thu low-resolution, cần thêm tập ground truth độc lập, danh sách split và cấu hình thiết bị. Báo cáo riêng chất lượng OCR trên crop và chất lượng toàn pipeline; checkpoint đã chạy được không đồng nghĩa đã đạt accuracy mục tiêu. Các yêu cầu tương lai về OCR ảnh đơn, SR, client hoàn chỉnh hoặc vận hành đa worker cần được bổ sung thành phạm vi và tiêu chí riêng trước khi nghiệm thu.

## 14. Nguồn đối chiếu, giới hạn và hướng mở rộng

### 14.1. Sổ nguồn dùng để lập tài liệu

| Nguồn | Vai trò / mức sử dụng |
|---|---|
| [auth.controller.ts](../../src/auth/auth.controller.ts), [auth.guard.ts](../../src/auth/auth.guard.ts), [security.ts](../../src/auth/security.ts) | Hành vi login/logout, quản trị, khóa tài khoản, token/password và role thực. |
| [media.controller.ts](../../src/media/media.controller.ts), [storage.ts](../../src/media/storage.ts), [probe_media.py](../../scripts/probe_media.py) | Upload, metadata, file access, giới hạn/giải mã, quarantine/restore/purge. |
| [jobs.controller.ts](../../src/jobs/jobs.controller.ts), [ownership.ts](../../src/common/ownership.ts) | Queue request, snapshot, scope sở hữu, readiness kết quả và điều kiện xóa. |
| [registry.ts](../../src/recognition/registry.ts), [engine.ts](../../src/recognition/engine.ts), [worker.ts](../../src/worker.ts) | Profile được phép, kiểm hash, claim/recover, supervisor, manifest validation, atomic persist. |
| [runner.py](../../app/recognition/runner.py), [icpr_adapter.py](../../app/recognition/icpr_adapter.py), [icpr_model.py](../../app/recognition/icpr_model.py) | Tích hợp ML, preprocessing và inference joint-five hiện hành. |
| [results.controller.ts](../../src/results/results.controller.ts) | Prediction detail, thứ tự detection_ids, review/revision, latest succeeded search và CSV. |
| [video_tracking.py](../../app/recognition/video_tracking.py), [icpr_adapter.py](../../app/recognition/icpr_adapter.py), [ctc_decoders.py](../../app/recognition/ctc_decoders.py) | Tracking, chọn 5 crop, model OCR và decoder port từ notebook. |
| [0001_business.sql](../../src/database/migrations/0001_business.sql), [0002_joint_ocr.sql](../../src/database/migrations/0002_joint_ocr.sql), [0003_ocr_decoding.sql](../../src/database/migrations/0003_ocr_decoding.sql) | Schema và ràng buộc vật lý; nguồn chính cho phần thiết kế DB. |
| [main.ts](../../src/main.ts), [app.module.ts](../../src/app.module.ts), [http.ts](../../src/common/http.ts) | Bootstrap, Swagger, response headers, health và ánh xạ lỗi. |
| [API.md](../API.md), [MODEL_INTEGRATION.md](../MODEL_INTEGRATION.md), [OCR_KAGGLE.md](../OCR_KAGGLE.md), [OPERATIONS.md](../OPERATIONS.md) | Hướng dẫn tích hợp/vận hành hỗ trợ; đối chiếu với mã nguồn khi có khác biệt. |
| [Notebook PBL6 PIPELINE](https://www.kaggle.com/code/trnvnhun/pbl6-pipeline) | Nguồn pipeline, model, preprocessing và decoder; đã đối chiếu checksum checkpoint với báo cáo lần chạy 13/10/2026; không dùng chỉ số trong notebook như accuracy của backend. Provenance cục bộ ở [icpr-source.json](../../models/icpr-source.json). |

Các sơ đồ PlantUML và SVG đi kèm là sản phẩm mô hình hóa mã nguồn; người đọc có thể chỉnh `.puml` rồi render lại. Vai trò client thể hiện hợp đồng cần cho frontend, không xác nhận đã triển khai giao diện. Phần DB phải đọc cùng migration, vì business rule như đúng năm frame và tổng frame_weights còn có kiểm tra trong worker, không được bảo đảm hoàn toàn chỉ bằng FK/JSONB check.

### 14.2. Các giới hạn đã xác định

1. **OCR ảnh đơn chưa có model tương thích được cấu hình.** Endpoint ảnh và prepare hoạt động; người dùng kiểm duyệt thủ công. Model joint-five hiện có không được ép đọc bằng cách nhân bản ảnh.
2. **Tracking không phải định danh xe.** Track có thể ghép sai; reject ghi lại kết luận nhưng không tự sửa track. Cùng biển số ở nhiều nguồn vẫn là nhiều appearance.
3. **Một worker và filesystem riêng.** Advisory lock chủ động giới hạn một worker trên DB. Chưa có hàng đợi phân tán, object storage, scale nhiều worker hoặc cơ chế tự reconcile mọi crash giữa DB/file.
4. **Readiness có phạm vi.** Health kiểm DB/schema, pipelines.ready kiểm file/config/checksum; chỉ job thực mới kiểm được toàn runtime/model/thiết bị. Chưa có endpoint xác nhận heartbeat worker đang sống.
5. **Đánh giá chất lượng còn tách riêng.** Test và smoke không thay ground truth độc lập; chưa xác nhận accuracy Việt Nam, SLA hoặc tải đồng thời production.
6. **Phạm vi nghiệp vụ giới hạn.** Chưa có camera live, bãi xe, chủ phương tiện, xử phạt, hủy job, chia sẻ dữ liệu, public signup, email reset, giao diện đầy đủ hoặc SR. Đây không phải các API bị bỏ sót trong 21 endpoint đã thống nhất cho bản đầu.

### 14.3. Thứ tự mở rộng đề xuất

Trước hết hoàn thiện client theo use case, triển khai API/worker/DB cùng chính sách backup và kiểm chứng với bộ dữ liệu Brazil có nhãn chuẩn. Tiếp theo bổ sung adapter/checkpoint ảnh đơn nếu nghiệp vụ cần, giữ nguyên cách lưu dự đoán máy/lịch sử kiểm duyệt. Khi có số đo tải và độ trễ, mới quyết định nhiều worker/queue riêng/object storage; thay đổi kiến trúc đó cần thiết kế lại quyền nhận job, heartbeat/recovery và lưu artifact. SR hoặc dữ liệu Việt Nam là thí nghiệm mới cần validation riêng, không là điều kiện ngầm để đánh dấu endpoint hoàn thành.
