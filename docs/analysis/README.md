# Tài liệu phân tích nghiệp vụ và thiết kế hệ thống

Phiên bản 1.1, đối chiếu mã nguồn ngày **14/10/2026**. Bộ tài liệu mô tả backend NestJS/PostgreSQL hiện có và phân biệt rõ chức năng đã triển khai với phần cần mở rộng.

## Bản đọc hoàn chỉnh

- [PDF - 55 trang](output/PHAN_TICH_NGHIEP_VU_VA_THIET_KE.pdf): dùng đọc, in và đưa vào hồ sơ đồ án; có mục lục và bookmark 14 chương.
- [HTML](PHAN_TICH_NGHIEP_VU_VA_THIET_KE.html): mở trực tiếp bằng trình duyệt, có mục lục và 16 sơ đồ SVG nhúng trong file để phóng to.
- [Markdown tổng hợp](PHAN_TICH_NGHIEP_VU_VA_THIET_KE.md): bản văn bản kèm liên kết ảnh sơ đồ.

Nội dung gồm bối cảnh, phạm vi, vai trò, 18 yêu cầu chức năng, 8 yêu cầu phi chức năng, 20 quy tắc nghiệp vụ, 12 use case, luồng xử lý, API, mô hình trạng thái, kiến trúc, triển khai, thiết kế DB, nghiệm thu và đánh giá low-resolution. Thiết kế DB ghi rõ 8 bảng nghiệp vụ cùng bảng kỹ thuật `schema_migrations`, từ điển 91 cột, FK/UQ/CHECK, index và transaction. Danh mục API có 21 endpoint v2 và các endpoint vận hành.

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
| Activity | [Video](diagrams/02-activity-video.puml), [ảnh](diagrams/03-activity-image.puml), [review](diagrams/04-activity-review.puml), [tra cứu/CSV](diagrams/05-activity-search.puml) |
| Sequence | [Đăng nhập](diagrams/06-seq-login.puml), [upload/tạo job](diagrams/07-seq-submit.puml), [worker](diagrams/08-seq-worker.puml), [review](diagrams/09-seq-review.puml), [xóa dữ liệu](diagrams/10-seq-delete.puml) |
| State | [Job](diagrams/11-state-job.puml), [review](diagrams/14-state-review.puml) |
| ERD | [Tổng thể](diagrams/12-erd.puml), [quan hệ OCR](diagrams/13-erd-ocr.puml) |
| Kiến trúc | [Thành phần](diagrams/15-architecture.puml), [triển khai](diagrams/16-deployment.puml) |

## Dựng lại

Chạy từ thư mục gốc repository. Cần Java, PlantUML 1.2026.8 (hoặc bản tương thích), Python có `reportlab` và `Pillow`. Script hiện sử dụng bộ font Arial tại `C:/Windows/Fonts`; số trang có thể đổi nếu thay font/bố cục. Công cụ tài liệu độc lập với môi trường inference và không đọc database/dữ liệu người dùng.

```powershell
java '-Djava.awt.headless=true' -jar data/document-tools/plantuml.jar -charset UTF-8 -tsvg 'docs/analysis/diagrams/*.puml'
java '-Djava.awt.headless=true' -jar data/document-tools/plantuml.jar -charset UTF-8 -tpng 'docs/analysis/diagrams/*.puml'
python scripts/build_analysis_document.py
```

Đặt PlantUML jar đã tải từ [bản phát hành chính thức](https://github.com/plantuml/plantuml/releases/tag/v1.2026.8) vào đường dẫn ví dụ trên hoặc thay bằng đường dẫn jar của máy. Trên môi trường khác Windows có thể cần Graphviz. Sau khi dựng, dùng Poppler render PDF thành PNG và kiểm tra từng trang, nhất là bảng dài và nhãn đường nối UML. `output/figures.json` liệt kê 16 hình cùng hướng trang để hỗ trợ kiểm tra.

PDF được kiểm tra trực quan toàn bộ 55 trang, gồm các bản sửa activity, ERD và kiến trúc. HTML nhúng hình để đọc độc lập; các liên kết tới mã nguồn vẫn cần repository đi kèm. Không dùng số test trong tài liệu làm số đo độ chính xác OCR.
