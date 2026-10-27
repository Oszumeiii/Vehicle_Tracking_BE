# Tài liệu phân tích nghiệp vụ và thiết kế hệ thống

Phiên bản 1.7, đối chiếu mã nguồn ngày **28/10/2026**. Bản này bổ sung cách chọn crop bỏ biển bị che/cụt (AT40) và kết quả thử TTA, track ngắn trên ICPR. Bản 1.6 bổ sung ghi đệm liên tục camera live và video cho mỗi kết quả (UC21, FR30, API49–API52, migration 0011). Bản 1.5 bổ sung camera IP (RTSP) với mật khẩu không bao giờ rời server, job upload chạy cùng camera trong host live, host giữ ấm model, số đo 2/3/4 camera trên môi trường thật và migration 0010. Bản 1.4 bổ sung: ngưỡng `readable` 0,96 hiệu chỉnh trên tập ICPR có nhãn, migration 0009, sửa bỏ frame khi khởi động camera, chạy bằng Docker Compose và CI cho cả hai repo. Bản 1.3 thêm camera demo, gán nhãn độc lập và nhiều camera trên một GPU; bản 1.2 thêm YouTube Live. Bộ tài liệu mô tả backend NestJS/PostgreSQL hiện có và phân biệt rõ chức năng đã triển khai với phần cần mở rộng.

## Bản đọc hoàn chỉnh

- [PDF - 80 trang](output/PHAN_TICH_NGHIEP_VU_VA_THIET_KE.pdf): dùng đọc, in và đưa vào hồ sơ đồ án; có mục lục và bookmark 14 chương.
- [HTML](PHAN_TICH_NGHIEP_VU_VA_THIET_KE.html): mở trực tiếp bằng trình duyệt, có mục lục và 20 sơ đồ SVG nhúng trong file để phóng to.
- [Markdown tổng hợp](PHAN_TICH_NGHIEP_VU_VA_THIET_KE.md): bản văn bản kèm liên kết ảnh sơ đồ.

Nội dung gồm bối cảnh, phạm vi, vai trò, 30 yêu cầu chức năng, 12 yêu cầu phi chức năng, 33 quy tắc nghiệp vụ, 21 use case (5 use case live: camera, phiên, theo dõi real-time, watchlist, xóa phiên/dọn dữ liệu; cùng camera demo, gán nhãn độc lập, báo cáo hiệu chỉnh ngưỡng và xem lại video), luồng xử lý, API, mô hình trạng thái, kiến trúc, triển khai, thiết kế DB, nghiệm thu và đánh giá low-resolution. Thiết kế DB ghi rõ 15 bảng nghiệp vụ cùng bảng kỹ thuật `schema_migrations`, từ điển cột, FK/UQ/CHECK, trigger NOTIFY, index và transaction. Danh mục API có 52 endpoint v2 (21 ban đầu, 17 endpoint live, 10 endpoint camera demo và gán nhãn, 4 endpoint video) cùng các endpoint vận hành.

