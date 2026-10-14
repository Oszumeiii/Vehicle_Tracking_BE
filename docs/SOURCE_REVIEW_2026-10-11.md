# Rà soát source backend ngày 11/10/2026

## Kết luận và phạm vi

Đã đối chiếu API NestJS, xác thực/phân quyền, PostgreSQL/migration/import, quản lý file, worker Node, adapter Python, tích hợp tracking/OCR và tài liệu vận hành với phạm vi bản đầu. **Có đủ 21 endpoint v2 và 5 endpoint v1 đã thống nhất.** Chưa thấy route nghiệp vụ bắt buộc nào bị thiếu.

Có **6 lỗi mức P2** cần xử lý trong các trường hợp đầu vào hoặc triển khai cụ thể. Chưa phát hiện lỗi P0/P1 hoặc truy cập chéo tài khoản trong các luồng đã kiểm tra; điều này không thay thế kiểm thử tải hay đánh giá bảo mật độc lập. Đây là báo cáo rà soát: chưa sửa runtime, migration đã áp dụng, checkpoint, `.env` hay dữ liệu đang sử dụng.

## Các lỗi đã xác minh

### F01 - P2: Ảnh JPEG có EXIF orientation bị xử lý sai hướng

- Nguồn: [runner.py:116](../app/recognition/runner.py#L116), [probe_media.py:19](../scripts/probe_media.py#L19).
- `_image_detections` dùng `source.convert("RGB")` trước detector/crop, chưa áp dụng EXIF orientation. Bằng chứng PNG sinh ra mất thông tin orientation.
- Tái hiện: JPEG có pixel thô 80 x 40, orientation=6. Hướng hiển thị sau áp EXIF phải là 40 x 80, nhưng probe, frame và crop hiện giữ 80 x 40.
- Hệ quả: ảnh điện thoại được hiển thị đúng trên trình duyệt nhưng detector xử lý ảnh xoay; bằng chứng/bbox không cùng hệ tọa độ hiển thị của nguồn. Lỗi ảnh hưởng cả scene và plate_crop.
- Cách sửa: áp `ImageOps.exif_transpose` trước chuyển RGB; dùng cùng quy tắc cho metadata và bằng chứng. Giữ file gốc để đối chiếu, mô tả rõ tọa độ sau chuẩn hóa.
- Kiểm thử cần thêm: orientation 3/6/8 và ảnh không EXIF; so kích thước, pixel đánh dấu góc, bbox và crop.

### F02 - P2: Checksum migration phụ thuộc kiểu xuống dòng

- Nguồn: [migrate.ts:21](../src/database/migrate.ts#L21), [migrate.ts:50](../src/database/migrate.ts#L50).
- Readiness và migration hash nguyên văn SQL. Repo chưa có `.gitattributes`, cấu hình Git máy hiện tại là `core.autocrlf=true`, hai migration đang dùng LF.
- Tái hiện bằng DB stub trong bộ nhớ: lưu checksum của SQL CRLF, rồi đọc cùng nội dung DDL ở dạng LF. `assertCurrentMigrations` báo schema không current; `migrate` báo migration đã bị sửa.
- Hệ quả có điều kiện: checkout hoặc khôi phục DB trên máy dùng kiểu xuống dòng khác có thể khiến `/health/ready` trả 503 và chặn migrate dù DDL không thay đổi. Không phải mọi lần chuyển máy đều lỗi; trigger là thay đổi byte LF/CRLF.
- Cách sửa: cố định `*.sql text eol=lf`, thiết kế tương thích cho checksum cũ sau khi đối chiếu nội dung. Không tự thay checksum DB đang dùng hoặc bỏ kiểm tra nội dung migration.
- Kiểm thử cần thêm: LF/CRLF tương đương được xử lý có kiểm soát; sửa nội dung SQL thực vẫn bị từ chối; DB đã migrate vẫn khởi động được.

### F03 - P2: Độ dài biển số chỉ được kiểm tra trước chuẩn hóa

- Nguồn: [results.controller.ts:54](../src/results/results.controller.ts#L54), [results.controller.ts:227](../src/results/results.controller.ts#L227).
- Schema cho `corrected_text` tối đa 64 ký tự, sau đó gọi `toUpperCase()` và ghi `effective_text varchar(128)` mà không kiểm tra lại độ dài.
- Tái hiện qua HTTP và PostgreSQL tạm: `corrected_text = 'ﬃ'.repeat(64)` qua schema; chữ hoa thành 192 ký tự; PostgreSQL từ chối và API trả 500.
- Hệ quả: dữ liệu đầu vào không hợp lệ bị báo lỗi server thay vì 422. Transaction rollback đúng: revision vẫn 0, text cũ và lịch sử review không đổi.
- Cách sửa: chuẩn hóa rồi kiểm tra độ dài theo hợp đồng trước transaction; không tự đổi O/0 hoặc áp luật Brazil lên dữ liệu khác nếu chưa chốt quy tắc.
- Kiểm thử cần thêm: Unicode có phép uppercase mở rộng, chuỗi chỉ khoảng trắng/dấu gạch, giới hạn độ dài trước/sau chuẩn hóa.

### F04 - P2: Ký tự NUL lọt tới PostgreSQL

- Nguồn: [results.controller.ts:42](../src/results/results.controller.ts#L42), [jobs.controller.ts:47](../src/jobs/jobs.controller.ts#L47), [ownership.ts:34](../src/common/ownership.ts#L34).
- Các schema chuỗi và ID hiện chưa loại `\u0000`; PostgreSQL không lưu/so sánh được NUL trong kiểu text.
- Tái hiện qua HTTP với tài khoản fixture: correction `ABC\u0000123`, note chứa NUL, query `plate` chứa NUL, filter `media_id` chứa NUL và path `/recognition-results/a%00` đều trả 500.
- Hệ quả: request do client nhập sai gây lỗi DB và log lỗi server; review lỗi rollback đúng, không mất dữ liệu. Đây không phải SQL injection: truy vấn vẫn dùng bind parameters.
- Cách sửa: loại NUL ở biên nhập liệu, kiểm tra ID theo schema phù hợp trên body/query/path. Với ID legacy phải giữ hợp đồng ID cũ thay vì ép tất cả thành UUID hex.
- Kiểm thử cần thêm: NUL ở body/query/path trả 422 hoặc mã lỗi tài nguyên đã thống nhất, không chạm DB; các trường văn bản hợp lệ vẫn giữ nguyên nội dung.

### F05 - P2: JSON body quá lớn trả 500 thay vì 413

- Nguồn: [http.ts:41](../src/common/http.ts#L41), [http.ts:77](../src/common/http.ts#L77).
- Lỗi `PayloadTooLargeError` từ body parser không thuộc các nhánh Zod/HttpException/PG mà bộ lọc đang xử lý nên rơi vào lỗi server chung.
- Tái hiện: gửi JSON khoảng 200 KB vào `POST /api/v2/auth/login` trong ứng dụng NestJS thật; nhận `{ "detail": "Internal server error." }` và status 500. Không cần DB sống để tái hiện. JSON sai cú pháp thông thường vẫn trả 400 đúng.
- Hệ quả: sai hợp đồng quá dung lượng; frontend và hệ thống giám sát phân loại nhầm lỗi client thành lỗi server. Multipart quá lớn đã có xử lý riêng, không phải mọi upload đều gặp lỗi này.
- Cách sửa: ánh xạ đúng loại lỗi body parser được tin cậy sang 413, giữ JSON error contract và không phản chiếu body/stack trace.
- Kiểm thử cần thêm: oversized JSON, malformed JSON và multipart quá giới hạn có status/body phù hợp.

### F06 - P2: Ảnh cực lớn bị báo nhầm lỗi môi trường

- Nguồn: [probe_media.py:13](../scripts/probe_media.py#L13), [probe_media.py:53](../scripts/probe_media.py#L53), [storage.ts:151](../src/media/storage.ts#L151).
- Pillow có thể ném `Image.DecompressionBombError` ngay khi `Image.open`, trước kiểm tra giới hạn 25 MP của ứng dụng. Exception này chưa được bắt.
- Tái hiện bằng PNG header nhỏ khai kích thước 20000 x 10000, không cấp phát ảnh lớn: probe thoát code 1 với `DecompressionBombError`. Storage chỉ ánh xạ code 2 thành 422, các code khác thành 503.
- Hệ quả: ảnh không hợp lệ bị báo "Media inspection is unavailable" dù runtime vẫn tốt. Ảnh vẫn bị từ chối và dọn khỏi luồng upload; không xác nhận có vượt qua bảo vệ kích thước.
- Cách sửa: bắt riêng lỗi giới hạn ảnh trong probe và trả code đầu vào không hợp lệ; giữ các lỗi import/runtime thật ở nhánh 503.
- Kiểm thử cần thêm: ảnh vừa vượt 25 MP, ảnh kích hoạt Pillow bomb guard, ảnh hỏng và thiếu dependency để phân biệt 422/503.

## API hiện có và phần cần phát triển

Các nhóm endpoint đã đủ theo kế hoạch: tài khoản/phiên 6; media 4; pipeline/job 6; kết quả/bằng chứng/review/CSV 5. Có 5 endpoint v1 tương thích, cùng root, liveness và readiness. Swagger đã mô tả các response chính, quyền Bearer, nulls, pagination, Range và file export.

**Năng lực còn thiếu trong mục tiêu nhận diện đầy đủ:** OCR ảnh đơn chưa có model/adapter thực được cấu hình. Endpoint ảnh và plate_crop hoạt động ở chế độ prepare rồi nhập thủ công. Model Kaggle hiện nhận đồng thời 5 crop video, một prediction theo appearance; không nhân bản ảnh đơn để dùng thay model ảnh. Cần bổ sung checkpoint/preprocessing và kiểm chứng khi triển khai OCR ảnh đơn, không cần tạo endpoint mới chỉ để làm việc này.

Các hạng mục nên ưu tiên sau khi sửa 6 lỗi:

1. **Vận hành và giới hạn tài nguyên:** heartbeat worker, độ dài/thời gian chờ queue; runtime preflight có kiểm soát; rate limit login, quota dung lượng và số job đang chờ theo tài khoản. `/health/ready` hiện chỉ kiểm DB/schema, `pipelines.ready` kiểm file/config/checksum, chưa xác nhận model load/GPU/worker sống.
2. **Khôi phục và dọn dữ liệu:** journal/reconcile cho khoảng gián đoạn giữa filesystem rename và DB commit; dọn incoming/trash/staging và session hết hạn có kiểm tra tham chiếu. Backup/restore đã có tài liệu, nên kiểm thử phục hồi định kỳ thay vì viết thêm hướng dẫn trùng.
3. **Tài khoản phía User:** cân nhắc `POST /api/v2/auth/change-password` với mật khẩu hiện tại và thu hồi phiên phù hợp. Hiện chỉ Admin đặt lại mật khẩu; đây là mở rộng trải nghiệm, không phải endpoint bị bỏ sót trong kế hoạch.
4. **Frontend đọc metadata:** cân nhắc `GET /api/v2/media/{id}` nếu màn hình chi tiết cần truy xuất trực tiếp thay vì tìm trong danh sách. Hiện API có list và content; route metadata đơn không nằm trong danh mục ban đầu.
5. **Triển khai tự động:** CI chạy build, format, Node/PostgreSQL và Python tests; gói deploy API/worker cùng migration, Python và checkpoint. Compose hiện chỉ cung cấp PostgreSQL. Không triển khai nhiều worker chỉ bằng tăng replica vì advisory lock chủ ý giới hạn một worker.
6. **Chẩn đoán ML và đánh giá:** ánh xạ typed exceptions cho CUDA/invalid video thay vì gom về PIPELINE_FAILED; đánh giá trên dữ liệu Brazil có nhãn độc lập, đo exact accuracy/CER/latency và tỷ lệ bỏ sót. Bổ sung precision/false positives hoặc tracking metrics nếu muốn kết luận chất lượng toàn pipeline.

Camera live, bãi xe, thu phí, chủ xe, xử phạt, đăng ký công khai, cancel/retry theo cùng job ID, SR và hỗ trợ Việt Nam không thuộc API bắt buộc bản đầu. Không cần mở rộng các phần đó chỉ để đạt đủ danh mục hiện hành.

## Kiểm chứng và giới hạn của lượt rà soát

- TypeScript build và Prettier đạt.
- Python: 98 passed, 5 warnings (deprecation từ test FastAPI cũ và cảnh báo Transformer). Không có test fail.
- Node/PostgreSQL: **50 test đạt**, tính cả test cha, chạy đủ các suite theo hai đợt. Đợt đầu API 18 + DB/CLI 8 đạt trước khi phiên thực thi bị ngắt; đợt sau chạy riêng joint-results/OpenAPI/recognition, kết thúc 24 passed, 0 failed/cancelled/skipped. Không tính trùng các test hoặc tuyên bố một lần `npm test` chạy liền mạch đã hoàn tất.
- `npm audit --omit=dev` trong đợt kiểm tra trả 0 advisory dependency production; không chứng minh ứng dụng không có lỗ hổng hoặc bao phủ dependency Python.
- `python -m pip check` báo không có dependency bị thiếu/xung đột trong môi trường đang kiểm tra; đây không phải kiểm tra advisory bảo mật Python.
- Repro HTTP/body và probe tại `data/source-audit/`; repro DB tại `data/audit-db-api.cjs`. Fixture dùng DB riêng và không truy cập dữ liệu người dùng. Script tái hiện được giữ ở vùng data bỏ qua Git; các bước, trigger và kết quả cần thiết đã ghi trong báo cáo này.
- Review NUL/Unicode xác nhận rollback đúng. Các test sẵn có kiểm tra tài khoản chéo, revision đồng thời, FK/cascade, import, snapshot và validator joint-five.
- Chưa thực hiện load/soak test, thử crash tại mọi điểm filesystem/DB, benchmark GPU hoặc chấm accuracy trên bộ nhãn độc lập trong lượt này. Không suy ra độ chính xác OCR từ số test đạt.

Ưu tiên sửa F01 và F02 trước khi nhận ảnh điện thoại hoặc chuyển môi trường; sửa F03-F06 cùng một đợt tăng cường validation/error contract, rồi thêm regression tests cho từng trigger nêu trên.
