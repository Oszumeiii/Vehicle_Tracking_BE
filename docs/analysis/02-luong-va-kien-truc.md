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

Tra cứu cũng bao gồm kết quả live: mỗi track live là một job, nên mọi track đều được tính (không áp quy tắc "lượt mới nhất" của media). Bộ lọc `origin`, camera, phiên, giờ chụp, mức tin cậy; `group_by=sighting` gộp các track cùng biển trên một camera trong vài phút thành một dòng.

### 7.5 Nhận diện trên camera YouTube Live

Người dùng tạo camera (URL YouTube Live, vùng loại trừ) rồi bật phiên, hoặc bật chế độ 24/7 để worker tự mở phiên. Worker chỉ nhận phiên khi GPU rảnh (job upload và live không chạy cùng lúc trên GPU 8 GB), rồi chạy tiến trình `python -m app.live`:
- `yt-dlp` lấy URL HLS; ffmpeg giải mã với `-re` (nhịp thật) và `-copyts` (giữ timestamp gốc của segment);
- `Pacer` giới hạn tốc độ đuổi kịp sau khi kẹt mạng ở 1,3×, để buffer không phải bỏ frame giữa track;
- `TrackSession` dùng chung lõi với video upload: adaptive sampling, empty-scene gate, YOLO11l (bỏ detection trong vùng loại trừ), BoT-SORT; track quá `max_track_seconds` được chốt (xe đỗ/chờ đèn);
- mỗi track đủ 5 frame được ghi crop/keyframe, OCR joint 5 frame, gắn giờ của luồng theo `#EXT-X-PROGRAM-DATE-TIME` (hoặc giờ nhận frame) và phân loại `readable`/`low_confidence`/`unreadable` theo ngưỡng.

![Từ frame live đến kết quả và cảnh báo](diagrams/19-activity-live-track.png)

Worker nhận từng track qua stdout, chuyển thư mục bằng chứng sang `recognition/{job}`, kiểm tra bằng chứng như kết quả upload rồi ghi trong một transaction: job `succeeded`, appearance, sự kiện `track` và sự kiện `alert` nếu biển khớp watchlist. Track được gán `sighting_id` khi cùng biển (hoặc lệch một ký tự) với một track gần đây trên cùng camera. Trigger PostgreSQL gửi NOTIFY khi commit; API đẩy sự kiện tới client qua SSE.

Định kỳ, worker dọn bằng chứng theo cấu hình camera: sau một số giờ mỗi track chỉ giữ một keyframe (crop luôn còn), sau một số ngày track bị xóa; track đã kiểm duyệt, có cảnh báo hoặc nằm trong bộ mẫu gán nhãn được giữ.

**Nhiều camera.** Khi `PLATE_LIVE_MAX_SESSIONS` lớn hơn 1, worker không chạy mỗi phiên một tiến trình mà gửi lệnh `start`/`stop` (JSON) tới một host `python -m app.live --host`. Host nạp detector và OCR một lần; mỗi phiên là một `LiveRunner` trên thread riêng. Mọi lời gọi model chạy lần lượt trên một luồng GPU duy nhất, còn giải mã, tracking và ghi bằng chứng chạy song song. Job upload video dùng pipeline joint cũng chạy trong host này (lệnh `job`), dùng chung model, được giữ ở tốc độ thời gian thực khi có camera để không làm camera bỏ frame; lời gọi model của camera được ưu tiên trước batch của job. Host còn chạy thêm `PLATE_LIVE_HOST_IDLE_SECONDS` (mặc định 300 s) sau thành viên cuối nên phiên/job kế tiếp không phải nạp lại model. Lý do của luồng GPU duy nhất: detector fp16 mất khoảng 1,8 s mỗi khi gặp cỡ batch mới, tính riêng cho từng luồng. Vì vậy batch được đệm về 1, 4 hoặc 16 frame và warm-up một lần cho cả host; phiên sau dùng lại warm-up đó. Event của host mang `session` và được tách lại cho từng phiên, nên phần quản lý trạng thái phiên không đổi. Host bật cùng phiên đầu tiên và thoát sau phiên cuối để nhả GPU cho job upload.

