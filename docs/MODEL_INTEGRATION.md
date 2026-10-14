# Model và giao diện inference

Đối chiếu chat **Gộp pipeline cắt frame và detection** của project Pipeline:

- User chốt Adaptive Sampling → YOLO11 → BoT-SORT, sau đó giao crop cho model thành viên đã train.
- Detector theo notebook [PBL6 PIPELINE](https://www.kaggle.com/code/trnvnhun/pbl6-pipeline): **YOLO11l**, checkpoint `morsetechlab/yolov11-license-plate-detection/license-plate-finetune-v1l.pt`, revision `251a30d7daedca065f56e04b0af04052c907c68f` (mô tả notebook ghi YOLO11n nhưng code dùng v1l). Trước YOLO có adaptive sampling 8/12/15 fps và empty-scene gate.
- BoT-SORT `with_reid=false`; mỗi track đủ điều kiện xuất đúng **5 crop từ 5 frame khác nhau**, chọn trong nhóm crop nét/lớn nhất rồi trải đều theo thời gian, giữ keyframe nguồn. Một keyframe có thể chứa nhiều biển số.
- Quy tắc 5 LR + 5 HR thuộc dữ liệu train cũ, không áp lên đầu vào inference hiện tại.
- Nhận diện: model joint-frame SE-ResNet34-C nhận đồng thời 5 crop 192×48, checkpoint `icpr_checkpoints_resnet34c/single_model_best.pt` (dataset `trnvnhun/icpr-2026-model`), decoder `beam_filter`. Chi tiết ở [OCR_KAGGLE.md](OCR_KAGGLE.md).

## Ranh giới NestJS / Python

NestJS xử lý HTTP, auth, PostgreSQL, queue, quản lý bằng chứng và review. Worker Node lấy job bằng `FOR UPDATE SKIP LOCKED`, dùng advisory lock PostgreSQL để chỉ có một worker, rồi chạy Python subprocess `app.recognition.supervisor` → `app.recognition.runner`.

Python không truy cập database nghiệp vụ. Nó chỉ nhận JSON nội bộ, đọc file nguồn, chạy model và ghi kết quả/ảnh trong thư mục job. Node kiểm tra đầu ra và nhập toàn bộ trong một transaction; chỉ sau đó job thành `succeeded`.

Video dùng toàn frame làm ROI như notebook, không có vùng loại trừ hay road polygon theo camera. Điều này giữ workflow đã chốt nhưng chất lượng detection/tracking vẫn phải kiểm tra trên camera mới.

## Cấu hình model

Dùng `PLATE_PIPELINES_CONFIG=config/pipelines.kaggle.json` để bật cả profile prepare và OCR Kaggle. Profile `task=prepare` chỉ cần detector/tracker/Python. Ảnh `scene` chạy detector; ảnh `plate_crop` lưu ảnh bằng chứng trực tiếp; video chạy adaptive sampling và tracking để chọn đúng năm frame hợp lệ. Prepare không load recognizer, không tạo OCR prediction; kết quả `not_run` có thể nhập tay bằng action `correct`.

Job prepare dùng `job_kind=detect_only` và `pipeline_snapshot.task=prepare`. Tra cứu nhận cả kết quả prepare đã nhập tay.

Profile `pbl6-resnet34c-joint5-v1` có `task=recognize`, `recognizer.input_mode=five_frame_joint`, chỉ nhận video. Callable nhận danh sách đúng 5 PIL RGB images theo thứ tự thời gian và trả một prediction chung. Worker lưu prediction ở cấp appearance, giữ ordered input provenance, `recognition_method=joint_multiframe` và `agreement_count=null` vì không bỏ phiếu. `frame_weights` là trọng số fusion của model, không phải confidence hoặc độ chính xác. `decoding` lưu decoder, greedy text, `format_valid` và beam score heuristic; job lưu thêm `statistics.frame_gate` và gợi ý gộp track `statistics.vehicle_groups`.

`config/pipelines.example.json` giữ hợp đồng adapter từng crop nếu cần model khác sau này. Profile recognize yêu cầu adapter/checkpoint thật; thiếu thành phần trả `ready=false`/`503`. Không cần recognizer để dùng profile prepare.

Đường dẫn trong JSON tính tương đối từ thư mục chứa JSON. Server tính checksum checkpoint và source để đóng băng cấu hình cho mỗi job; sửa checkpoint/source sau enqueue làm job cũ thất bại thay vì chạy âm thầm với bản khác. `ready` kiểm tra cấu hình/file cần thiết; lỗi dependency hoặc inference thực tế vẫn được worker báo qua trạng thái job.

## Hợp đồng adapter một ảnh (tùy chọn)

`recognizer.factory` là `module:callable`. Callable nhận một dict chứa:

```python
{
    "checkpoint": "/absolute/path/recognizer.pt",
    "sha256": "...",
    "version": "team-recognizer-v1",
    "preprocessing_version": "team-preprocessing-v1",
    "config": {},
    "device": "cpu"  # hoặc cuda
}
```

Factory load checkpoint một lần và trả về hàm nhận **một PIL RGB image**. Hàm trả:

```python
{
    "raw_text": "ABC-1234",  # chuỗi rỗng nếu không đọc được
    "ocr_score": None,       # hoặc điểm [0,1] do model cung cấp
    "character_scores": None # hoặc danh sách điểm [0,1]
}
```

Adapter do nhóm cung cấp chịu trách nhiệm resize, RGB/grayscale, normalization, tensor shape, decoder và `eval()/no_grad()` đúng lúc train. Backend không tự suy đoán các bước này. Đổi preprocessing phải đổi phiên bản. Không cần HR tại inference chỉ vì tập train có HR.

Với adapter một ảnh tùy chọn, ảnh `plate_crop` bỏ qua detector; ảnh `scene` phát hiện mọi biển số rồi đọc từng crop. Video đọc 5 crop riêng và chọn toàn chuỗi có ít nhất 3/5 phiếu. Không đủ đa số → `ambiguous`, không đọc được cả 5 → `unreadable`. Quy tắc này không áp lên model Kaggle joint-frame. Tất cả kết quả mới có review `pending`.

Model trained Brazil không tự bảo đảm độ chính xác trên biển Việt Nam. Không lấy detector score hoặc voting count làm accuracy. Công cụ đánh giá độc lập xem `docs/EVALUATION.md`.
