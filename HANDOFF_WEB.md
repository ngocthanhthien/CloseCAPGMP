# Handoff bản web — cập nhật 2026-09-30

Bàn giao để tiếp tục chỉnh sửa bằng công cụ AI khác. Đọc file này trước, sau đó [README.md](README.md) để biết hướng dẫn setup/vận hành đầy đủ.

## 0. Trạng thái hiện tại: đã cắt chuyển hoàn toàn sang Cloudflare, Supabase đã gỡ khỏi repo

Site thật https://ngocthanhthien.github.io/CloseCAPGMP/ chạy 100% trên Cloudflare (D1 + R2 + Workers). Không còn Supabase ở bất kỳ đâu trong repo (thư mục `supabase/`, `vendor/supabase.js`, `cloudflare/frontend-ready/`, `THIRD_PARTY_NOTICES.md` đã xoá — commit riêng, xem `git log`). Dự án Supabase trên cloud (nếu người dùng chưa tự xoá qua Dashboard của họ) là tài nguyên ngoài repo, không thuộc phạm vi theo dõi ở đây.

- **Hạ tầng**: D1 `gmp-closegap-db`, R2 `gmp-mediasave`, Worker `gmp-closegap-api` (`https://gmp-closegap-api.dangthanhbinh53.workers.dev`), tất cả trên tài khoản Cloudflare `dangthanhbinh53@gmail.com`.
- **Code Worker**: `cloudflare/worker/src/*.js` — port đủ 17 rule nghiệp vụ của `gmp_save_record` cũ, cộng auth tự xây (PBKDF2 100.000 vòng lặp — mức trần cứng của Workers, không có trong tài liệu Cloudflare, phát hiện qua test thật) + JWT tự ký. Chi tiết lệnh thao tác: [cloudflare/README.md](cloudflare/README.md).
- **Frontend**: [cloud.js](cloud.js) + [config.js](config.js) ở gốc repo LÀ bản Cloudflare — không còn thư mục `frontend-ready` riêng, gắn thẳng vào `index.html` production.
- **Dữ liệu thật đã chuyển xong**: 20 tài khoản (từ CSV người dùng cung cấp, mỗi người mật khẩu mới — mật khẩu Supabase Auth cũ không thể xuất/migrate, giới hạn kỹ thuật đã thống nhất trước với người dùng) + toàn bộ Finding/Action phục hồi từ backup JSON xuất ra từ hệ Supabase cũ trước khi cắt chuyển.
- **Đã sửa 1 sự cố production thật sau cắt chuyển** — xem mục 1.

## 1. Sự cố đã xử lý: retry-storm do `errcode='40001'`

Người dùng báo lỗi thật xảy ra trên hệ Supabase cũ (30/09, 15:20–18:40): CPU Supabase 99%, tỷ lệ lưu thành công 0%, log tăng >1GB trong vài giờ. Nguyên nhân: hàm `gmp_save_record` raise exception xung đột nghiệp vụ (revision lệch) bằng `errcode='40001'` — đây là mã PostgREST/Postgres coi là "an toàn để tự động thử lại", nên PostgREST tự lặp lại request đó liên tục (~100 lần/giây) khi client vẫn còn cố lưu, gây bão retry.

Đã rà soát và xử lý cả 2 phía:
- **Cloudflare (hệ đang chạy thật)**: xác nhận **không thể xảy ra lỗi này** — kiến trúc không có tầng PostgREST tự động retry theo `errcode`; xung đột revision được Worker phát hiện qua kiểm tra `changes===0` sau UPDATE có điều kiện, trả về `409` một lần duy nhất, không có cơ chế nào tự lặp lại. Dù vậy vẫn phát hiện và vá một lỗ hổng liên quan trong `cloud.js`: trước đó push thất bại (bất kỳ lý do gì) sẽ bị vòng lặp đồng bộ nền 60s thử lại vô thời hạn không phân biệt loại lỗi. Đã sửa [cloud.js](cloud.js): thêm state `blocked` (song song `conflicts`), `apiCall()` giờ chỉ tự retry lỗi mạng/5xx (tối đa 5 lần, backoff 2s/4s/8s/16s/32s), lỗi `409` → xung đột (không tự gửi lại), lỗi `400/401/403` → đưa vào `blocked` và dừng, không lặp vô hạn.
- **`supabase/` (đã xoá khỏi repo, chỉ còn trong lịch sử git)**: từng xác nhận `errcode='40001'` có mặt trong `schema.sql` và migration `20260915_user_management.sql`, đã vá cả hai bằng mã lỗi tuỳ chỉnh (`PT409`/`PT403`/`PT400`, không nằm trong danh sách mã PostgREST tự retry) trước khi các file này bị xoá khỏi repo trong đợt dọn dẹp 5S (mục 2) — chỉ có giá trị tham khảo lịch sử/rollback, không ảnh hưởng hệ đang chạy.

