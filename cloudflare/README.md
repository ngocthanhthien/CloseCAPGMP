# GMP Close Gap — Backend Cloudflare (D1 + R2 + Workers)

**Trạng thái: đã dựng và kiểm thử xong phần backend, CHƯA cắt chuyển.** Site thật tại
https://ngocthanhthien.github.io/CloseCAPGMP/ vẫn đang chạy Supabase như cũ — không gì thay
đổi cho người dùng cho tới khi có lệnh chuyển đổi rõ ràng. Xem kế hoạch gốc:
`.claude/plans/c-th-ng-tin-d-goofy-rain.md` (nếu còn tồn tại trên máy) hoặc phần "Lịch sử" ở
[../HANDOFF_WEB.md](../HANDOFF_WEB.md).

## 1. Đã dựng những gì

- **D1 database** `gmp-closegap-db` (region APAC) — schema tại [worker/schema.sql](worker/schema.sql), đã áp dụng lên D1 thật (4 bảng: `users`, `gmp_records`, `gmp_audit`, `gmp_traffic_daily`).
- **R2 bucket** `gmp-mediasave` — lưu ảnh gốc, riêng tư (không public).
- **Worker** `gmp-closegap-api` — đã deploy tại `https://gmp-closegap-api.dangthanhbinh53.workers.dev`, có Cron Trigger dọn `gmp_audit`/`gmp_traffic_daily` cũ chạy hằng ngày 03:00 UTC (thay 2 job `pg_cron` cũ).
- **Frontend mới** (`cloudflare/frontend-ready/cloud.js` + `config.js`) — bản viết lại của `cloud.js`/`config.js` gọi thẳng Worker thay vì Supabase, **giữ nguyên giao diện `window.GMPCloud`** nên `index.html` không cần sửa. **Chưa gắn vào site thật** — nằm riêng trong thư mục này chờ lệnh cắt chuyển.

Toàn bộ đã test qua `curl` thật (đăng nhập, tạo/sửa Finding, phát hiện xung đột revision, phân quyền Admin/User, upload ảnh R2, CORS) — xem mục 4.

## 2. Kiến trúc & ánh xạ từ Supabase

| Supabase (cũ) | Cloudflare (mới) |
|---|---|
| Postgres | D1 (SQLite) |
| RLS | Kiểm tra quyền viết tay trong từng route Worker (`src/auth.js` → `authenticate()`/`requireAdmin()`) |
| RPC `gmp_save_record` | `POST /records` (`src/records.js`) — port đủ cả 17 rule nghiệp vụ |
| RPC `gmp_report_traffic` | `POST /traffic/report` (`src/traffic.js`) |
| Storage `gmp-mediasave` | R2 bucket cùng tên, upload **thẳng qua Worker** (`PUT /media/upload`) — không dùng presigned URL để khỏi cần tạo thêm cặp R2 API Token riêng trong dashboard |
| Edge Function `admin-users` | `src/admin.js` (`GET/POST /admin/users`, `PATCH /admin/users/:id/role`, `PATCH /admin/users/:id/status`) |
| Supabase Auth | Bảng `users` tự xây + PBKDF2 (Web Crypto) + JWT tự ký (`src/auth.js`) — xem mục 3 |
| `pg_cron` | Cron Trigger khai báo trong `wrangler.toml` (`scheduled()` trong `src/index.js`) |

Bỏ được hack "Username → email nội bộ giả" (`<username>@<project>.users.internal`) từng cần vì Supabase Auth chỉ nhận email — bảng `users` tự xây lưu thẳng `login_id` (Username hoặc Email tuỳ Admin chọn lúc tạo tài khoản).

## 3. Đăng nhập / mật khẩu

