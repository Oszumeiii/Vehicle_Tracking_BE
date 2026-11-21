# Lưu ảnh và video lên Cloudflare R2 (tùy chọn)

Mặc định mọi file nằm trong `PLATE_DATA_DIR` (thường là `data/`) trên máy chạy BE. Khi ổ đầy, có thể đẩy crop, keyframe và video upload lên một bucket chuẩn S3 rồi xóa bản trên máy. Hệ thống được viết cho **Cloudflare R2**, nhưng chạy với mọi dịch vụ chuẩn S3 (Backblaze B2, AWS S3, MinIO, VersityGW...).

Không cấu hình gì thì tính năng này tắt và hệ thống chạy như cũ.

## Cách hoạt động

- **Cùng khóa với database.** Object trong bucket dùng đúng khóa đã lưu trong DB, ví dụ `recognition/<job>/tracks/track_000011/01_frame_0000081.png` hay `media/<id>/input.mp4`. Có thể thêm tiền tố chung bằng `PLATE_S3_PREFIX`.
- **Chỉ đẩy khi bạn chạy lệnh.** Hệ thống không tự đẩy file. Mỗi lần chạy `npm run cloud:push`, file nào đã có trong bucket với cùng kích thước sẽ được bỏ qua, nên chạy lại bao nhiêu lần cũng được.
- **Xem ảnh sau khi xóa bản trên máy.** API vẫn kiểm quyền như bình thường. Nếu file không còn trên đĩa, API trả về chuyển hướng 302 tới một link tạm của bucket, có hạn 10 phút. Trình duyệt tự đi theo link nên giao diện không phải đổi gì.
- **Job cần video thì tự tải về.** Khi chạy job trên một video upload đã bị xóa khỏi máy, worker tải video từ bucket về trước. Camera phát lại một video upload cũng vậy.
- **Xóa trên web thì xóa cả trên bucket.** Xóa job, phiên live hay video upload, hoặc khi hạn lưu dọn track và keyframe, hệ thống xóa luôn bản trong bucket. Nếu việc xóa trên bucket lỗi, hệ thống chỉ ghi cảnh báo vào log.

**Những gì luôn ở lại máy:**

- file JSON kết quả;
- bản ghi đệm của camera (`data/live/`);
- clip video kết quả;
- file của job đang chờ hoặc đang chạy;
- video có camera phát lại: vẫn được sao lên bucket, nhưng không bao giờ bị xóa khỏi máy, vì phiên live cần đọc ngay.

## Tạo bucket R2

Bạn tự làm các bước này trên trang Cloudflare.

1. Đăng nhập Cloudflare Dashboard và mở **R2 Object Storage**. Lần đầu bật R2, Cloudflare có thể yêu cầu thêm phương thức thanh toán, kể cả khi bạn chỉ dùng gói miễn phí.
2. Bấm **Create bucket** và đặt tên, ví dụ `pbl6-plates`. Để bucket ở chế độ riêng tư, **không** bật Public access.
3. Vào **Manage API tokens** (hoặc **Account API tokens**), chọn **Create API token**:
   - quyền **Object Read & Write**;
   - giới hạn **chỉ bucket vừa tạo**.
4. Chép 3 giá trị vào `.env` của BE: **Account ID**, **Access Key ID** và **Secret Access Key**. Secret chỉ hiện đúng một lần, và không được commit file `.env`.

```dotenv
PLATE_R2_ACCOUNT_ID=<account id>
PLATE_S3_BUCKET=pbl6-plates
PLATE_S3_ACCESS_KEY_ID=<access key id>
PLATE_S3_SECRET_ACCESS_KEY=<secret access key>
# Tùy chọn: thư mục chung trong bucket
# PLATE_S3_PREFIX=pbl6
```

Với dịch vụ chuẩn S3 khác, bỏ `PLATE_R2_ACCOUNT_ID` và đặt hai biến sau:

- `PLATE_S3_ENDPOINT`: địa chỉ endpoint, ví dụ `https://s3.us-west-004.backblazeb2.com`;
- `PLATE_S3_REGION`: vùng của bucket (R2 dùng `auto`).

Sau khi sửa `.env`, khởi động lại API và worker (chạy lại `scripts/start-all.ps1`) để chúng đọc cấu hình mới.

## Lệnh

```powershell
npm run build
npm run cloud:check                       # thử ghi, đọc, tạo link tạm và xóa một file nhỏ
npm run cloud:push -- --dry-run --all     # chỉ đếm: sẽ đẩy bao nhiêu file, bao nhiêu MB
npm run cloud:push                        # đẩy crop và keyframe (mặc định)
npm run cloud:push -- --media             # đẩy video và ảnh upload
npm run cloud:push -- --all --free-local  # đẩy tất cả, rồi xóa bản trên máy của file đã lên bucket
npm run cloud:push -- --all --free-local --older-than-days 7 --max-gb 9.5
```

