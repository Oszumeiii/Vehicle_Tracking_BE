# API nghiệp vụ NestJS

Mặc định `http://127.0.0.1:3000`. Ngoại trừ login và health, gửi `Authorization: Bearer <access_token>`. Admin có quyền toàn bộ; User chỉ thấy dữ liệu của mình. ID không thuộc quyền trả `404`. JSON không chứa filesystem path, hash mật khẩu hoặc token lưu trong DB.

Đã đối chiếu với phạm vi bản đầu: có 21 API v2 (6 tài khoản, 4 media, 6 pipeline/job, 5 kết quả/kiểm duyệt/bằng chứng/CSV). Profile OCR thực hiện tại chỉ nhận video với 5 crop; nhận diện ảnh đơn vẫn cần adapter/checkpoint riêng. Các API ảnh đã hỗ trợ detection/crop và kiểm duyệt thủ công.

## Tài khoản

- `POST /api/v2/auth/login`: `{email,password}` → `200 {access_token,token_type,expires_at}`.
- `POST /api/v2/auth/logout`: `204`; token bị thu hồi.
- `GET /api/v2/auth/me`: tài khoản hiện tại.
- `GET /api/v2/users?limit=50&offset=0`: Admin xem tài khoản.
- `POST /api/v2/users`: Admin gửi `{email,password,display_name,role}` → `201`. Mật khẩu tối thiểu 12 ký tự.
- `PATCH /api/v2/users/{id}`: Admin gửi các trường `display_name`, `role`, `is_active`, `password` cần thay đổi. Khóa/đổi mật khẩu thu hồi phiên. Không khóa hoặc hạ quyền Admin hoạt động cuối cùng.

## Media

- `POST /api/v2/media`: multipart `file` → `201` với `media_id` (cùng giá trị `id`) và metadata. Chỉ JPG/PNG/MP4/AVI/MOV; kiểm tra giải mã thực, tối đa `PLATE_MAX_UPLOAD_MIB` (mặc định 500), ảnh tối đa 25 megapixels. File không đọc được trả `422`; môi trường kiểm tra file chưa sẵn sàng trả `503`.
- `GET /api/v2/media?limit=50&offset=0`: nguồn theo phạm vi quyền.
- `GET /api/v2/media/{id}/content`: file gốc, MIME theo nội dung đã kiểm tra. Hỗ trợ header `Range` để đọc từng phần (`206`); khoảng byte ngoài file trả `416` với JSON lỗi và `Content-Range: bytes */<size>`.
- `DELETE /api/v2/media/{id}`: `204`; `409` nếu còn job tham chiếu.

## Pipeline và job

- `GET /api/v2/pipelines`: các profile server cho phép, `task=prepare|recognize`, `media_types`, phiên bản và `ready`; không nhận đường dẫn model từ client. Profile Kaggle joint-frame chỉ nhận video; prepare nhận ảnh/video không cần OCR.
- `POST /api/v2/recognition-jobs`: `{media_id,pipeline_id,input_mode}` → `202 {job_id,status,status_url}`. `input_mode` mặc định `scene`; `plate_crop` chỉ áp dụng ảnh.
- `GET /api/v2/recognition-jobs`: lọc `media_id`, `status`, `created_from`, `created_to`, phân trang.
- `GET /api/v2/recognition-jobs/{id}`: trạng thái `queued|running|succeeded|failed`, stage, `pipeline_task`, thống kê, lỗi an toàn.
- `GET /api/v2/recognition-jobs/{id}/results`: các lần xuất hiện; `409` nếu chưa succeeded.
- `DELETE /api/v2/recognition-jobs/{id}`: xóa job kết thúc và bằng chứng phát sinh, giữ source; job chưa kết thúc trả `409`.

Tạo job mới trên cùng `media_id` để chạy lại. Mỗi job đóng băng cấu hình/checksum. `statistics` chỉ có dữ liệu quan sát, không suy ra % tiến độ hoặc accuracy. Video có `decoded_frames`, `selected_frames`, `accepted_tracks`, `rejected_tracks` và `frame_gate` (số frame ứng viên, frame chạy YOLO, frame bị bỏ vì nghi trống). Job OCR joint có thêm `vehicle_groups`: gợi ý gộp các track nhiều khả năng cùng một xe (text lệch ≤ 1 ký tự, cách ≤ 3 giây), gồm `plate_text`, `track_ids`, `variants`, `confidence`, `first_seen`, `last_seen`; không thay đổi kết quả hay trạng thái kiểm duyệt. Không phát hiện biển số vẫn succeeded với danh sách rỗng.

