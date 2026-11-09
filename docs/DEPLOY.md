# Deploy

Hệ thống chạy trên **một máy có GPU NVIDIA**, gồm PostgreSQL, API, worker, web (nginx) và Caddy (HTTPS), tất cả bằng `compose.yaml`. Cách build và chạy container xem [DOCKER.md](DOCKER.md); tài liệu này chỉ thêm phần đưa ra Internet.

## Vì sao một máy

- **Worker cần GPU NVIDIA** (YOLO, OCR trên CUDA). Card 8 GB đủ cho 2 camera; CPU không đủ cho live.
- **API và worker dùng chung thư mục `data/`**: worker ghi bản ghi camera và crop, API đọc ngay để cắt clip và phát HLS. Tách hai máy thì phải có ổ mạng dùng chung.
- **Chỉ một worker**: worker giữ khóa trong database, nên nhân bản hay autoscale không có tác dụng.
- **Không dùng database có pooler kiểu transaction** (pooler của Neon, Supabase): SSE dựa vào `LISTEN/NOTIFY`, cần kết nối giữ phiên.

| Mục đích | Cách làm |
|---|---|
| Demo, bảo vệ đồ án | Laptop đang dùng, mở ra ngoài bằng tunnel (mục [Demo bằng tunnel](#demo-bằng-tunnel)) |
| Chạy lâu dài, 24/7 | Máy Ubuntu có GPU, compose với profile `public` (các mục dưới) |
| Cloud | VM có GPU (AWS g4dn, GCP T4), làm như máy Ubuntu; chỉ bật khi cần vì tính tiền theo giờ |

## 1. Chuẩn bị máy (Ubuntu 22.04/24.04)

1. Driver NVIDIA: `sudo ubuntu-drivers install`, khởi động lại, `nvidia-smi` phải in tên GPU.
2. Docker Engine và Compose v2 theo hướng dẫn chính thức của Docker.
3. NVIDIA Container Toolkit theo hướng dẫn của NVIDIA, rồi `sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker`.
4. Kiểm tra: `docker run --rm --gpus all nvidia/cuda:12.8.0-base-ubuntu24.04 nvidia-smi`.
5. Ổ đĩa: `data/` chứa bản ghi camera (mặc định giữ 240 phút mỗi camera), crop, clip và backup. Nên có ổ riêng vài trăm GB. Worker dừng camera khi ổ còn dưới `PLATE_MIN_FREE_GB`.

## 2. Mã nguồn và model

```bash
mkdir pbl6 && cd pbl6
git clone https://github.com/Oszumeiii/Vehicle_Tracking_BE.git
git clone https://github.com/Oszumeiii/Vehicle_Tracking_FE.git   # repo private: cần quyền
cd Vehicle_Tracking_BE
git lfs install && git lfs pull          # checkpoint OCR
```

Detector không có trong git, chép từ máy đang chạy:

```bash
scp models/license-plate-finetune-v1l.pt user@server:pbl6/Vehicle_Tracking_BE/models/
```

Checksum được kiểm khi tạo pipeline; file sai thì pipeline báo `ready=false`.

## 3. File `.env`

```bash
cp .env.example .env
openssl rand -base64 24      # dùng làm POSTGRES_PASSWORD
```

- `POSTGRES_PASSWORD`: mật khẩu mạnh vừa tạo.
- `PLATE_DOMAIN`: tên miền, ví dụ `plates.example.com`. Bản ghi DNS A phải trỏ về IP máy.
- `CORS_ORIGINS`: để trống. Web và API cùng một địa chỉ (nginx chuyển `/api`), nên không cần CORS.
- `PLATE_TRUST_PROXY`: không cần đặt, compose đã đặt `loopback, uniquelocal` cho API.
- Giữ `PLATE_DEVICE=cuda` và các biến `PLATE_*` khác như máy đang chạy.

## 4. Chạy

Mở cổng 80 và 443 (Let's Encrypt cần cả hai):

```bash
sudo ufw allow 80,443/tcp && sudo ufw allow 443/udp
docker compose --profile app --profile public up -d --build
docker compose --profile app --profile public ps     # postgres, api phải healthy
```

Tạo admin lần đầu (mật khẩu 12–128 ký tự, qua biến môi trường):

```bash
read -s PLATE_ADMIN_PASSWORD && export PLATE_ADMIN_PASSWORD
docker compose exec -e PLATE_ADMIN_PASSWORD api node dist/src/cli.js create-admin --email EMAIL
```

Kiểm tra từ máy khác: `https://<tên miền>` mở được trang đăng nhập, `https://<tên miền>/health/ready` trả `ok`. Smoke test: `PLATE_SMOKE_API=https://<tên miền> PLATE_SMOKE_WEB=https://<tên miền> PLATE_SMOKE_EMAIL=... PLATE_SMOKE_PASSWORD=... npm run smoke`.

Chỉ Caddy mở ra ngoài. PostgreSQL (`POSTGRES_PORT`), API (3000, có Swagger) và web (8080) chỉ nghe trên `127.0.0.1` của máy.

### Đường đi của request

```
Trình duyệt ─HTTPS─> Caddy ──> web (nginx) ──/api──> api
```

- Caddy bỏ `X-Forwarded-For` do client gửi và đặt lại bằng IP thật, nginx nối thêm IP của Caddy.
- API tin các hop trong mạng Docker (`PLATE_TRUST_PROXY`), nên giới hạn đăng nhập sai và nhật ký truy cập ghi IP người dùng chứ không phải IP nginx.
- SSE (track, cảnh báo) đi thẳng: Caddy `flush_interval -1`, nginx `proxy_buffering off`.
- Upload không bị giới hạn ở proxy; API tự kiểm `PLATE_MAX_UPLOAD_MIB`.

### Máy không mở được cổng 80/443: Cloudflare Tunnel

Máy thuê theo giờ hay máy sau NAT thường chỉ mở cổng SSH. Khi đó dùng service `tunnel` thay cho Caddy: tunnel tự kết nối ra Cloudflare, Cloudflare cấp HTTPS cho tên miền.

1. Thêm tên miền vào Cloudflare (đổi nameserver ở nơi mua tên miền sang của Cloudflare).
2. Cloudflare dashboard → Zero Trust → Networks → Tunnels → Create a tunnel (Cloudflared), đặt tên, chép token.
3. Trong tab Public Hostname: hostname `plates.<tên miền>`, service `HTTP`, URL `web:80`.
4. Đặt `CLOUDFLARE_TUNNEL_TOKEN=<token>` trong `.env`, rồi:

   ```bash
   docker compose --profile app --profile tunnel up -d
   ```

- Gói Free của Cloudflare chặn mỗi request quá **100 MB**: upload video lớn hơn sẽ lỗi.
- Cloudflare gửi IP người dùng trong `X-Forwarded-For`, nên giới hạn đăng nhập và nhật ký truy cập vẫn ghi đúng người.

## 5. Image dựng sẵn trên GHCR (không bắt buộc)

Image worker khoảng 13 GB, build trên server mất lâu. Workflow `Images` build image `api` và `worker` rồi đẩy lên `ghcr.io/oszumeiii/` khi đẩy tag phiên bản, hoặc chạy tay trong tab Actions:

```bash
git tag v1.0.0 && git push origin v1.0.0
```

Trên server, thêm vào `.env`:

```
PLATE_IMAGE_PREFIX=ghcr.io/oszumeiii/
PLATE_IMAGE_TAG=1.0.0        # hoặc latest
```

rồi `docker compose --profile app --profile public pull api worker` và `up -d`. Nếu package trên GHCR là private, đăng nhập trước bằng `docker login ghcr.io` với token có quyền `read:packages`. Image `web` vẫn build trên server vì repo FE là private (khoảng 1 phút).

## 6. Cập nhật phiên bản

```bash
git -C ../Vehicle_Tracking_FE pull && git pull && git lfs pull
docker compose --profile app --profile public up -d --build    # hoặc pull như mục 5
```

- API tự migrate database trước khi báo healthy; worker chờ API healthy rồi mới chạy.
- Khởi động lại worker thì camera live đang chạy bị ngắt và job upload đang chạy được đánh dấu bị ngắt. Nên cập nhật ngoài giờ.
- Sao lưu database ngay trước khi cập nhật (mục 7).

## 7. Sao lưu và khôi phục

Service `backup` chạy `pg_dump` vào `data/backups/plate-<thời gian>.dump`, mỗi `PLATE_BACKUP_HOURS` giờ (mặc định 24), giữ `PLATE_BACKUP_DAYS` ngày (mặc định 14). Cùng thư mục và định dạng với bản backup của `start-all`.

- Sao lưu ngay: `docker compose --profile app restart backup` (service dump một lần mỗi khi khởi động).
- Khôi phục (ghi đè database hiện tại; dừng api và worker trước):

  ```bash
  docker compose --profile app stop api worker
  docker compose exec -T postgres pg_restore -U plate -d plate --clean --if-exists < data/backups/plate-XXXX.dump
  docker compose --profile app --profile public up -d
  ```

- Database không chứa ảnh và video. Bằng chứng nằm trong `data/` (trừ `data/backups`, `data/model-cache`), cần chép sang ổ hoặc máy khác, ví dụ `rsync -a data/ backup-host:plate-data/` theo cron.
- Log Docker mỗi service giới hạn 10 MB × 5 file.

## Demo bằng tunnel

Không có server hay IP tĩnh thì chạy trên laptop có GPU và mở ra ngoài bằng tunnel. Dùng stack compose (web ở `http://localhost:8080`) chứ không dùng Vite dev: Vite chặn tên miền lạ (`server.allowedHosts`).

- **Cloudflare Tunnel**: `cloudflared tunnel --url http://localhost:8080` in ra một địa chỉ `https://...trycloudflare.com`. Gói Free chặn mỗi request quá **100 MB**, nên upload video lớn sẽ lỗi; camera live và xem kết quả không bị ảnh hưởng.
- **Tailscale**: `tailscale serve --bg 8080` mở `https://<tên máy>.<tailnet>.ts.net` cho các máy trong cùng tailnet; người xem phải cài Tailscale và được mời vào tailnet. Không giới hạn dung lượng upload.

Cloudflare gửi IP người dùng trong `X-Forwarded-For`; IP này là địa chỉ công khai nên API dừng ở đó và ghi đúng người dùng.
