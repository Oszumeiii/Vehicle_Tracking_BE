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
- `GET /api/v2/recognition-jobs`: lọc `origin` (`upload` mặc định, `live`, `all`), `media_id`, `live_session_id`, `status`, `created_from`, `created_to`, phân trang.
- `GET /api/v2/recognition-jobs/{id}`: trạng thái `queued|running|succeeded|failed`, stage, `pipeline_task`, thống kê, lỗi an toàn.
- `GET /api/v2/recognition-jobs/{id}/results`: các lần xuất hiện; `409` nếu chưa succeeded.
- `DELETE /api/v2/recognition-jobs/{id}`: xóa job kết thúc và bằng chứng phát sinh, giữ source; job chưa kết thúc trả `409`.

Tạo job mới trên cùng `media_id` để chạy lại. Mỗi job đóng băng cấu hình/checksum. `statistics` chỉ có dữ liệu quan sát, không suy ra % tiến độ hoặc accuracy. Video có `decoded_frames`, `selected_frames`, `accepted_tracks`, `rejected_tracks` và `frame_gate` (số frame ứng viên, frame chạy YOLO, frame bị bỏ vì nghi trống). Job OCR joint có thêm `vehicle_groups`: gợi ý gộp các track nhiều khả năng cùng một xe (text lệch ≤ 1 ký tự, cách ≤ 3 giây), gồm `plate_text`, `track_ids`, `variants`, `confidence`, `first_seen`, `last_seen`; không thay đổi kết quả hay trạng thái kiểm duyệt. Không phát hiện biển số vẫn succeeded với danh sách rỗng.

Job prepare có `job_kind=detect_only`; kết quả có `machine_status=not_run`, `machine_text=null`, `agreement_count=0`, predictions rỗng. Job succeeded chỉ xác nhận bằng chứng đã được xử lý/lưu. Có thể nhập biển số thủ công bằng `correct` mà không cần OCR. Job extraction v1 không truy cập qua hợp đồng prepare.

Job Kaggle joint-frame lưu `recognition_method=joint_multiframe`, `agreement_count=null`. Detail trả `predictions[]` ở cấp kết quả với `detection_ids` theo đúng thứ tự 5 input và `frame_weights` nếu có. Mỗi detection vẫn giữ crop/keyframe, nhưng không có prediction từng crop được tạo giả. `ocr_score` luôn `null` vì model không có xác suất đã hiệu chuẩn. Trường `decoding` của prediction joint gồm `decoder` (mặc định `beam_filter`), `beam_width`, `use_tta`, `plate_text`, `greedy_text`, `format_valid` (khớp `LLLDDDD`/`LLLDLDD`), `greedy_symbol_confidence`, `beam_log_score`, `beam_confidence_proxy`; các điểm này chỉ dùng xếp hạng/ưu tiên kiểm duyệt (notebook lọc ở 0.80), không phải xác suất đúng. Prediction từng crop và dữ liệu cũ có `decoding=null`. Gửi ảnh đơn vào profile này trả `422`.

## Kết quả

- `GET /api/v2/recognition-results`: query `plate`, `origin` (`upload`/`live`), `media_id`, `stream_source_id`, `live_session_id`, `review_status`, `confidence_status`, `exclude_duplicates`, `uploaded_from`, `uploaded_to`, `captured_from`, `captured_to`, phân trang.
  - Tra cứu khớp chính xác text đã chuẩn hóa; không tự thay `O/0`.
  - Với video/ảnh upload: dùng job v2 prepare/recognize succeeded mới nhất theo thời điểm tạo và ID của mỗi nguồn; job queued/failed hoặc extraction v1 không che kết quả v2 succeeded cũ.
  - Với live: mọi track đều được tính.
  - Kết quả có `origin`, `captured_from/to`, `confidence_status`, `duplicate_of_job_id`, `sighting_id`; sắp xếp theo giờ chụp (live) hoặc giờ upload.
  - `group_by=sighting`: mỗi lượt xuất hiện một dòng (ưu tiên track đã review, rồi track có confidence cao nhất), kèm `sighting_count`, `first_seen`, `last_seen`. Kết quả upload không gộp.
