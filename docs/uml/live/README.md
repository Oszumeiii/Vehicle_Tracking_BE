# Sơ đồ UML cập nhật cho phần live (01/11/2026)

Bộ sơ đồ thay thế các hình trong báo cáo "Báo cáo phân tích và thiết kế hệ thống Vehicle Tracking BE"
(bản drawio 17/10, `docs/uml/Vehicle_Tracking_UML.drawio`) ở những chỗ nghiệp vụ hoặc logic đã đổi
sau khi thêm camera live, gán nhãn, ghi hình và giới hạn đăng nhập. Tên file theo số hình trong báo cáo;
hình 1.5, 2.8, 2.9, 3.10, 3.11, 4.9–4.11 và 5.3 là hình mới.

| Hình | File | Thay đổi |
|---|---|---|
| 1.1 | h1-1-bfd | Thêm nhóm 8 Camera live, nhóm 9 Gán nhãn; chức năng mới ở nhóm 1, 4–7 |
| 1.2 | h1-2-dfd-context | Thêm tác nhân ngoài "Nguồn video live" và các luồng live |
| 1.3 | h1-3-dfd-top | Thêm tiến trình 7.0, 8.0 và kho D7–D11 |
| 1.5 | h1-5-dfd-live | DFD mức dưới đỉnh của 7.0 Nhận diện live |
| 2.1 | h2-1-usecase-overview | Use case tổng quát có live, real-time, video, gán nhãn |
| 2.8 | h2-8-usecase-live | Phân rã Camera live (UC13–UC18, UC21) |
| 2.9 | h2-9-usecase-labelling | Phân rã Gán nhãn và hiệu chỉnh ngưỡng (UC19–UC20) |
| 3.1 | h3-1-activity-login | Thêm giới hạn đăng nhập sai (429) |
| 3.5 | h3-5-activity-worker | Worker chạy song song slot job, vòng live, dọn dữ liệu |
| 3.10 | h3-10-activity-live-track | Từ frame live đến kết quả và cảnh báo |
| 3.11 | h3-11-activity-video | Xem lại video của một kết quả |
| 4.1 | h4-1-seq-login | Thêm LoginThrottle |
| 4.9 | h4-9-seq-live-session | Phiên live từ lúc bật đến lúc dừng |
| 4.10 | h4-10-seq-video | Xem video kết quả |
| 4.11 | h4-11-seq-labelling | Bộ mẫu, gán nhãn mù, báo cáo ngưỡng |
| 5.3 | h5-3-state-live-session | Trạng thái phiên live |
| 6.1 | h6-1-class-entity | Lớp thực thể có StreamSource, LiveSession, Watchlist, Evaluation |
| 6.2 | h6-2-class-design | Lớp thiết kế có controller live, SSE hub, LiveManager, host |
| 6.3 | h6-3-erd | ERD đến migration 0011 |
| 7.1 | h7-1-components | Thành phần có app.live, ffmpeg, SSE |
| 7.2 | h7-2-deployment | Triển khai có host live, Docker Compose |

Dựng lại PNG (từ thư mục gốc repository):

```powershell
java '-Djava.awt.headless=true' -jar data/document-tools/plantuml.jar -charset UTF-8 -tpng 'docs/uml/live/h*.puml'
```