Pipeline theo notebook [PBL6 PIPELINE](https://www.kaggle.com/code/trnvnhun/pbl6-pipeline): Adaptive Sampling → empty-scene gate → YOLO11l → BoT-SORT → 5 crop/track → OCR SE-ResNet34-C nhận đồng thời 5 crop và trả một prediction theo appearance, decoder `beam_filter`. Tài liệu không áp quy tắc bỏ phiếu 3/5 vào model này. Ảnh đơn dùng prepare và kiểm duyệt thủ công khi chưa có adapter/checkpoint OCR ảnh phù hợp. Kiểm thử và smoke test được phân biệt với đánh giá accuracy trên nhãn chuẩn.

## Chỉnh sửa nội dung

Sửa các nguồn dưới đây rồi dựng lại; không sửa trực tiếp ba bản tổng hợp vì chúng được sinh tự động.

| Nguồn | Nội dung trong tài liệu tổng hợp |
|---|---|
| [01-nghiep-vu.md](01-nghiep-vu.md) | Chương 1-6; ma trận AC ở cuối nguồn được chuyển sang mục 13.5 |
| [02-luong-va-kien-truc.md](02-luong-va-kien-truc.md) | Chương 7, 9 và 12 |
| [03-tuong-tac-api.md](03-tuong-tac-api.md) | Chương 8, 11, 13 và 14 |
| [04-thiet-ke-db.md](04-thiet-ke-db.md) | Chương 10 |

Mỗi sơ đồ có ba file cùng tên trong [diagrams](diagrams): `.puml` để chỉnh sửa, `.svg` để phóng to và `.png` dùng trong PDF. Số thứ tự sơ đồ trong PDF theo thứ tự xuất hiện; khác tiền tố tên file ở nhóm state/ERD.

| Loại | Nguồn sơ đồ |
|---|---|
| Use case | [01-use-case.puml](diagrams/01-use-case.puml) |
| Activity | [Video](diagrams/02-activity-video.puml), [ảnh](diagrams/03-activity-image.puml), [review](diagrams/04-activity-review.puml), [tra cứu/CSV](diagrams/05-activity-search.puml), [track live](diagrams/19-activity-live-track.puml) |
| Sequence | [Đăng nhập](diagrams/06-seq-login.puml), [upload/tạo job](diagrams/07-seq-submit.puml), [worker](diagrams/08-seq-worker.puml), [review](diagrams/09-seq-review.puml), [xóa dữ liệu](diagrams/10-seq-delete.puml), [phiên live](diagrams/17-seq-live-session.puml), [gán nhãn](diagrams/20-seq-labeling.puml) |
| State | [Job](diagrams/11-state-job.puml), [review](diagrams/14-state-review.puml), [phiên live](diagrams/18-state-live-session.puml) |
| ERD | [Tổng thể](diagrams/12-erd.puml), [quan hệ OCR](diagrams/13-erd-ocr.puml) |
| Kiến trúc | [Thành phần](diagrams/15-architecture.puml), [triển khai](diagrams/16-deployment.puml) |

## Dựng lại

Chạy từ thư mục gốc repository. Cần Java, PlantUML 1.2026.8 (hoặc bản tương thích), Python có `reportlab` và `Pillow`. Script hiện sử dụng bộ font Arial tại `C:/Windows/Fonts`; số trang có thể đổi nếu thay font/bố cục. Công cụ tài liệu độc lập với môi trường inference và không đọc database/dữ liệu người dùng.

```powershell
java '-Djava.awt.headless=true' -jar data/document-tools/plantuml.jar -charset UTF-8 -tsvg 'docs/analysis/diagrams/*.puml'
java '-Djava.awt.headless=true' -jar data/document-tools/plantuml.jar -charset UTF-8 -tpng 'docs/analysis/diagrams/*.puml'
python scripts/build_analysis_document.py
```

Đặt PlantUML jar đã tải từ [bản phát hành chính thức](https://github.com/plantuml/plantuml/releases/tag/v1.2026.8) vào đường dẫn ví dụ trên hoặc thay bằng đường dẫn jar của máy. Trên môi trường khác Windows có thể cần Graphviz. Sau khi dựng, dùng Poppler render PDF thành PNG và kiểm tra từng trang, nhất là bảng dài và nhãn đường nối UML. `output/figures.json` liệt kê 20 hình cùng hướng trang để hỗ trợ kiểm tra.

Bản 1.7: trang bảng 12.4 và bảng AT được render và kiểm tra; toàn văn kiểm bằng trích xuất văn bản. Bản 1.6: sơ đồ use case (UC21) được xem trực quan; các trang có UC21, FR30, API49–API52, AT37–AT39, bảng 12.4 được render và kiểm tra; toàn văn kiểm bằng trích xuất văn bản. Bản 1.5: các trang có nội dung mới (UC13, FR19, NFR12, BR27, mục 7.x nhiều camera, bảng 12.4, API22/API25, AT34–AT36, hạn chế 6, cột `source_type`) được render và kiểm tra trực quan; toàn văn được kiểm bằng trích xuất văn bản. Bản 1.4 (75 trang): sơ đồ triển khai sửa được xem trực quan dạng PNG; các trang có nội dung mới (bìa, mục 7.6 hiệu chỉnh ICPR, bảng quyết định 12.4, AT32–AT33) được render bằng PyMuPDF và kiểm tra trực quan; toàn văn được kiểm bằng trích xuất văn bản (không còn câu ngưỡng 0.85 chưa hiệu chỉnh). Bản 1.3 (75 trang): các sơ đồ sửa và mới (use case, ERD, kiến trúc, triển khai, sequence gán nhãn) được xem trực quan dạng PNG; các trang PDF có nội dung mới (bìa, FR/NFR, UC18–UC19, mục 7.6, bảng DB mới, API39–API48, AT28–AT31, AC19–AC22) được render bằng PyMuPDF và kiểm tra trực quan; toàn văn được kiểm bằng trích xuất văn bản. Bản 1.2 (68 trang) được dựng lại sau khi bổ sung phần live: các sơ đồ mới và sửa (use case, ERD, kiến trúc, triển khai, sequence/state/activity live) được kiểm tra trực quan dạng PNG; PDF được kiểm tra bằng trích xuất văn bản (đủ các mục và mã mới). Bản 1.1 (55 trang) đã được kiểm tra trực quan toàn bộ. HTML nhúng hình để đọc độc lập; các liên kết tới mã nguồn vẫn cần repository đi kèm. Không dùng số test trong tài liệu làm số đo độ chính xác OCR.
