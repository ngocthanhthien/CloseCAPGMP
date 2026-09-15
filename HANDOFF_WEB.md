# Handoff bản web — 2026-09-14

Yêu cầu đã chốt: GitHub Pages + Supabase, bắt buộc đăng nhập. Người dùng chưa tạo repository hoặc project.

- `index.html`: giao diện + code nghiệp vụ từ bản offline, đã loại tài khoản/mật khẩu nhúng, đồng bộ thư mục và tự boot. Không chỉnh bản gốc.
- `cloud.js`: auth gate, kiểm tra membership, bridge IndexedDB, optimistic concurrency, polling, Storage ảnh gốc, backup/import không nhập mật khẩu.
- `config.js`: Project URL/publishable key hiện trống. Không đặt service role trong frontend.
- `supabase/schema.sql`: migration cho project mới. `gmp_records` chỉ cho đọc với RLS; ghi qua RPC `gmp_save_record` kiểm tra quyền và revision. `gmp_members` phải cấp thủ công từ dashboard/SQL. `gmp_audit` ghi bởi server trong cùng transaction. Storage private.
- `vendor/supabase.js`: SDK đóng gói local, không phụ thuộc CDN. Phiên bản 2.116.0; xem THIRD_PARTY_NOTICES.md.

Chưa làm: tạo tài nguyên thật, điền config, cấp Admin đầu tiên, upload/publish, kiểm tra đồng bộ hai máy với Supabase thật. Không tuyên bố bản này đã được publish.

Trong workspace bên ngoài gói ready: `scripts/prepare_web.py` tái tạo index từ HTML gốc; `scripts/bundle.mjs` đóng gói SDK; `scripts/test-database.mjs` và `scripts/test-browser.mjs` kiểm tra backend/bridge. Khi sửa index trực tiếp, cần cập nhật prepare_web.py tương ứng để lần chạy sau không ghi mất sửa đổi.