**Ghi đệm và video.** Với camera YouTube/RTSP, ffmpeg ghi thêm một output stream copy thành đoạn MP4 10 s (không mã hóa lại); một thread lập `index.jsonl` (PTS, giờ UTC theo cùng cách tính giờ của track, keyframe) và xóa đoạn quá hạn. Track `readable` hoặc có cảnh báo được cắt clip ±3 s ngay khi bản ghi phủ hết track (thường vài giây) và lưu cùng bằng chứng của job; track khác được API cắt theo yêu cầu khi người dùng mở video. Cắt dùng `inpoint/outpoint` của concat demuxer, bắt đầu tại keyframe gần nhất trước mốc và báo giây biển xuất hiện. Camera demo cắt thẳng từ file nguồn.

**Camera IP (RTSP).** Tiến trình live mở một kết nối RTSP duy nhất bằng ffmpeg qua TCP (nhiều camera chỉ nhận một client), đọc kích thước frame từ header luồng sau khi thu nhỏ theo `max_height`, dùng giờ nhận frame làm thời gian. Sai mật khẩu (401/403) kết thúc phiên; mất kết nối hoặc 404 khi camera khởi động lại thì kết nối lại. URL có thể chứa mật khẩu nên API, sự kiện và `error_message` đều che thành `***`; chỉ `payload.json` trong thư mục dữ liệu giữ URL đầy đủ.

**Camera demo.** Admin có thể tạo camera nguồn `file` trỏ tới video trong `demo-videos`. Tiến trình live đọc file bằng OpenCV theo nhịp thật và lặp lại khi hết, PTS tăng liên tục qua các vòng; phần còn lại của luồng giống camera YouTube.

### 7.6 Gán nhãn độc lập và hiệu chỉnh ngưỡng

Admin tạo bộ mẫu từ một camera hoặc phiên: hệ thống lấy ngẫu nhiên tối đa N track có confidence ở mỗi khoảng 0–0,5, 0,5–0,7, 0,7–0,8, 0,8–0,85, 0,85–0,9, 0,9–0,95, 0,95–1, để đo được precision gần mọi ngưỡng ứng viên. Người gán nhận mẫu kế tiếp theo thứ tự xáo trộn ổn định riêng cho từng người (băm id người gán với id mẫu), chỉ thấy 5 crop và một keyframe, rồi gõ biển, chọn không đọc được hoặc bỏ qua. Nhãn được lưu riêng, không đụng review.

Báo cáo lấy nhãn đồng thuận của mỗi mẫu (mẫu bất đồng bị loại), rồi với từng ngưỡng 0,50–0,99 tính số track máy đánh dấu `readable`, số đúng (khớp chính xác sau chuẩn hóa), precision và coverage. Ngưỡng đề xuất là ngưỡng nhỏ nhất đạt precision mục tiêu. Cách tính giống `app/evaluation.calibrate_threshold`, và báo cáo xuất được file để đối chiếu bằng script.

**Hiệu chỉnh offline trên ICPR (26/10/2026).**
- **Vì sao không dùng nhãn từ camera:** crop trên camera thật quá nhỏ để gán nhãn chắc chắn (trung vị 42 px).
- **Cách làm:** `scripts/calibrate_icpr.py` chạy đúng recognizer và cách tính confidence của live trên bộ ICPR 2026 LRLPR có nhãn người:
  - tập test 3000 track, không dùng để train;
  - tập validation 1000 track.
  - Crop ICPR rộng 39–56 px, cùng cỡ với crop live.
  - Độ chính xác toàn biển trên test đạt 77,1%, khớp 77,3% của notebook.
- **Kết quả:**
  - ở ngưỡng cũ 0,85, precision chỉ 87,0%;
  - ở 0,96, precision 96,9% (khoảng tin cậy 96,1–97,6%) với 68,5% track được gắn `readable`.
- **Ngưỡng chọn:** 0,96 là ngưỡng nhỏ nhất mà cận dưới khoảng tin cậy trên hai tập gộp vẫn từ 95% trở lên. Đây là mặc định mới; migration 0009 đổi các camera đang lưu 0,85.
- **Giới hạn:** ICPR là cận trên cho camera thật, nên vẫn cần xác nhận bằng nhãn live.
- **Phạm vi ảnh hưởng:** ngưỡng chỉ đổi nhãn `readable` và bộ lọc; cảnh báo watchlist và lượt xuất hiện vẫn xét mọi track đọc ra chữ.

