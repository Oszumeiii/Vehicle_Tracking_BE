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

## Nghiệm thu live CLI (YouTube Live)

Cách chạy xem [README](README.md#chạy-tay-tiến-trình-live). Cần GPU, `node` trong PATH và mạng.

1. Phát lại không bỏ frame: payload nguồn file với `realtime: false` và `--max-track-seconds 0`. Biển số, thời điểm và crop của từng track phải giống job upload cùng clip.
2. Phát lại theo nhịp thật (`realtime: true`): `frames_dropped` gần 0, `lag_seconds` dưới khoảng 1 s. Nếu bỏ nhiều frame, kiểm tra `--buffer-seconds` và GPU có đang bị tiến trình khác chiếm không.
3. Livestream thật ít nhất 60 phút: theo dõi bộ nhớ tiến trình và VRAM (không tăng dần), `lag_seconds`, `frames_dropped`, sự kiện `reconnecting`. Gửi `stop` giữa chừng: thoát mã 0, các track đang mở được chốt, không còn tiến trình `ffmpeg` (`Get-Process ffmpeg`).
4. Ca âm tính (luồng không đọc được biển): kết quả rác phải là `low_confidence`, không phải `readable`.
5. Xem crop bằng mắt các track `readable` và các cặp `duplicate_of`.

Kết quả đo ngày 2026-10-23 (RTX 4060 Laptop 8 GB, Camboriú `5Xl6pSgiy3A`, 1080p 30 fps):

| Lần chạy | Frame bỏ | Lag p95 | Track | Ghi chú |
| --- | --- | --- | --- | --- |
| Phát lại không bỏ frame, clip 3 phút | 0 | — | 19 | 19/19 track giống job upload (biển số, thời điểm, crop trùng byte) |
| Phát lại nhịp thật, clip 3 phút | 0/5400 | 0,71 s | 19 | Biển số giống bản không bỏ frame (cần warm-up model trước khi đọc luồng) |
| Live 60 phút | 635/107282 (0,6%) | 0,86 s (max 1,41 s) | 570 | 128 `readable`, 442 `low_confidence`, 43 `duplicate_of`; không reconnect, không lỗi; dừng sau 17 s, thoát mã 0 |

- Live 60 phút: working set của tiến trình giảm từ khoảng 4,3 GB xuống ổn định 0,7–0,9 GB, VRAM toàn GPU 5,8–6,5 GB, không có xu hướng tăng. Bằng chứng chiếm khoảng 2,6 GB/giờ.
- Luồng Itajaí `NwbOe1Mb__M` (ca âm tính, 5 phút): 5 track đều `low_confidence`.
- Lỗi đã biết: detector nhận nhầm biển tên đường cố định ("Avenida Atlântica") là biển số. Các track này có độ tin cậy 0,33–0,40 nên rơi vào `low_confidence`, nhưng cứ mỗi `--max-track-seconds` lại sinh thêm một track. Cần vùng nhận diện theo camera (giai đoạn sau).
- Chưa có lần rớt mạng thật trong bài 60 phút; nhánh kết nối lại mới được kiểm bằng test tự động.

## Nghiệm thu live qua API

Chạy API và worker với GPU, rồi gọi API theo [README](README.md#nhận-diện-youtube-live-thử-nghiệm):

1. Tạo camera với vùng loại trừ, bật phiên. Trạng thái phải đi qua `queued`, `starting`, `running`; `stats_at` cập nhật theo chu kỳ; `tracks_count` tăng.
2. `GET /api/v2/recognition-results?live_session_id=...` có kết quả. Tra được theo `plate`, xem được chi tiết, crop/keyframe, review được, CSV của job có `captured_from` và `confidence_status`. Người dùng khác không thấy.
3. Tạo job upload trong lúc phiên chạy: job phải nằm ở `queued` đến khi phiên dừng. Bật phiên trong lúc job upload chạy: phiên chờ đến khi job xong.
4. `POST /live-sessions/{id}/stop`: phiên thành `stopped`, track đang mở được nhập, không còn tiến trình python/ffmpeg.
5. Kill worker (`taskkill /f`): tiến trình live thoát theo; khởi động lại worker thì phiên thành `interrupted` và job upload đang chờ được chạy.

Kết quả đo ngày 2026-10-24 (RTX 4060 Laptop 8 GB, Camboriú `5Xl6pSgiy3A`, PostgreSQL tạm, vùng loại trừ phủ hai biển tên đường "Avenida Atlântica" và "Avenida Central"):

| Lần chạy | Kết quả |
| --- | --- |
| Phiên live riêng, khoảng 4 phút | Bỏ 98/6068 frame (1,6%), VRAM toàn GPU khoảng 5,6 GB. 28 track: 12 `readable` (43%), 16 `low_confidence`. Bài chạy 60 phút không có vùng loại trừ chỉ có 22% `readable`. Không còn detection nào trong vùng biển tên đường; xem crop bằng mắt thì mọi track đều là biển xe thật. |
| Phiên live cùng job upload, khi chưa có cơ chế chia GPU | VRAM 7,7–7,8/8 GB. Phiên live bỏ 46% frame rồi ngừng xử lý hẳn (không có stats trong 13 phút nhưng vẫn báo `running`). Job upload clip 3 phút mất 1129 s thay vì 124 s. Đây là lý do có `PLATE_LIVE_EXCLUSIVE_GPU` và `LIVE_STALLED`. |
| Job upload khi phiên live đang chờ (có cơ chế chia GPU) | 124 s, 19 track, giống mốc chuẩn chế độ file. Phiên chờ ở `queued` rồi tự chạy sau đó. |
| Dừng qua API | 9 s, 3 track đang mở được nhập, thoát mã 0, không còn tiến trình con. |
| Phiên đang treo vì GPU | Dừng qua API không kịp, tiến trình bị kill sau `PLATE_LIVE_STOP_SECONDS` (120 s); các track đã chốt vẫn còn. |
| Kill worker | Tiến trình live và ffmpeg thoát trong khoảng 5 s (Windows kill tiến trình con theo cha). Khởi động lại: phiên `interrupted`/`WORKER_INTERRUPTED`, 28 track đã nhập vẫn còn, job upload đang chờ được chạy ngay. |

## Nghiệm thu sự kiện real-time (SSE) và watchlist

1. Mở `curl -N -H "Authorization: Bearer $TOKEN" .../api/v2/live-events/stream` rồi bật phiên. Phải thấy `session` (`queued`, `starting`, `running`), `session` có stats theo `PLATE_LIVE_STATS_SECONDS`, rồi các event `track` có `id`.
2. Đối chiếu id nhận được với `live_session_events`: không thiếu, không trùng, kể cả khi kết nối `LISTEN` của API bị cắt (`pg_terminate_backend`).
3. Nối lại với `Last-Event-ID`: chỉ nhận event sau id đó. Stream lọc `live_session_id` gửi `end` và đóng sau khi phiên dừng.
4. Thêm biển vào `POST /api/v2/watchlist`; khi camera đọc biển giống hệt hoặc lệch 1 ký tự thì người đặt nhận event `alert`, người khác không nhận.
5. `GET /stream-sources/{id}/snapshot` trả keyframe; camera có `embed_url`.

Kết quả đo ngày 2026-10-24 (Camboriú, PostgreSQL tạm, API và worker thật):

| Kiểm tra | Kết quả |
| --- | --- |
| Stream 10 phút không lọc | 31/31 event bền vững (id 21–51) khớp DB, 0 trùng, qua một lần cắt kết nối `LISTEN` (API kết nối lại sau khoảng 1 s). 136 event `session`, 24 `track`, 30 heartbeat. |
| Độ trễ track (`captured_to` đến lúc client nhận) | Ổn định 3,5–4,2 s. Khoảng 5 phút đầu sau một lần kết nối lại YouTube thật ("No frames for 15 s"), độ trễ 15–25 s và bỏ 11% frame do luồng dồn frame về theo cụm; `captured_*` vốn chỉ xấp xỉ. |
| Nối lại bằng `Last-Event-ID: 45` rồi dừng phiên | Nhận #46–#51 rồi event mới, không trùng. Dừng mất 8 s, 2 track đang mở được đẩy, sau đó `stopped` và `end`, stream đóng. |
| Watchlist | 62 biển từ các phiên trước: 10 phút không xe nào quay lại, nên không có cảnh báo. Đặt `QUL1A7Z` và nhập lại track thật `QUL1A72` qua recovery: `alert` với `distance=1` đến client ngay sau `track`. |
| Snapshot, `embed_url` | JPEG 1920×1080; `https://www.youtube-nocookie.com/embed/5Xl6pSgiy3A`. |

## Nghiệm thu vận hành live (24/7, dọn dữ liệu, luồng, lượt xuất hiện)

Tiến trình ffmpeg của `imageio-ffmpeg` có tên `ffmpeg-win-x86_64-v7.1`; kiểm tra tiến trình sót bằng `Get-Process | Where-Object { $_.ProcessName -like 'ffmpeg*' }`, không lọc theo đúng chữ `ffmpeg`.

1. Bật `always_on` cho camera: worker tự mở phiên. Kill worker rồi khởi động lại: phiên cũ `interrupted`, phiên mới tự tạo với `reason: auto_restart`. Dừng phiên qua API: `always_on` tắt, không mở lại.
2. Đặt `keyframe_retention_hours: 0`: lượt dọn kế tiếp giữ một keyframe mỗi track, chi tiết kết quả vẫn mở được (`frame_url = null` cho keyframe đã bỏ), track đã review không bị đụng tới.
3. Tạm dừng tiến trình ffmpeg vài giây (`NtSuspendProcess`) để mô phỏng mạng kẹt: tiến trình live đuổi kịp không quá 1,3× và không bỏ frame.
4. So `captured_from` (giờ luồng) với đồng hồ in trên khung hình: độ lệch phải không đổi giữa các track.
5. `export-live-samples` xuất mẫu phân tầng; `scripts.calibrate_threshold` chạy với file nhãn của người gán nhãn độc lập.

Kết quả đo ngày 2026-10-24 (Camboriú, PostgreSQL tạm, API và worker thật):

| Kiểm tra | Kết quả |
| --- | --- |
| Bật 24/7 | Phiên tự mở sau khoảng 3 s. Kill worker: không còn ffmpeg hay python; khởi động lại thì phiên cũ `interrupted`, phiên mới `auto_restart` mở ngay. Dừng qua API mất 9 s, `always_on=false`, 30 s sau không mở lại. |
| Giờ luồng | 100% track có `capture_clock=stream`. Độ lệch so với đồng hồ trên khung hình là 3:31:25,6–3:31:26,3 qua 5 track (dưới 1 s, bằng độ phân giải của đồng hồ in trên hình; đồng hồ của camera đặt sai giờ). |
| Kẹt 12 s | Độ trễ nguồn 13,7 s giảm khoảng 0,25 s/s về 0 trong khoảng 60 s, xử lý 38–40 frame/s, **0 frame bị bỏ** trong lúc đuổi kịp. Giai đoạn 4 (trước `Pacer`) bỏ 11% frame sau một lần kết nối lại. Spike riêng: `-re` sau 15 s kẹt đổ dồn khoảng 120 frame/s (4×). |
| Dọn keyframe | 122/123 track được bỏ bớt keyframe (1 track đã review được giữ). Phiên 33 track: 172 MB xuống 35 MB (−80%); thư mục `recognition` 794 MB xuống 300 MB. |
| Lượt xuất hiện | `QIZ8714`/`AIZ8714` và `AIZ8718`/`AIE8718` gộp thành hai lượt; lượt sau nối với track `AIZ8712` của phiên trước lần kill worker. |
| Xuất mẫu nhãn | 35 mẫu, confidence trải từ 0,27 đến 0,99, mỗi mẫu có 5 crop. |

Mạng tới YouTube dao động mạnh khi đo (có lúc 2 Mbit/s, dưới mức 1080p cần khoảng 4 Mbit/s): khi đó ffmpeg tự giao chậm hơn thời gian thực và độ trễ tăng; `max_height: 720` giảm bitrate cho trường hợp này.

## Nghiệm thu sẵn sàng demo (DB thật, 2026-10-25)

Chạy `start-all.cmd -NoBrowser` trên DB Docker của dự án. Trước khi chạy, DB đã áp dụng 3/7 migration.

- **Khởi động:** script bật Docker, sao lưu `data/backups/plate-*.dump` (`pg_restore --list` đọc được 9 bảng có dữ liệu), áp dụng `0004`–`0007`, rồi mở API, worker và FE `Vehicle_Tracking_FE`. Dữ liệu cũ (2 job, 1 review, 7 media) vẫn hiện trong tab *Video đã xử lý*.
- **Camera demo** (`data/demo-videos/camboriu.mp4`, 3 phút 1080p30):
  - tạo từ form FE, phiên chạy sau 75 s (lần đầu nạp model);
  - phát lại liên tục qua nhiều vòng lặp, 20 629 frame đọc, 74 frame bỏ (0,4%);
  - watchlist một biển vừa đọc thì có toast cảnh báo khi clip lặp lại (sau khoảng 3 phút).
- **Camera YouTube** Camboriú: chạy sau 37 s, có biển số sau khoảng 20 s, dừng bình thường.
- **Job upload** (20 s, 1080p) sau khi dừng live: `succeeded` sau 40 s.
- **Sau cùng:** 0 lỗi console, 0 tiến trình `python`/`ffmpeg*` còn sót.
- **Lỗi tìm ra và đã sửa:** Vite của FE chỉ nghe `[::1]`, nên `start-all` giờ mở `http://localhost:5173` thay vì `127.0.0.1`.
- **Lưu ý:** clip ghi lúc khoảng 4h sáng ở Brazil chỉ có khoảng 1 xe/phút (một xe đỗ được đọc lặp lại). Clip demo nên ghi vào ban ngày ở Brazil (xem `docs/DEMO.md`).

## Nghiệm thu gán nhãn độc lập (2026-10-25)

Chạy API của nhánh trên một bản sao DB thật (`pg_dump` sang cụm PostgreSQL tạm, migration `0008`) cùng FE, điều khiển bằng Playwright. Nhãn gõ trong lần thử là giá trị giả, chỉ để kiểm công cụ, không phải ground truth.

- **Tạo bộ mẫu:** admin tạo bộ mẫu từ camera demo (3 mẫu mỗi khoảng). Camera có ít track nên được 6 mẫu.
- **Gán mù:** màn gán nhãn không chứa biển nào trong 5 biển máy đã đọc trên DB (0 bị lộ). API `next` chỉ trả crop, keyframe và nhãn của chính mình (test tự động kiểm tra các key trả về).
- **Thao tác:** Enter để lưu, *Không đọc được*, *Bỏ qua* và *Quay lại* (hiện nhãn cũ để sửa) đều chạy đúng. Hai người gán song song; người dùng thường không thấy tab báo cáo.
- **Báo cáo:** bảng ngưỡng, biểu đồ có tooltip, độ đồng thuận và độ chính xác theo khoảng hiện đúng. Mẫu bất đồng bị loại.
- **Đối chiếu chéo:** dữ liệu đồng thuận của test tự động cho cùng kết quả ở báo cáo TS và `scripts.calibrate_threshold`: ngưỡng đề xuất 0,88; ngưỡng 0,5 có 5 track readable, 3 đúng.
- **Mobile 390 px:** crop xếp 2 cột; 0 lỗi console.

## Nghiệm thu nhiều camera trên một GPU (2026-10-25)

RTX 4060 Laptop 8 GB, Ryzen 7 7735HS. Ứng dụng khác đã chiếm khoảng 1,3–1,9 GB VRAM.

**Đo trước khi refactor:** một tiến trình, hai `LiveRunner` dùng chung detector và OCR qua một lock. Mỗi cấu hình 3 phút; luồng YouTube Camboriú cùng camera file (`camboriu.mp4`, 1080p30).

| Cấu hình | VRAM tổng / PyTorch | GPU | Frame bỏ YouTube / file |
|---|---|---|---|
| 1 luồng 1080p | 6,59 / 1,90 GB | 21% | 0,4% |
| 2 luồng, sampling gốc | 6,58 / 1,93 GB | 35% | 0,64% / 2,75% |
| 2 luồng, sampling ×0,5 | 6,59 / 1,93 GB | 22% | 2,44% / 3,18% |
| 2 luồng, YouTube 720p, ×0,5 | 6,74 / 1,93 GB | 31% | 0,24% / 1,88% |
| 2 luồng, YouTube 720p, sampling gốc (5 phút) | 6,76 / 1,93 GB | 38% | 0,4% / 1,89% |

**Kết luận:**
- **VRAM:** dùng chung model thì hai luồng tốn VRAM như một. Con số khoảng 4,4 GB mỗi phiên trước đây phần lớn là CUDA context và bộ đệm allocator của từng tiến trình.
- **GPU không phải nút thắt**, nên giảm sampling không giảm frame bỏ. Mặc định `PLATE_LIVE_SHARED_SAMPLING_SCALE=1`, không làm giảm độ chính xác.
- **Frame bỏ còn lại** do hai luồng tranh CPU trong cùng tiến trình; đọc 720p giúp giảm.

**Chạy thật qua worker** (`PLATE_LIVE_MAX_SESSIONS=2`, DB Docker của dự án, khoảng 11h sáng giờ Brazil): camera YouTube (720p) và camera demo cùng ở chế độ 24/7.
- **30 phút**, cả hai `running` suốt trong một host:
  - YouTube: 365 track, bỏ 0,12% frame, lag p95 0,73 s;
  - demo: 20 track, bỏ 0,13%, lag p95 0,59 s;
  - VRAM tối đa 6,9 GB, GPU trung bình 31%.
- **Kill worker đột ngột:** không còn tiến trình `python`/`ffmpeg` sót. Khởi động lại thì hai phiên cũ chuyển `interrupted` (giữ nguyên 366 và 20 track), và hai phiên mới tự bật lại sau khoảng 1 phút, chung một host.
- **Dừng cả hai:** host tự thoát (0 tiến trình `python`, VRAM về 1,3 GB), GPU được nhả cho job upload.
- **Lưu ý:** khi hai phiên khởi động cùng lúc, phiên thứ hai có thể bỏ frame trong khoảng 20 s đầu (lần đo: 77/610) do chờ warm-up model của phiên kia. Đã sửa ở mục dưới.

## Nghiệm thu bỏ frame lúc khởi động (2026-10-26)

**Nguyên nhân** (đo trên RTX 4060 Laptop):
- Detector chạy fp16. Mỗi **kích thước batch mới** mất khoảng **1,8 s** ở lần gọi đầu, và chi phí này tính **riêng cho từng luồng**. Lần đo: batch 16 vừa warm-up, sau đó batch 1, 2, 3, 5, 8, 15 mỗi cái đều mất 1,8 s; ở fp32 thì chỉ 0,08 s.
- Bộ lọc cảnh trống gửi batch lẻ (1–15 frame) khi cảnh vắng. Warm-up cũ chỉ chạy batch 16.
- Trong host dùng chung, mỗi phiên gọi model từ luồng riêng và giữ khóa GPU suốt 1,8 s đó, nên **mọi phiên** cùng đứng hình quá bộ đệm 1,5 s và bỏ frame.

**Cách sửa:**
- Batch trên CUDA được đệm lên 1, 4 hoặc 16 frame (`detector_batch_sizes`), và warm-up chạy cả ba cỡ.
- Trong host, mọi lần gọi detector/OCR chạy trên **một luồng GPU** (`live-gpu`). Nhờ vậy warm-up dùng chung, và phiên sau bỏ qua warm-up nếu đã có phiên warm-up cùng kích thước frame.

**Kết quả**, hai camera file 1080p30 phát theo nhịp thật (`camboriu-day.mp4` và `camboriu.mp4`) trong một host, đo 60 s sau khi `running`:

| Kịch bản | Trước: frame bỏ (phiên 1 / phiên 2) | Sau | Thời gian đến `running` của phiên 2, trước → sau |
|---|---|---|---|
| Bật hai phiên cùng lúc | 17/1797 và 73/1772 | 0 và 0 | 27,6 s → 17,5 s |
| Phiên 2 bật sau 30 s | 34/1799 và 71/1795 | 0 và 0 | 2,8 s → 0,3 s |
| Một phiên | 0/913 | 0/1773 | 18,5 s → 14,5 s; lag p95 0,68 → 0,57 s |

**Ảnh hưởng tới job upload:** thời gian gần như không đổi (60 s clip ban ngày: 28,3 → 28,1 s; clip đêm: 30,3 → 28,3 s). Số track giữ nguyên.

**Đánh đổi:** frame đệm chỉ được tính rồi bỏ kết quả. Đổi cỡ batch làm kết quả fp16 sai khác rất nhỏ (48 frame thử: box lệch tối đa 0,75 px, 1 frame có thêm một box sát ngưỡng conf 0,10). Mức dao động này vốn đã có khi bộ lọc cảnh trống đổi cỡ batch. Live và upload vẫn dùng chung một đường code.

## Thử lấy mẫu 15/20/25 fps (2026-10-26)

**Câu hỏi:** nâng lấy mẫu detector từ 8/12/15 lên 15/20/25 frame/s có giúp bắt được nhiều biển hơn không?

**Cách đo:**
- So sánh pipeline `pbl6-resnet34c-joint5-hfps-v1` với `-v1`. Hai pipeline giống hệt nhau, chỉ khác `sampling`.
- Ngưỡng `readable` 0.96. Đo sau khi đã sửa lỗi bỏ frame lúc khởi động.
- Máy: RTX 4060 Laptop.

| Bài đo | 8/12/15 (v1) | 15/20/25 (hfps) |
|---|---|---|
| (a) Clip ban ngày 3 phút, phát không bỏ frame: track / `readable` / track bị loại vì thiếu frame | 37 / 3 / 15 | 64 / 2 / 28 |
| (a) Track có confidence ≥ 0,9 | 8 | 8 |
| (b) Camera demo nhịp thật, 1 phiên, 5 phút: track / `readable`; bỏ frame; lag p95; GPU | 68 / 7; 0%; 0,86 s; 22% | 111 / 6; 0%; 0,86 s; 54% |
| (c) Demo + YouTube Camboriú 720p trong một host, 10 phút: bỏ frame demo / YouTube | 0% / 0,07% | **12,5% / 16,6%** |
| (c) Lag p95 demo / YouTube; GPU | 1,03 / 0,89 s; 37% | 1,5 / 2,07 s; 64% |

**Kết luận: giữ 8/12/15 làm mặc định.**
- **Không bắt thêm biển đọc được:**
  - số track gần gấp đôi, nhưng số `readable` và số track có confidence ≥ 0,9 không tăng;
  - các track chỉ có ở hfps có confidence trung vị khoảng 0,47, tức phần lớn là biển ở xa hoặc quá nhỏ để đọc;
  - chúng chỉ làm tăng OCR, dung lượng bằng chứng và danh sách cần duyệt.
- **"Mất frame" của 8/12/15 là bỏ qua có chủ ý**, không làm sót xe:
  - mỗi track vẫn có đủ 5 crop ứng viên tốt;
  - frame bị bỏ thật (`frames_dropped`) với 8/12/15 hiện gần 0.
- **Hai camera với hfps thì CPU/GPU không theo kịp:** bỏ 12–17% frame, vượt xa mục tiêu dưới 1%.
- **Pipeline hfps chỉ để thử nghiệm** cho job upload hoặc một camera. Không dùng hfps cho hai camera cùng lúc: mọi phiên trong host dùng chung pipeline đầu tiên được nạp.

## Nhiều camera trên một GPU và tải CPU (2026-10-27)

**Đo trên môi trường thật** (stack khởi động lại theo `main`, migration 0009 đã áp dụng): YouTube Camboriú 720p và camera demo ban ngày chạy chung một host trong 30 phút.
- Bỏ frame: 0,04% (YouTube) và 0,07% (demo). Lag p95 khoảng 1,05 s. VRAM tối đa 6,0 GB, GPU trung bình 45%.
- **Chất lượng:** ở ngưỡng 0.96, YouTube **720p** chỉ có 2/318 track `readable`, trong khi demo 1080p có 37/373. Camera thật nên để `max_height` 1080 nếu băng thông cho phép.

**Mốc trên `main`** (5 phút mỗi cấu hình; nguồn: YouTube 720p cùng các clip demo 1080p30):

| Số camera | Frame bỏ theo từng camera | Lag p95 | GPU | VRAM |
|---|---|---|---|---|
| 2 (30 phút) | 0,04% / 0,07% | khoảng 1,05 s | 45% | 6,0 GB |
| 3 | 0,36% / 0,06% / 0,11% | 0,8–1,2 s | 54% | 5,6 GB |
| 4 | 7,9% / 7,6% / 4,0% / 30% | 1,5–2,3 s | 62% | 5,6 GB |

**Kết luận:**
- 3 camera đạt mục tiêu bỏ frame dưới 1%, nhưng lag p95 đã chạm 1,2 s. 4 camera thì không chạy kịp.
- GPU vẫn còn dư, nên nút thắt là CPU và GIL trong host Python dùng chung.

**Giảm tải CPU trong cùng PR** (mỗi frame của luồng ffmpeg):
- đọc stderr của ffmpeg qua buffer (trước đây đọc từng byte, mỗi dòng `showinfo` tốn hàng trăm lần gọi hệ thống khi đang giữ GIL);
- `showinfo=checksum=0` (bỏ checksum và thống kê cho cả frame);
- cấp phát frame bằng `np.empty` thay cho `bytearray` được điền số 0;
- camera file dùng lại ảnh xám nhỏ mà luồng giải mã đã tính.

Chưa đo lại sau các thay đổi này: lượt đo bị dừng vì máy gần hết RAM (15 GB, host đo chiếm khoảng 4 GB). Vì vậy số camera khuyến nghị vẫn là 3. `PLATE_LIVE_HWACCEL=cuda` và `PLATE_LIVE_FFMPEG_THREADS` được thêm làm tùy chọn, mặc định không đổi.

## Job upload chạy cùng camera live (2026-10-27)

**Cách chạy:** job đi vào host live dùng chung (lệnh `job`), dùng model host đã nạp.
- Trước đây job phải chờ đến khi mọi camera tắt; với camera 24/7 thì chờ mãi.
- Mỗi job tiến trình riêng còn tốn khoảng 18 s đầu chỉ để nạp torch và model.

**Đo:** hai camera (demo 1080p và YouTube Camboriú 720p) chạy trong host; sau 60 s gửi job video đêm 3 phút (`camboriu.mp4`). Số đo tính trong lúc job chạy.

| Cách chạy job | Thời gian job | Frame bỏ demo / YouTube | Lag p95 |
|---|---|---|---|
| Hết tốc độ | 166 s | 2,30% / 0,04% | 1,31 s |
| Hết tốc độ, live được ưu tiên trên luồng GPU | 181 s | 1,51% / 5,42% | 1,48 s |
| **Thời gian thực khi có camera** (mặc định) | 195 s | **0% / 0,88%** | 1,10 s |

- Job cho kết quả đúng (2 track, như khi chạy riêng).
- **Nút thắt là CPU/GIL:** job giải mã và tracking hết tốc độ trong cùng tiến trình. Ưu tiên trên GPU không đủ, nên job được giữ ở tốc độ thời gian thực khi có camera (`RealTime` trong `app/live/host.py`).
- Vẫn giữ ưu tiên live trên luồng GPU: mỗi batch của job khoảng 0,5 s không được chen trước camera.

## Nghiệm thu camera IP/RTSP (2026-10-27)

**Môi trường thử:** camera giả lập bằng mediamtx 1.21.3. ffmpeg đẩy clip demo 1080p30 lên `rtsp://127.0.0.1:8554/cam`; quyền đọc cần `admin` + mật khẩu. Phiên chạy trong host live, `max_height` 720.

| Bước | Kết quả |
|---|---|
| Sai mật khẩu | Sau 2,6 s phiên `ended`: "Camera refused the stream: … 401 Unauthorized"; không thử lại mãi |
| Đúng mật khẩu | `running` ở 1280×720, 30 fps; 9–11 track trong 60 s; 0 frame bỏ |
| Tắt camera 20 s | Phiên `reconnecting` ("Camera did not answer"), rồi 404 khi luồng chưa đẩy lại, vẫn thử lại |
| Bật camera lại | `running` lại sau 2,4 s; 19 track trong 75 s tiếp theo |
| Tìm mật khẩu trong mọi file sự kiện/log của phiên (trừ `payload.json`) | Không có |

**Ghi chú:**
- Lần chạy đầu coi 404 là lỗi vĩnh viễn nên phiên dừng khi camera vừa khởi động lại; đã sửa để chỉ 401/403 mới dừng hẳn.
- Ngay sau khi vào luồng, ffmpeg đôi khi thoát (mã 0, lỗi giải mã khi bắt đầu giữa GOP); phiên tự nối lại trong khoảng 1 s.
- Chưa thử với camera IP thật của nhóm.

## Ghi đệm liên tục và video của kết quả (2026-10-27)

**Cách ghi:** ffmpeg thêm một output stream copy thành đoạn MP4 10 s. Đoạn MPEG-TS ban đầu không seek chính xác được, nên đã đổi sang MP4.

**Index:** mỗi đoạn có PTS, giờ UTC (cùng cách tính giờ với track) và danh sách keyframe. Clip cắt bằng `inpoint`/`outpoint` của concat demuxer, bắt đầu tại keyframe ngay trước mốc cần xem. Không dùng `-ss` phía output vì với B-frame nó bỏ mất keyframe cần bắt đầu.

**Đo:** hai camera (demo 1080p và YouTube Camboriú 720p) trong một host, bật ghi, 5 phút, RTX 4060 Laptop.

| Chỉ số | Kết quả |
|---|---|
| Frame bỏ | 0 / 0 (2 camera không ghi trong 30 phút trước đó: 0,04–0,07%) |
| Lag p95 | 1,0–1,1 s |
| GPU / VRAM | 55% / 6,2 GB |
| Dung lượng bản ghi YouTube 720p | 65 MB / 5 phút, khoảng 0,8 GB/giờ |
| Clip của camera demo | 7/7 track `readable` có clip, 0,2–7,5 s sau khi có track; khoảng 7 MB/clip (GOP 5 s) |
| Cắt theo yêu cầu từ bản ghi YouTube | 0,5 s cho clip 10,3 s (2,2 MB, 1280×720) |
| Đúng thời điểm | Khung hình tại `first_seen_offset` trong clip trùng box của track: biển số nằm đúng trong khung |

**Lỗi tìm ra khi đo:** với HLS, ffmpeg liệt kê đoạn đầu tiên từ PTS 0 thay vì PTS thật của luồng, nên giờ UTC của đoạn đó bị lùi gần 3 giờ. Recorder giờ lấy keyframe đầu của đoạn làm mốc bắt đầu; đã có test.

Không có lượt đo tắt ghi cùng lúc vì máy chỉ còn khoảng 3,6 GB RAM trống. Số so sánh lấy từ lần đo 30 phút trước đó.

## Chọn crop và thử nghiệm OCR (2026-10-28)

**Vấn đề:** ảnh ghép crop của phiên Camboriú 1080p cho thấy biển được cắt đủ (viền đệm 15%), nhưng cách chọn 5 crop mỗi track có lỗi:
- crop **bị cột đèn che** vẫn được chọn vì to và nét;
- crop xa, nhỏ luôn bị kéo vào vì chọn trải đều theo thời gian.

Model đọc 5 crop cùng lúc, nên một crop hỏng kéo confidence của cả biển xuống.

**Cách chọn mới (`robust`, mặc định), trong `select_five` của `app/recognition/video_tracking.py`:**
- **Loại lần thấy có biển bị che hoặc cụt** (`hidden_or_cut`):
  - box hẹp hơn 0,8 lần lần thấy liền trước hoặc liền sau;
  - tỷ lệ rộng/cao dưới 0,75 lần trung vị của track;
  - box chạm mép khung hình.
  - Nếu không còn đủ 5 thì lấy lại lần tốt nhất trong số đã loại, nên không mất track nào.
- **Ưu tiên crop lớn:** trọng số kích thước 0,40, nhóm ứng viên 40% tốt nhất; vẫn trải 5 crop theo thời gian trong nhóm đó.
- Cách cũ vẫn chọn được qua `crop_selection: "current"` (dùng cho công cụ đo).

**Đo A/B** bằng `python -m scripts.eval_crops`: cùng track, chọn crop theo hai cách, cùng recognizer, ngưỡng 0.96.

| Video | Track | `readable` cũ → mới | Confidence trung vị | Track còn dính crop bị che/cụt |
|---|---|---|---|---|
| Bản ghi Camboriú YouTube 1080p, 7,7 phút | 57 | **4 → 8** | 0,70 → 0,74 | 22 → 14 |
| Demo ban ngày `camboriu-day.mp4` | 36 | 3 → 4 | 0,590 → 0,598 | 20 → 7 |
| Demo ban đêm `camboriu.mp4` | 2 | 0 → 0 | 0,52 → 0,49 | 1 → 1 |

**Soát bằng mắt** 5 track mới thành `readable` (không có nhãn thật, nên đây là đánh giá định tính):
- 3 track đúng hoặc hợp lý:
  - AN05G35: bỏ được crop bị cột che, confidence 0,95 → 0,99;
  - SET2J25: cách cũ đọc sai thành SEI2J25;
  - BEL4F82.
- 1 track giữ nguyên chữ ở cả hai cách.
- **1 track đọc sai:** RLH7H61 thành RLM7H61 ở 0,98. Cách cũ đọc đúng nhưng chỉ đạt `low_confidence`, vì crop bị che kéo điểm xuống. Lỗi nằm ở model (nhầm H/M trên crop sạch), không ở bước chọn.
- **Precision của `readable` trên camera thật vẫn chưa đo được.** Cần nhãn người (tab Gán nhãn, mỗi mẫu ít nhất 2 người).

**Thử nghiệm OCR trên ICPR** (`scripts/calibrate_icpr.py --tta` / `--frames N`), ngưỡng 0.96:

| Lượt | Độ đúng toàn biển | Precision (cận dưới 95%) | Coverage | OCR mỗi track |
|---|---|---|---|---|
| Hiện tại, test | 77,1% | 96,9% (96,1%) | 68,5% | khoảng 48 ms |
| TTA, test | 77,3% | 97,2% (96,4%) | 67,7% | khoảng 148 ms |
| 4 frame (lặp crop nét nhất), test | 74,6% | 95,6% (94,6%) | 66,7% | — |
| 3 frame, test | 70,4% | 93,8% (92,6%) | 63,1% | — |
| Hiện tại, validation | 78,0% | 95,7% (94,0%) | 70,1% | — |
| TTA, validation | 78,1% | 96,4% (94,7%) | 69,0% | — |

**Kết luận:**
- **TTA giữ tắt:** chỉ thêm 0,2–0,7 điểm %, mà OCR chậm khoảng 3 lần.
- **Track ngắn** (hiện bị loại: 29% ở live, 42% ở upload): 4 frame vẫn đạt precision khoảng 95% ở ngưỡng 0.96–0.97; 3 frame cần ngưỡng 0.97–0.98. Có thể đọc thay vì loại, nhưng phía Node và DB đang bắt buộc đúng 5 frame khác nhau, nên đây là thay đổi riêng, chưa làm.
- ICPR không qua bước chọn crop (mỗi track đúng 5 frame), nên bảng ICPR của ngưỡng 0.96 không đổi.

**Camera thật sau khi áp dụng** (Camboriú YouTube 1080p, ban ngày Brazil, cùng camera, khác giờ nên lượng xe khác):

| Phiên | Thời gian | Track | `readable` | Confidence trung vị | Frame bỏ |
|---|---|---|---|---|---|
| Cách chọn cũ (27/10, 13:06 giờ Brazil) | 7,8 phút | 60 | 4 (6,7%) | 0,692 | 4/13.936 |
| Cách chọn mới (27/10, 15:16 giờ Brazil) | 10,3 phút | 115 | **14 (12,2%)** | **0,777** | 16/18.422 |

**Soát bằng mắt 14 track `readable` sau thay đổi:**
- 12 khớp với biển nhìn thấy trên crop.
- 1 có vẻ đọc sai: `QIW5655`, crop giống `QIW5665`.
- 1 khó phân định (I/J).

Precision trên camera thật ước khoảng 86–93%, thấp hơn 96,9% trên ICPR như đã dự báo (ICPR là cận trên). Cần nhãn người để đo chính xác và chỉnh lại ngưỡng cho camera.