| Tùy chọn | Ý nghĩa |
|---|---|
| `--evidence` | Crop và keyframe của job đã xong. Đây là mặc định khi không chọn gì. |
| `--media` | Video và ảnh upload. |
| `--all` | Cả hai loại trên. |
| `--free-local` | Xóa bản trên máy sau khi bucket có đúng số byte. Không bao giờ xóa video có camera phát lại. |
| `--older-than-days N` | Chỉ lấy job hoặc upload cũ hơn N ngày. |
| `--max-gb N` | Dừng đẩy trước khi phần dữ liệu của hệ thống trong bucket vượt N GB. File cũ được đẩy trước; file còn lại để ở máy. |
| `--dry-run` | Không ghi gì, chỉ báo số file và số MB. |

## Tự động chuyển crop và keyframe lên bucket

Thay vì chạy `cloud:push` bằng tay, worker có thể tự làm việc này. Cách nhanh nhất là chạy `powershell -ExecutionPolicy Bypass -File scripts/set-r2-keys.ps1`: script hỏi Account ID, tên bucket và key (Secret không hiện khi gõ), ghi tất cả vào `.env`, bật tự đồng bộ rồi chạy `cloud:check`. Muốn tự sửa `.env` thì thêm:

```
PLATE_CLOUD_EVIDENCE_AFTER_HOURS=1   # kết quả cũ hơn 1 giờ thì ảnh chuyển lên bucket
# PLATE_CLOUD_MAX_GB=9.5             # dừng trước khi bucket vượt mức này (mặc định 9.5)
# PLATE_CLOUD_SYNC_MINUTES=60        # bao lâu chạy một lần (mặc định 60 phút)
```

Mỗi lần chạy, worker làm các bước sau:

1. Lấy ảnh crop và keyframe (`.png`, `.jpg`) của các job đã xong, cũ hơn số giờ đặt ở trên. File cũ được xử lý trước.
2. Đẩy từng ảnh lên bucket, kiểm tra kích thước trên bucket khớp với file, rồi mới xóa bản trên máy.
3. Khi bucket sắp vượt `PLATE_CLOUD_MAX_GB`, worker dừng đẩy. Ảnh còn lại để ở máy, và log của worker ghi số file bị giữ lại.

Một số điểm cần biết:

- **Những gì không chuyển:** `track.json`, clip `.mp4` và video upload vẫn ở trên máy. Muốn chuyển video upload thì dùng `npm run cloud:push -- --media --free-local`.
- **Xem ảnh trên web:** vẫn bình thường. Ảnh không còn trên máy thì API chuyển hướng tới link tạm 10 phút của bucket. Lệnh lấy mẫu gán nhãn (`sample-labels`) tự tải lại ảnh từ bucket.
- **Xóa:** retention, xóa job, xóa phiên hay xóa video thì xóa luôn bản trên bucket.
- **Khi cấu hình sai:** nếu chưa cấu hình bucket (4 biến ở trên) thì tính năng này không làm gì và worker ghi một dòng cảnh báo.

## Hạn mức miễn phí

Theo bảng giá Cloudflare tại thời điểm viết (nên kiểm tra lại trên trang Cloudflare):

- R2 miễn phí 10 GB lưu trữ mỗi tháng, khoảng 1 triệu thao tác ghi và 10 triệu thao tác đọc;
- tải dữ liệu ra không tính phí;
- vượt 10 GB thì tính khoảng 0,015 USD cho mỗi GB mỗi tháng.

Ngày 17/11/2026, máy demo có khoảng 36.500 file (19,6 GB) đủ điều kiện đẩy lên. Vì vậy, nếu muốn giữ trong gói miễn phí, hãy chạy với `--max-gb 9.5`.

## Kiểm thử

- `tests/cloud.test.ts` kiểm tra các phần sau:
  - chữ ký SigV4 bằng hai ví dụ chính thức của AWS;
  - logic chọn file, `--free-local` và `--max-gb`;
  - khôi phục file từ bucket;
  - chuyển hướng 302 khi file không còn trên máy.
- Đã chạy thử với một server S3 thật (VersityGW trong Docker, có kiểm tra chữ ký), gồm: `cloud:check`, upload 150 MB chia nhiều phần, tải về khớp sha256, link tạm hỗ trợ Range, liệt kê và xóa.