## 9 Mô hình trạng thái

### 9.1 Trạng thái job

`status` mô tả vòng đời xử lý; `stage` cho biết bước đang chạy. Stage gồm validating, detection_tracking, recognition, persisting và kết thúc complete/failed. Prepare không có bước recognition. API không tự suy ra phần trăm tiến độ nếu worker không có số liệu.

![Trạng thái job](diagrams/11-state-job.png)

Worker đang chạy giữ advisory lock ở cấp database. Khi một worker hợp lệ khởi động lại, các job còn `running` được đánh dấu `failed` với `WORKER_INTERRUPTED`; không âm thầm tiếp tục từ file kết quả dở. Người dùng tạo job mới trên cùng media để chạy lại. Bản đầu không có retry theo cùng ID hoặc hủy job đang chạy.

### 9.2 Trạng thái kiểm duyệt và trạng thái máy

Hai trạng thái độc lập. Máy có thể `readable`, `unreadable`, `ambiguous` hoặc `not_run`. `ambiguous` có ý nghĩa ở nhánh OCR từng crop và bỏ phiếu; profile joint hiện tại không tạo trạng thái này. Review bắt đầu `pending`, sau đó phản ánh hành động mới nhất.

![Trạng thái kiểm duyệt](diagrams/14-state-review.png)

Mọi trạng thái review đều có thể nhận thao tác tiếp theo hợp lệ. Sơ đồ rút gọn các chuyển tiếp lặp bằng trạng thái lựa chọn hành động; đây không phải một trạng thái được lưu trong DB. Mỗi lần commit tăng revision một đơn vị và thêm lịch sử, không thay đổi trạng thái máy.

### 9.3 Trạng thái phiên live

Phiên bắt đầu `queued`, chuyển `starting` khi worker nhận, `running` khi có frame đầu tiên và `reconnecting` khi mất luồng. Yêu cầu dừng chuyển `stopping`; tiến trình chốt và OCR các track đang mở rồi phiên thành `stopped`. Các trạng thái kết thúc khác: `ended` (hết live, video bị gỡ), `failed` (lỗi khởi động, quá số lần kết nối lại, tiến trình im lặng quá `PLATE_LIVE_STALL_SECONDS`) và `interrupted` (worker dừng hoặc khởi động lại). Mỗi lần đổi trạng thái được ghi vào `live_session_events`.

![Trạng thái phiên live](diagrams/18-state-live-session.png)

Mỗi camera chỉ có một phiên ở các trạng thái hoạt động (ràng buộc bằng unique index một phần). Camera 24/7 không có phiên hoạt động thì worker tạo phiên `queued` mới; nếu các phiên liên tiếp sống dưới hai phút, lần tạo kế tiếp chờ 1, 2, 4… tối đa 30 phút. Người dùng dừng phiên thì chế độ 24/7 tắt.

## 12 Kiến trúc hệ thống và triển khai

### 12.1 Ranh giới hệ thống

Client gọi API NestJS bằng Bearer token. API chịu trách nhiệm xác thực, phân quyền, validation, upload, query, review, camera/phiên live và watchlist; một SSE hub trong API giữ một kết nối PostgreSQL riêng để `LISTEN` và đẩy sự kiện live. Worker Node là tiến trình riêng, lấy việc từ PostgreSQL và điều khiển subprocess Python: job upload qua supervisor, phiên live qua tiến trình `app.live` (stdin để dừng, stdout là JSON lines), hoặc qua một host `app.live --host` dùng chung cho nhiều phiên. Worker cũng dọn bằng chứng live. Python chạy detector, tracking và OCR; không trực tiếp quản lý tài khoản hoặc ghi bảng nghiệp vụ.

![Kiến trúc thành phần](diagrams/15-architecture.png)

PostgreSQL giữ trạng thái hàng đợi và metadata; filesystem riêng giữ media, crop, keyframe, log và manifest. Nhóm bảng `plate_appearances`, `plate_detections`, `ocr_predictions`, `recognition_reviews` phân biệt lần xuất hiện, bằng chứng, kết luận máy và kết luận con người. Không xây bảng phương tiện hoặc chủ xe vì vượt phạm vi hiện hành.

