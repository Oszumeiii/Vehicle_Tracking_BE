# Sơ đồ UML

- `Vehicle_Tracking_UML.drawio`: nguồn của toàn bộ 44 sơ đồ, mỗi sơ đồ một trang, đặt tên theo số hình trong báo cáo phân tích thiết kế.
- `png/`: ảnh xuất từ file drawio, dùng để chèn vào báo cáo.

Các hình 1.5, 2.8, 2.9, 3.10, 3.11, 4.9, 4.10, 4.11 và 5.3 là phần camera live, gán nhãn và xem lại video.

Xuất lại một trang bằng draw.io desktop (trang đánh số từ 1):

```
draw.io -x -f png -p <trang> -s 1.5 -b 12 -o docs/uml/png/<tên>.png docs/uml/Vehicle_Tracking_UML.drawio
```