- Băm mật khẩu: PBKDF2-SHA256 qua Web Crypto, salt ngẫu nhiên/tài khoản, **100.000 vòng lặp** — đây là **mức trần cứng của Cloudflare Workers** (thử 210.000 theo khuyến nghị OWASP hiện hành bị lỗi 500 ngay khi test thật: *"iteration counts above 100000 are not supported"* — không có trong tài liệu Cloudflare lúc tra cứu, chỉ phát hiện qua chạy thử). Số vòng lặp lưu riêng theo từng tài khoản để sau này nâng lên (hoặc đổi thuật toán) mà không làm hỏng hash cũ.
- Đăng nhập: `POST /auth/login {login_id, password}` → trả JWT (HS256, hạn 30 ngày). Token chỉ chứng minh danh tính — **mọi request đều tự tra lại `disabled`/`role` từ D1**, nên khoá tài khoản có hiệu lực ngay lập tức bất kể JWT còn hạn.
- **Không có cách chuyển mật khẩu Supabase cũ sang** (giới hạn kỹ thuật, đã thống nhất với người dùng) — mọi tài khoản trên Cloudflare là **mật khẩu mới**, Admin tạo lại từng người lúc cắt chuyển thật.
- Chưa có tài khoản Admin thật nào trên hệ Cloudflare — dùng [worker/create-first-admin.mjs](worker/create-first-admin.mjs) để tạo (xem mục 5).

## 4. Đã kiểm thử (qua `curl` thật, không phải giả lập)

- Đăng nhập đúng/sai mật khẩu, `/me` trả đúng thông tin.
- Tạo Finding/Settings, đọc lại qua `/records`.
- Cố tình gửi `revision` cũ → nhận đúng `409 GMP_CONFLICT`.
- Tài khoản `role=user` bị chặn đúng khi thử sửa Settings (`403 GMP_FORBIDDEN`) và khi gọi `/admin/users` (`403`), vẫn tạo được Finding của chính mình.
- Upload ảnh qua `/media/upload` lên R2 thành công.
- CORS: preflight `OPTIONS` trả đúng header cho origin `https://ngocthanhthien.github.io`; origin lạ không được cấp `Access-Control-Allow-Origin`.
- **Chưa test**: luồng đầy đủ qua giao diện `index.html` thật (mới test API trực tiếp), luồng Data & Egress Control 3 trạng thái trên UI thật, hàng đợi `pendingMedia`, phục hồi từ file backup JSON thật.
- Dữ liệu test đã được xoá sạch khỏi D1/R2 sau khi kiểm thử — hệ đang ở trạng thái rỗng, sẵn sàng nhận dữ liệu thật.

## 5. Việc cần làm KHI (và chỉ khi) quyết định cắt chuyển thật

1. Trên site Supabase hiện tại: Admin bấm **⬇️ Tải bản sao lưu (.json)**.
2. Tạo Admin đầu tiên trên Cloudflare:
   ```bash
   cd cloudflare/worker
   node create-first-admin.mjs "ten_dang_nhap_hoac_email" "mat_khau_moi" "Họ và tên"
   ```
   rồi chạy lệnh `wrangler d1 execute` mà script in ra.
3. Copy [frontend-ready/cloud.js](frontend-ready/cloud.js) và [frontend-ready/config.js](frontend-ready/config.js) đè lên `cloud.js`/`config.js` ở thư mục gốc repo (hoặc đổi `<script src>` trong `index.html` trỏ tới đường dẫn mới), bump số `?v=` để tránh cache cũ, rồi commit + push lên GitHub (đường dẫn Pages giữ nguyên).
4. Đăng nhập Admin vừa tạo → **⬆️ Phục hồi từ file .json** → phục hồi Finding/Settings.
5. Admin tạo lại từng tài khoản nhân viên qua tab **👥 Quản lý người dùng** (mật khẩu mới cho mỗi người).
6. Kiểm thử đầy đủ trên ít nhất 2 thiết bị trước khi thông báo cho mọi người dùng bản mới.
7. **Không xoá project Supabase ngay** — giữ lại tối thiểu 30 ngày làm phương án dự phòng.

## 6. Lệnh thao tác nhanh

```bash
cd cloudflare/worker
npx wrangler deploy                    # deploy lại Worker sau khi sửa code trong src/
npx wrangler d1 execute gmp-closegap-db --remote --command "SQL..."   # chạy SQL trực tiếp trên D1 thật
npx wrangler tail                      # xem log Worker theo thời gian thực
npx wrangler secret put JWT_SECRET     # đổi secret ký JWT (sẽ làm mọi phiên đăng nhập cũ hết hạn ngay)
```

Nếu đổi domain GitHub Pages hoặc thêm domain riêng sau này: sửa `ALLOWED_ORIGINS` trong [worker/wrangler.toml](worker/wrangler.toml) (danh sách phân cách bằng dấu phẩy), rồi `wrangler deploy` lại.
