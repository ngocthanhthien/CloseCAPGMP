# Ghi chú kỹ thuật — Worker Cloudflare

Hướng dẫn setup đầy đủ (D1/R2/Worker, tạo Admin, biến môi trường) nằm ở [../README.md](../README.md). File này chỉ ghi các lệnh thao tác nhanh khi phát triển/bảo trì phần backend.

## Cấu trúc

- [worker/wrangler.toml](worker/wrangler.toml) — binding D1 (`DB`)/R2 (`MEDIA`), `ALLOWED_ORIGINS`, Cron Trigger.
- [worker/schema.sql](worker/schema.sql) — schema D1: `users`, `gmp_records`, `gmp_audit`, `gmp_traffic_daily`.
- [worker/src/](worker/src/) — `index.js` (router + cron), `auth.js`, `records.js`, `admin.js`, `media.js`, `traffic.js`, `audit.js`, `util.js`.
- [worker/create-first-admin.mjs](worker/create-first-admin.mjs) — script tạo tài khoản Admin đầu tiên.

## Lệnh thao tác nhanh

```bash
cd cloudflare/worker
npx wrangler deploy                    # deploy lại Worker sau khi sửa code trong src/
npx wrangler d1 execute gmp-closegap-db --remote --command "SQL..."   # chạy SQL trực tiếp trên D1 thật
npx wrangler tail                      # xem log Worker theo thời gian thực
npx wrangler secret put JWT_SECRET     # đổi secret ký JWT (sẽ làm mọi phiên đăng nhập cũ hết hạn ngay)
```

Đổi domain GitHub Pages hoặc thêm domain riêng: sửa `ALLOWED_ORIGINS` trong [worker/wrangler.toml](worker/wrangler.toml) (danh sách phân cách bằng dấu phẩy), rồi `wrangler deploy` lại.

## Đã cắt chuyển hoàn toàn (2026-09-30)

Site thật đã chạy Cloudflare, không còn Supabase. Chi tiết migration, incident đã xử lý, và tình trạng hiện tại: [../HANDOFF_WEB.md](../HANDOFF_WEB.md).
