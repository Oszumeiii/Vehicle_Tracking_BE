# Hướng dẫn gán nhãn biển số (cho nhóm)

Nhãn người gán là đáp án dùng để đo độ chính xác của hệ thống trên camera thật và kiểm tra ngưỡng `readable` 0,96. Cách tính nằm ở `docs/EVALUATION.md`; tài liệu này chỉ hướng dẫn cách gán.

## Cần gì

- **Bộ mẫu:** "Camboriú YouTube: crop ≥ 51 px, cho nhóm gán". Bộ này chỉ gồm track có crop đủ lớn để người đọc được (khoảng 160 mẫu). Biển nhỏ hơn 51 px thì gần như không ai đọc được, nên không đưa vào.
- **Số người:** mỗi mẫu cần **ít nhất 2 người gán độc lập**. Báo cáo chỉ dùng mẫu mà mọi người gán giống nhau.
- **Thời gian:** khoảng 10 giây mỗi mẫu, tức 25–35 phút cho cả bộ. Có thể chia làm nhiều lần; hệ thống nhớ mẫu nào bạn đã gán.
- **Màn hình:** nên dùng màn hình máy tính, phóng to trình duyệt 125–150% nếu crop nhỏ.

## Bước 1: tài khoản

Mỗi người dùng **tài khoản riêng**, vì hệ thống đếm số người gán theo tài khoản. Hai người dùng chung một tài khoản sẽ chỉ được tính là một người.

- Admin tạo tài khoản ở **Cài đặt hệ thống → Cấp phát & Tạo tài khoản thành viên mới**, vai trò `user`.
- Người gán không cần quyền admin.

## Bước 2: mở bộ mẫu

1. Đăng nhập, chọn **Gán nhãn** ở thanh bên trái.
2. Trong danh sách **Bộ mẫu gán nhãn**, chọn "Camboriú YouTube: crop ≥ 51 px, cho nhóm gán".
3. Tab **Gán nhãn** hiện mẫu kế tiếp. Mỗi người thấy mẫu theo **thứ tự khác nhau**, nên không cần chia nhau theo số thứ tự.

## Bước 3: đọc một mẫu

Mỗi mẫu có **5 crop** của cùng một biển ở các thời điểm khác nhau. Kết quả máy đọc được **ẩn**, để nhãn của bạn độc lập.

1. Xem cả 5 crop. Ký tự mờ ở crop này thường rõ hơn ở crop khác: ghép thông tin từ nhiều crop.
2. Gõ **đúng 7 ký tự** nhìn thấy, không dấu gạch, không khoảng trắng (chữ tự chuyển thành chữ hoa).
3. Nhấn **Enter** hoặc **Lưu**.

| Nút | Khi nào dùng |
|---|---|
| **Lưu (Enter)** | Bạn chắc chắn **từng ký tự** |
| **Không đọc được** | Bạn chắc rằng **không ai** đọc được biển này từ 5 crop (quá mờ, bị che, chỉ thấy một phần) |
| **Bỏ qua** | Bạn đọc được phần lớn nhưng **còn phân vân** một vài ký tự. Mẫu bỏ qua có thể xem lại sau |
| **Quay lại / Sửa mẫu vừa gán** | Bạn vừa gõ nhầm |

> **Quan trọng:** "Không đọc được" bị tính là **máy đọc sai** nếu máy đã đọc ra một biển. Vì vậy chỉ chọn khi bạn chắc không ai đọc nổi. Còn phân vân thì chọn **Bỏ qua**, không đoán.

## Định dạng biển Brazil

Camera Camboriú ở Brazil. Biển có 7 ký tự, hai kiểu:

| Kiểu | Mẫu | Ví dụ |
|---|---|---|
| Mercosul (mới, nền trắng, dải xanh phía trên) | `LLL N L NN` | `ABC1D23` |
| Cũ (nền xám) | `LLL NNNN` | `ABC1234` |

`L` là chữ cái, `N` là chữ số.
- 3 ký tự đầu luôn là chữ, ký tự thứ 4 và 2 ký tự cuối luôn là số.
- Ký tự thứ 5 là chữ (Mercosul) hoặc số (biển cũ). Ở biển Mercosul, ký tự này thường là chữ từ A đến J.
- Dùng định dạng để **kiểm tra lại** cách đọc (ví dụ ở vị trí số thì là `0`, không phải `O`), **không dùng để đoán** ký tự không nhìn thấy.
- Bỏ qua dòng chữ "BRASIL", tên thành phố và cờ trên biển; chỉ gõ 7 ký tự chính.

## Các cặp ký tự hay nhầm

| Dễ nhầm | Cách phân biệt |
|---|---|
| `H` / `M` / `N` | `M` có đỉnh nhọn ở giữa phía trên; `H` có thanh ngang ở giữa; `N` có một nét chéo |
| `O` / `D` / `Q` / `0` | Theo vị trí: chữ ở vị trí 1–3 (và 5 với Mercosul), số ở các vị trí còn lại. `D` có cạnh trái thẳng |
| `U` / `O` / `V` | `U` có hai cạnh thẳng song song và đáy tròn; `V` đáy nhọn |
| `T` / `I` / `1` | `T` có thanh ngang trên rộng |
| `B` / `8`, `S` / `5`, `Z` / `2`, `G` / `6` | Xem vị trí (chữ hay số) |
| `6` / `8`, `3` / `8` | Nhìn crop nét nhất; vẫn phân vân thì **Bỏ qua** |
| `K` / `X`, `R` / `K` | Nhìn nét bên trái: `K`, `R` có nét đứng thẳng |

## Một lượt gán gợi ý

1. Gán một lượt nhanh: đọc chắc thì **Lưu**, phân vân thì **Bỏ qua**, rõ ràng không đọc được thì **Không đọc được**.
2. Hết mẫu, nhấn **Xem lại các mẫu đã bỏ qua** và xem lại một lần với đầu óc tỉnh táo. Vẫn phân vân thì bỏ qua tiếp; mẫu không có nhãn vẫn tốt hơn nhãn sai.
3. **Không bàn với người khác** về một mẫu cụ thể trước khi cả hai đã gán xong. Hai nhãn chỉ có giá trị khi độc lập.

## Sau khi gán (admin)

1. Mở tab **Báo cáo ngưỡng** của bộ mẫu.
2. Chọn **Số nhãn tối thiểu mỗi mẫu: 2** và precision mục tiêu 95%.
3. Báo cáo cho biết: ngưỡng đề xuất; số mẫu dùng tính và số mẫu **bất đồng** bị loại; tỷ lệ đồng thuận giữa người gán; bảng precision/coverage theo từng ngưỡng.
4. Mẫu mà hai người gán khác nhau không được tính. Nếu nhiều mẫu bất đồng, nên nhờ người thứ ba gán thêm.
5. Báo lại kết quả để cập nhật `docs/EVALUATION.md` và tài liệu phân tích.
