# Tài liệu phân tích nghiệp vụ và thiết kế hệ thống

Phiên bản 1.3, đối chiếu mã nguồn ngày **25/10/2026** (bổ sung camera demo, gán nhãn độc lập và nhiều camera trên một GPU, giai đoạn 6; bản 1.2 thêm YouTube Live). Bộ tài liệu mô tả backend NestJS/PostgreSQL hiện có và phân biệt rõ chức năng đã triển khai với phần cần mở rộng.

## Bản đọc hoàn chỉnh

- [PDF - 75 trang](output/PHAN_TICH_NGHIEP_VU_VA_THIET_KE.pdf): dùng đọc, in và đưa vào hồ sơ đồ án; có mục lục và bookmark 14 chương.
- [HTML](PHAN_TICH_NGHIEP_VU_VA_THIET_KE.html): mở trực tiếp bằng trình duyệt, có mục lục và 20 sơ đồ SVG nhúng trong file để phóng to.
- [Markdown tổng hợp](PHAN_TICH_NGHIEP_VU_VA_THIET_KE.md): bản văn bản kèm liên kết ảnh sơ đồ.

Nội dung gồm bối cảnh, phạm vi, vai trò, 29 yêu cầu chức năng, 12 yêu cầu phi chức năng, 32 quy tắc nghiệp vụ, 20 use case (5 use case live: camera, phiên, theo dõi real-time, watchlist, xóa phiên/dọn dữ liệu; cùng camera demo, gán nhãn độc lập và báo cáo hiệu chỉnh ngưỡng), luồng xử lý, API, mô hình trạng thái, kiến trúc, triển khai, thiết kế DB, nghiệm thu và đánh giá low-resolution. Thiết kế DB ghi rõ 15 bảng nghiệp vụ cùng bảng kỹ thuật `schema_migrations`, từ điển cột, FK/UQ/CHECK, trigger NOTIFY, index và transaction. Danh mục API có 48 endpoint v2 (21 ban đầu, 17 endpoint live, 10 endpoint camera demo và gán nhãn) cùng các endpoint vận hành.

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

Bản 1.3 (75 trang): các sơ đồ sửa và mới (use case, ERD, kiến trúc, triển khai, sequence gán nhãn) được xem trực quan dạng PNG; các trang PDF có nội dung mới (bìa, FR/NFR, UC18–UC19, mục 7.6, bảng DB mới, API39–API48, AT28–AT31, AC19–AC22) được render bằng PyMuPDF và kiểm tra trực quan; toàn văn được kiểm bằng trích xuất văn bản. Bản 1.2 (68 trang) được dựng lại sau khi bổ sung phần live: các sơ đồ mới và sửa (use case, ERD, kiến trúc, triển khai, sequence/state/activity live) được kiểm tra trực quan dạng PNG; PDF được kiểm tra bằng trích xuất văn bản (đủ các mục và mã mới). Bản 1.1 (55 trang) đã được kiểm tra trực quan toàn bộ. HTML nhúng hình để đọc độc lập; các liên kết tới mã nguồn vẫn cần repository đi kèm. Không dùng số test trong tài liệu làm số đo độ chính xác OCR.