Job prepare có `job_kind=detect_only`; kết quả có `machine_status=not_run`, `machine_text=null`, `agreement_count=0`, predictions rỗng. Job succeeded chỉ xác nhận bằng chứng đã được xử lý/lưu. Có thể nhập biển số thủ công bằng `correct` mà không cần OCR. Job extraction v1 không truy cập qua hợp đồng prepare.

Job Kaggle joint-frame lưu `recognition_method=joint_multiframe`, `agreement_count=null`. Detail trả `predictions[]` ở cấp kết quả với `detection_ids` theo đúng thứ tự 5 input và `frame_weights` nếu có. Mỗi detection vẫn giữ crop/keyframe, nhưng không có prediction từng crop được tạo giả. `ocr_score` luôn `null` vì model không có xác suất đã hiệu chuẩn. Trường `decoding` của prediction joint gồm `decoder` (mặc định `beam_filter`), `beam_width`, `use_tta`, `plate_text`, `greedy_text`, `format_valid` (khớp `LLLDDDD`/`LLLDLDD`), `greedy_symbol_confidence`, `beam_log_score`, `beam_confidence_proxy`; các điểm này chỉ dùng xếp hạng/ưu tiên kiểm duyệt (notebook lọc ở 0.80), không phải xác suất đúng. Prediction từng crop và dữ liệu cũ có `decoding=null`. Gửi ảnh đơn vào profile này trả `422`.

## Kết quả

- `GET /api/v2/recognition-results`: query `plate`, `media_id`, `review_status`, `uploaded_from`, `uploaded_to`, phân trang. Tra cứu khớp chính xác text đã chuẩn hóa; không tự thay `O/0`. Dùng job v2 prepare/recognize succeeded mới nhất theo thời điểm tạo và ID của mỗi nguồn; job queued/failed hoặc extraction v1 không che kết quả v2 succeeded cũ.
- `GET /api/v2/recognition-results/{id}`: dự đoán tổng hợp, từng crop/prediction, URL bằng chứng và lịch sử review.
- `GET /api/v2/detections/{id}/artifacts/{kind}`: `crop|frame|enhanced`. Loại bằng chứng không tồn tại trả `404`; MIME theo file. Nhánh enhanced chỉ có khi thực sự được model/worker hỗ trợ, không sinh giả.
- `POST /api/v2/recognition-results/{id}/reviews`: `201`. Ví dụ:

```json
{"action":"correct","corrected_text":"ABC-1234","note":"Đối chiếu keyframe nguồn","expected_revision":0}
```

Action `confirm` chấp nhận text máy; `correct` bắt buộc text mới; `unreadable`/`reject` xóa text hiệu lực khỏi tra cứu theo biển số. Review không sửa machine_text hoặc OCR prediction. `expected_revision` cũ trả `409`, client tải lại trước khi sửa tiếp. Kết quả mới có `review_status=pending`; không tự duyệt theo confidence.

- `GET /api/v2/recognition-jobs/{id}/export?format=csv`: CSV UTF-8 BOM, có text máy, text hiệu lực, trạng thái và frame/timestamp. Cell có tiền tố công thức được escape để mở an toàn trong spreadsheet.

## Quy ước

List trả `{total,limit,offset,items}`. `limit=1..200`, mặc định 50; `offset>=0`. Timestamp filter dùng ISO 8601 có timezone, ví dụ `2026-10-08T00:00:00%2B07:00`. Upload time không phải capture time.

Lỗi: `401` thiếu/hết phiên, `403` thiếu vai trò, `404` không có/không thuộc quyền, `409` xung đột nghiệp vụ, `413` quá dung lượng, `415` loại file không hỗ trợ, `422` tham số/nội dung không hợp lệ, `503` pipeline chưa sẵn sàng. Body lỗi `{detail:...}`.

`GET /health` kiểm tra API còn hoạt động. `GET /health/ready` kiểm tra kết nối PostgreSQL và toàn bộ version/checksum migration; thiếu migration OCR mới trả `503`. Health không chứng minh worker đang chạy hoặc model đã load thành công. Tương tự, `pipelines.ready` kiểm tra cấu hình, file và checksum; chạy job thực kiểm chứng runtime inference.