- `GET /api/v2/sightings/{id}/results`: các track của một lượt xuất hiện, theo thời gian.
- `GET /api/v2/recognition-results/{id}`: dự đoán tổng hợp, từng crop/prediction, URL bằng chứng và lịch sử review.
- `GET /api/v2/detections/{id}/artifacts/{kind}`: `crop|frame|enhanced`. Loại bằng chứng không tồn tại trả `404`; MIME theo file. Nhánh enhanced chỉ có khi thực sự được model/worker hỗ trợ, không sinh giả.
- `POST /api/v2/recognition-results/{id}/reviews`: `201`. Ví dụ:

```json
{"action":"correct","corrected_text":"ABC-1234","note":"Đối chiếu keyframe nguồn","expected_revision":0}
```

Action `confirm` chấp nhận text máy; `correct` bắt buộc text mới; `unreadable`/`reject` xóa text hiệu lực khỏi tra cứu theo biển số. Review không sửa machine_text hoặc OCR prediction. `expected_revision` cũ trả `409`, client tải lại trước khi sửa tiếp. Kết quả mới có `review_status=pending`; không tự duyệt theo confidence.

- `GET /api/v2/recognition-jobs/{id}/export?format=csv`: CSV UTF-8 BOM, có text máy, text hiệu lực, trạng thái và frame/timestamp. Cell có tiền tố công thức được escape để mở an toàn trong spreadsheet.

## Live (YouTube)

- `POST /api/v2/stream-sources`: `{name,url,exclude_zones?}` → `201`.
  - `url` phải là link YouTube.
  - **Camera IP** (owner hoặc admin): `{name,source_type:"rtsp",url,exclude_zones?}`, với `url` là `rtsp://` hoặc `rtsps://`, có thể kèm `user:mật-khẩu@`. Mọi response đều trả `url` đã che mật khẩu (`rtsp://user:***@host/...`); sự kiện và `error_message` cũng được che. Camera không có `embed_url`; xem bằng snapshot.
  - **Camera demo** (chỉ admin): `{name,source_type:"file",path,exclude_zones?}`. `path` là file video (`.mp4`, `.mov`, `.mkv`, `.avi`, `.webm`) nằm trong `PLATE_DATA_DIR/demo-videos/`; đường dẫn ra ngoài thư mục đó hoặc file không tồn tại trả `422`, user thường trả `403`. Phiên phát lại video theo vòng lặp với tốc độ thật; camera không có `embed_url`.
  - `exclude_zones` gồm tối đa 16 hình chữ nhật `[x1,y1,x2,y2]` chuẩn hóa 0..1; detection có tâm nằm trong vùng bị bỏ.
- `GET /api/v2/demo-videos` (admin): `{items:[{path,size_bytes}]}`, các video dùng được cho camera demo.
- `GET /api/v2/stream-sources`, `GET /api/v2/stream-sources/{id}`: camera của mình (admin thấy tất cả), kèm `active_session`.
- **Video của kết quả:**
  - `GET /api/v2/recognition-results/{id}/video-info` → `{available, kind, url, first_seen_offset, captured_from, captured_to}`. `kind`:
    - `clip`: clip lưu cùng track;
    - `recording`: cắt từ bản ghi đệm của camera, còn trong `PLATE_LIVE_RECORD_MINUTES`;
    - `media`: video upload, `url` là `/media/{id}/content`;
    - `demo`: track của camera demo; cắt từ video demo khi mở lần đầu (vài giây), sau đó lấy từ cache;
    - `none`: không còn video.
  - `GET /api/v2/recognition-results/{id}/video` → `video/mp4` (hỗ trợ Range). Header `X-Plate-First-Seen-Seconds` cho biết giây biển xuất hiện trong video. Hết thời gian giữ thì `404`. Nhận cả `?token=` để dùng trực tiếp trong `<video src>`.