## 2. Dọn dẹp 5S (2026-09-30) — xoá toàn bộ Supabase khỏi repo

Sau khi xác nhận Cloudflare ổn định, đã dọn sạch mọi tàn dư Supabase khỏi repo:
- Xoá: `supabase/` (schema, migrations, Edge Function, `.temp/*`), `vendor/supabase.js`, `cloudflare/frontend-ready/` (đã gộp vào gốc repo từ lâu, thư mục staging không còn cần), `THIRD_PARTY_NOTICES.md` (chỉ có nội dung license SDK Supabase, không dùng SDK ngoài nào nữa nên không cần file thông báo).
- Sửa các comment/text còn trỏ tới đường dẫn đã xoá: [config.js](config.js), [cloudflare/worker/src/records.js](cloudflare/worker/src/records.js), [cloudflare/worker/src/admin.js](cloudflare/worker/src/admin.js), [index.html](index.html) (8 chỗ text "Supabase" hiển thị cho người dùng → "Cloudflare").
- Viết lại hoàn toàn [README.md](README.md) (chỉ còn hướng dẫn Cloudflare) và [cloudflare/README.md](cloudflare/README.md) (rút gọn thành ghi chú lệnh thao tác nhanh, trỏ về README gốc).

## 3. Kiến trúc file hiện tại

- [index.html](index.html): giao diện + toàn bộ logic nghiệp vụ, không đổi cấu trúc so với bản gốc ngoài phần liên quan cloud/login.
- [cloud.js](cloud.js): cầu nối Worker Cloudflare — xác thực (Username/Email + mật khẩu), đồng bộ incremental theo `revision`/`updated_at`, upload ảnh gốc R2, Data & Egress Control, retry có phân loại lỗi (mục 1).
- [config.js](config.js): chỉ `apiBaseUrl` công khai trỏ Worker.
- `cloudflare/worker/`: toàn bộ backend — `schema.sql` (D1), `src/*.js` (Worker), `wrangler.toml`, `create-first-admin.mjs`.

## 4. Lịch sử trước cắt chuyển (Supabase, tham khảo — không còn áp dụng)

Trước 2026-09-30 dự án chạy trên Supabase (Postgres + Auth + Storage + Edge Function + pg_cron), từng trải qua: tối ưu tốc độ đăng nhập, đồng bộ incremental, lưu mật khẩu trình duyệt, đổi sang Username-login cho tầng User (hack email nội bộ `<username>@<project-ref>.users.internal`), cân nhắc rồi loại bỏ phương án Anonymous Sign-in, đổi project Supabase 2 lần, và thêm tính năng Data & Egress Control. Toàn bộ chi tiết kỹ thuật của giai đoạn này chỉ còn trong `git log` (trước commit xoá `supabase/`), không còn phản ánh trạng thái repo hiện tại nên không chép lại ở đây.

## 5. Việc cần làm khi tiếp tục

Không có việc dở dang nào từ đợt dọn dẹp này. Nếu tiếp tục phát triển: đọc README.md mục tương ứng trước khi sửa, và nhớ nguyên tắc retry đã thống nhất ở mục 1 (409/400/401/403 không bao giờ tự gửi lại; chỉ mạng/5xx mới retry, tối đa 5 lần) khi đụng tới bất kỳ logic gọi API nào trong `cloud.js`.