### 12.2 Thành phần triển khai

API và worker có thể chạy hai terminal trên một host ở bản đầu, cùng truy cập database và storage. Máy phải có Node.js, PostgreSQL, môi trường Python tương thích và các checkpoint được cấu hình trước. File JSON profile là cấu hình quản trị phía server; client chỉ gửi `pipeline_id`.

![Triển khai bản đầu](diagrams/16-deployment.png)

**Docker Compose** (`docs/DOCKER.md`): `docker compose --profile app up` chạy bốn container:
- `postgres`;
- `api`: migrate rồi mới phục vụ, báo healthy theo `/health/ready`;
- `worker`: PyTorch CUDA, nhận GPU qua NVIDIA Container Toolkit / WSL 2;
- `web`: bản build FE trên nginx, chuyển `/api` và SSE sang `api`.

Không có profile thì chỉ PostgreSQL chạy, như `start-all`. `data/` và `models/` được mount, không đóng vào image. Code nằm ở `/app` trong cả hai image vì snapshot ghim đường dẫn code. Worker trong Docker chạy một job một lúc, vì VM WSL 2 mặc định (7,4 GB) không đủ RAM cho hai job nạp model song song.

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
| Mỗi track live là một job | Dùng lại xem, kiểm duyệt, tra cứu, CSV, xóa; quyền đi theo chủ camera; không cần bảng kết quả live riêng. |
| Tiến trình live thường trú, không cắt clip | Tracking liên tục qua ranh giới clip, độ trễ vài giây; worker giám sát, kết nối lại và tự bật lại. |
| LISTEN/NOTIFY + SSE | Không thêm message broker; NOTIFY chỉ gửi id, client đọc lại dòng đã commit nên nối lại theo `Last-Event-ID` không mất sự kiện. |
| Chia GPU giữa upload và live | Đo được hai tiến trình cùng nạp model làm tràn VRAM 8 GB và cả hai gần như đứng. Job video joint chạy trong host live (một bản model); các job khác vẫn chờ khi camera chạy. |
| Job trong host giữ tốc độ thời gian thực | Hai camera cộng một job chạy hết tốc độ: camera bỏ 2,3% và 5,4% frame (CPU/GIL, ưu tiên GPU không đủ); giữ thời gian thực: 0% và 0,88%, job 3 phút mất 195 s. |
| Che mật khẩu camera RTSP | URL camera thường chứa mật khẩu; che ở mọi đầu ra (API, sự kiện, lỗi), chỉ thư mục dữ liệu của người vận hành giữ bản đầy đủ. |
| Nạp kernel CUDA kiểu lazy (`CUDA_MODULE_LOADING=LAZY`) | Trên Windows, PyTorch mặc định nạp mọi kernel ngay khi tạo CUDA context, làm host live giữ khoảng 12 GB commit (RAM thật khoảng 3 GB). Với 2 camera và các ứng dụng khác, commit chạm giới hạn và phiên lỗi `Unable to allocate`. Lazy giảm còn khoảng 7 GB, VRAM giảm khoảng 1 GB. Đánh đổi: kernel được nạp ở lần dùng đầu, nhưng phần làm nóng (warm-up) đã chạy trước khi nhận frame. |
| Dừng ffmpeg ghi hình bằng lệnh `q` thay vì kill | Kill làm đoạn MP4 đang ghi (tối đa 10 s cuối) không được đóng, nên track cuối phiên không có video. ffmpeg ghi hình đọc stdin; khi dừng, frame còn lại được đọc bỏ để pipe không nghẽn; quá 10 s mới kill. Camera không ghi hình vẫn kill ngay. |
| Giới hạn đăng nhập sai trong bộ nhớ API | Đủ cho một tiến trình API trên máy demo, không cần bảng hay Redis. Đánh đổi: khởi động lại API thì bộ đếm về 0; nhiều tiến trình API sẽ cần bộ đếm dùng chung. Khóa theo email + địa chỉ, nên người khác không khóa được tài khoản của mình từ máy khác. |
| Bộ mẫu chỉ gồm crop đủ rộng (`min_crop_width`) | Trên camera Camboriú, 180/280 track của bộ mẫu thường có crop dưới 51 px, không đọc được ký tự nào. Gán chúng tốn công mà không thêm thông tin. Kết quả chỉ đại diện cho biển đủ lớn, cũng là nhóm duy nhất máy có thể xếp `readable` đúng. |
| Track 4 frame là tùy chọn, mặc định tắt | Trên ICPR, đọc 4 frame (lặp crop nét nhất) vẫn đạt precision khoảng 96,7% ở 0,97. Nhưng trên ba video thật chỉ 1/11 track bị loại có đúng 4 lần thấy, phần còn lại chỉ 1–3 lần. Vì vậy code hỗ trợ `tracking.min_frames: 4` (bằng chứng 4 crop thật, ngưỡng live cộng 0,01) nhưng config vẫn để 5. |
| Chọn crop bỏ biển bị che/cụt | Trên camera thật, crop bị cột đèn che vẫn được chọn vì to và nét, kéo confidence cả biển xuống. Bỏ lần thấy có box co đột ngột, tỷ lệ lệch hoặc chạm mép, và ưu tiên crop lớn: 7,7 phút Camboriú 1080p có 8 thay vì 4 track `readable`. Đánh đổi: một biển trước đây bị chặn ở `low_confidence` có thể thành `readable` sai, nên precision live vẫn cần nhãn người. TTA chỉ thêm dưới 1 điểm % mà OCR chậm khoảng 3 lần nên không bật. |
| Ghi đệm bằng stream copy, clip có chọn lọc | Ghi toàn bộ video vĩnh viễn tốn khoảng 43 GB/ngày mỗi camera; stream copy gần như không tốn CPU (2 camera bật ghi vẫn 0 frame bỏ). Clip mọi track sẽ khoảng 4 GB/giờ ở Camboriú nên chỉ giữ lâu dài clip của track đọc rõ hoặc có cảnh báo; track khác cắt theo yêu cầu trong 4 giờ. |
| Tối đa 3 camera mỗi GPU | 4 camera bỏ 4–30% frame dù GPU chỉ bận 62%; giảm việc CPU mỗi frame (đọc stderr ffmpeg qua buffer, bỏ checksum showinfo) và tùy chọn giải mã NVDEC đã có, chưa đo lại vì thiếu RAM khi đo. |
| Nhiều phiên trong một host dùng chung model | Đo được VRAM mỗi tiến trình chủ yếu là CUDA context và bộ đệm allocator; dùng chung thì hai camera tốn như một. GPU chỉ bận 31–38% nên giữ nguyên tần suất lấy mẫu. Đánh đổi: phiên treo làm cả host bị kill; mọi phiên phải cùng pipeline. |
| Một luồng GPU, batch 1/4/16 | Đo được mỗi cỡ batch mới tốn khoảng 1,8 s cho mỗi luồng; hai camera bật cùng lúc trước đây bỏ 17 và 73 frame, nay 0. Đánh đổi: frame đệm làm kết quả fp16 dao động rất nhỏ. |
| Giữ lấy mẫu 8/12/15 fps | Thử 15/20/25 fps: số track gần gấp đôi nhưng không thêm biển đọc được, hai camera bỏ 12–17% frame; profile này chỉ để thử nghiệm. |
| Ngưỡng 0,96 từ dữ liệu ICPR có nhãn | Precision mục tiêu 95% với cận dưới khoảng tin cậy; đánh đổi: ít track `readable` hơn (Camboriú 158 → 51 trong 45 phút). |
| Docker Compose theo profile | Máy khác chạy được không cần cài Node/Python/CUDA; `start-all` không đổi. Đánh đổi: image worker khoảng 13 GB, job chậm hơn native. |
| Nhãn đánh giá tách khỏi review | Review là kết luận vận hành, có thể bị ảnh hưởng bởi kết quả máy; nhãn mù mới đo được độ chính xác. |
| Giờ chụp theo PROGRAM-DATE-TIME | PTS gốc của segment (`-copyts`) ứng với PDT theo độ lệch không đổi; giờ nhận frame chỉ là phương án dự phòng. |