- **Bản ghi camera:**
  - `GET /api/v2/stream-sources/{id}/recording/coverage` → `{items:[{from,to}]}`, các khoảng còn bản ghi.
  - `GET /api/v2/stream-sources/{id}/recording?from=ISO&to=ISO` (tối đa 600 s) → `video/mp4`. Sai khoảng thời gian trả `400`, không còn bản ghi trả `404`.
- `PATCH /api/v2/stream-sources/{id}`: `url` (chỉ camera RTSP, để đổi mật khẩu; loại khác trả `422`), `name`, `exclude_zones`, `always_on`, `auto_settings` (`{pipeline_id, min_confidence?, max_track_seconds?, max_height?}`; `always_on` cần `pipeline_id` của profile joint), `keyframe_retention_hours`, `track_retention_days` (`null` là giữ mãi). Áp dụng từ phiên kế tiếp.
- `DELETE /api/v2/stream-sources/{id}`: `204`; camera đã có phiên trả `409`.
- `POST /api/v2/stream-sources/{id}/sessions`: `{pipeline_id,min_confidence?,max_track_seconds?,max_height?}` → `202`, phiên `queued`. `min_confidence` mặc định 0.96 (hiệu chỉnh trên ICPR, xem [EVALUATION.md](EVALUATION.md#kết-quả-hiệu-chỉnh-offline-trên-icpr-26102026)). `max_height` là 480, 720 hoặc 1080 (mặc định).
  - Chỉ profile `five_frame_joint`, nếu không thì trả `422`.
  - Camera đang có phiên hoạt động trả `409`; pipeline chưa sẵn sàng trả `503`.
- `GET /api/v2/live-sessions`: lọc `stream_source_id`, `status`, phân trang.
- `GET /api/v2/live-sessions/{id}`: `status`, `settings`, `stats`, `stats_at`, `tracks_count`, `error_code`, `results_url`.
  - Trạng thái: `queued`, `starting`, `running`, `reconnecting`, `stopping`, `stopped`, `ended`, `failed`, `interrupted`.
- `DELETE /api/v2/live-sessions/{id}`: `204`, xóa phiên đã kết thúc cùng track, bằng chứng và lịch sử; phiên đang hoạt động trả `409`.
- `POST /api/v2/live-sessions/{id}/stop`: `202`. Dừng phiên cũng tắt `always_on` của camera.
  - Phiên `queued` dừng ngay; phiên đang chạy chốt và OCR các track đang mở rồi chuyển `stopped`.
  - Phiên đã kết thúc trả `409`.
- `GET /api/v2/live-sessions/{id}/events`: lịch sử bền vững theo `id` tăng dần (`status`, `error`, `track_rejected`, `track`, `alert`).
- `GET /api/v2/stream-sources/{id}/snapshot`: keyframe mới nhất của camera (JPEG), để vẽ `exclude_zones` theo tọa độ chuẩn hóa trên khung hình thật. Camera chưa có track trả `404`.
- Camera trả về có thêm `video_id` và `embed_url` (`https://www.youtube-nocookie.com/embed/{id}`) để nhúng trình phát cạnh danh sách biển số. Trình phát chạy lệch nhận diện vài giây. Link kênh (`/@x/live`) có `embed_url=null`.

### Sự kiện real-time (SSE)

`GET /api/v2/live-events/stream` trả `text/event-stream`. Query:
- `live_session_id` hoặc `stream_source_id` để lọc; không lọc thì nhận mọi phiên mình xem được (admin xem tất cả);
- `after` để phát lại sự kiện sau id đó (`after=0` là từ đầu). Header `Last-Event-ID` được ưu tiên hơn `after`.

Không có con trỏ thì stream bắt đầu từ thời điểm kết nối.

Các loại sự kiện:
- **Sự kiện bền vững** (có `id:`): `status`, `error`, `track_rejected`, `track`, `alert`. `data` có dạng `{live_session_id, stream_source_id, created_at, payload}`.
  - `track`: payload gồm `job_id`, `result_id`, `track`, `text`, `confidence_status`, `confidence`, `captured_from/to`, `duplicate_of_job_id` và `detection_ids` (5 id; crop tải ở `/detections/{id}/artifacts/crop`).
  - `alert`: biển đọc được khớp watchlist (giống hệt, hoặc lệch 1 ký tự khi biển dài ít nhất 5 ký tự). Payload gồm `watch_plate`, `plate`, `distance`, `job_id`, `result_id`, `stream_source_id`, `confidence_status`, `captured_from`. Chỉ người đặt watchlist nhận được, kể cả khi người đó là admin.
- **`session`** (không có id): dạng `GET /live-sessions/{id}`, gửi khi kết nối (các phiên đang hoạt động, hoặc phiên được lọc) và mỗi khi phiên đổi trạng thái hoặc stats.
- **`end`**: stream lọc theo `live_session_id` gửi `end` rồi đóng sau trạng thái kết thúc của phiên.

Dòng `: ping` là heartbeat (mỗi `PLATE_SSE_HEARTBEAT_SECONDS`, mặc định 20 s). Mỗi tiến trình API mở tối đa `PLATE_SSE_MAX_CLIENTS` stream (mặc định 100); vượt thì trả `503`.

Xác thực bằng header Bearer như mọi endpoint. `EventSource` của trình duyệt không gửi được header, nên đọc stream bằng `fetch`. Mất kết nối thì nối lại với `Last-Event-ID` (id cuối cùng đã nhận) để không thiếu sự kiện:

```bash
curl -N -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:3000/api/v2/live-events/stream?live_session_id=$SESSION"
```

```js
const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, ...(lastId && { 'Last-Event-ID': lastId }) } })
const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
let buffer = ''
for (;;) {
  const { value, done } = await reader.read()
  if (done) break // reconnect after `retry` ms unless an `end` event arrived
  buffer += value
  let cut
  while ((cut = buffer.indexOf('\n\n')) >= 0) {
    const block = buffer.slice(0, cut); buffer = buffer.slice(cut + 2)
    const field = (name) => block.split('\n').find((l) => l.startsWith(name + ': '))?.slice(name.length + 2)
    if (field('id')) lastId = field('id')
    if (field('event')) handle(field('event'), JSON.parse(field('data')))
  }
}
```

### Watchlist

- `GET /api/v2/watchlist`: biển đang theo dõi của mình, phân trang.
- `POST /api/v2/watchlist`: `{plate, note?}` trả `201`; biển được chuẩn hóa (chữ hoa, bỏ khoảng trắng và gạch); trùng trả `409`.
- `DELETE /api/v2/watchlist/{id}`: `204`; mục của người khác trả `404`.

Mỗi track live vừa nhập được đối chiếu với watchlist của chủ camera và của admin. Mỗi mục khớp tạo một sự kiện `alert`. Không quét lại lịch sử khi thêm mục mới; muốn tìm lịch sử thì dùng `GET /recognition-results?plate=`.

Mỗi track đã chốt là một job `succeeded` có `live_session_id`, `live_track_key`, `captured_from/to` (giờ nhận frame, xấp xỉ), `confidence_status` và `duplicate_of_job_id`. Hai trường cuối chỉ để tham khảo. Review, bằng chứng, CSV và xóa job dùng API chung ở trên.

## Gán nhãn độc lập (hiệu chỉnh ngưỡng)

Nhãn tách khỏi review; người gán không thấy kết quả máy. Xem [EVALUATION.md](EVALUATION.md#hiệu-chỉnh-ngưỡng-tin-cậy-live).

- `POST /api/v2/evaluation-sets` (admin): `{name, stream_source_id | live_session_id, per_bin?, min_crop_width?}` → `201`. Lấy ngẫu nhiên tối đa `per_bin` (1–200, mặc định 30) track live có confidence ở mỗi khoảng 0, 0.5, 0.7, 0.8, 0.85, 0.9, 0.95. `min_crop_width` (px) chỉ lấy track có chiều rộng crop trung vị từ giá trị này trở lên, để người gán không phải xem biển quá nhỏ (camera Camboriú: dưới 51 px không đọc được). Camera chưa có track (hoặc không track nào đủ rộng) trả `422`.
- `GET /api/v2/evaluation-sets`, `GET /api/v2/evaluation-sets/{id}` (mọi người dùng): `items`, `labelled_items`, `labelers`, `my_labels`.
- `DELETE /api/v2/evaluation-sets/{id}` (admin): `204`; xóa nhãn, giữ track.
- `GET /api/v2/evaluation-sets/{id}/next?exclude=ID,ID`: `{remaining, item}`. `item` là mẫu kế tiếp mình chưa gán (thứ tự ổn định, riêng cho từng người), hoặc `null` khi hết. `exclude` là các mẫu đã bỏ qua.
  - Mỗi item gồm `{id, set_id, crop_urls[5], frame_url, my_label}`, **không** có biển máy đọc, confidence hay trạng thái review.
- `GET /api/v2/evaluation-sets/{id}/items/{item}`: một mẫu cùng nhãn của mình (để sửa).
- `PUT /api/v2/evaluation-sets/{id}/items/{item}/label`: `{plate_text}`, chuẩn hóa thành 2–16 chữ/số; `null` nghĩa là người cũng không đọc được. Gọi lại thì ghi đè nhãn của chính mình.
- `GET /api/v2/evaluation-sets/{id}/items/{item}/artifacts/{order}/{crop|frame}`: ảnh bằng chứng của mẫu.
- `GET /api/v2/evaluation-sets/{id}/report?target=0.95&min_labels=1` (admin): `samples`, `disagreements`, `agreement`, `exact_match`, `recommended_threshold`, `thresholds[{threshold, readable, correct, precision, coverage}]`, `bins[{from, to, samples, exact_match}]`.
  - `format=files` trả `predictions` và `ground_truth` cho `scripts.calibrate_threshold`.

## Quy ước

List trả `{total,limit,offset,items}`. `limit=1..200`, mặc định 50; `offset>=0`. Timestamp filter dùng ISO 8601 có timezone, ví dụ `2026-10-08T00:00:00%2B07:00`. Upload time không phải capture time.

Lỗi: `401` thiếu/hết phiên, `403` thiếu vai trò, `404` không có/không thuộc quyền, `409` xung đột nghiệp vụ, `413` quá dung lượng, `415` loại file không hỗ trợ, `422` tham số/nội dung không hợp lệ, `503` pipeline chưa sẵn sàng. Body lỗi `{detail:...}`.

`GET /health` kiểm tra API còn hoạt động. `GET /health/ready` kiểm tra kết nối PostgreSQL và toàn bộ version/checksum migration; thiếu migration OCR mới trả `503`. Health không chứng minh worker đang chạy hoặc model đã load thành công. Tương tự, `pipelines.ready` kiểm tra cấu hình, file và checksum; chạy job thực kiểm chứng runtime inference.

## FinalV1 integration

- Result search accepts `match=exact|contains`; the default remains `exact`. Partial matching uses the reviewed effective plate text, so rejected plates do not reappear through machine predictions.
- Job and result responses include upload media metadata (`media_type`, `media_duration_seconds`, `media_original_name`). Live sources have null upload metadata. Result summaries also expose the primary detection ID and bounding boxes for evidence previews.
- Browser media elements may send `?token=<access_token>` only on GET/HEAD requests to `/api/v2/media/{id}/content` and `/api/v2/detections/{id}/artifacts/{crop|frame|enhanced}`. Session expiry and ownership checks still apply. An Authorization header takes precedence; other endpoints require the header.
