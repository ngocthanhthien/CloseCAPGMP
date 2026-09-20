# Handoff bản web — cập nhật 2026-09-18

Bàn giao để tiếp tục chỉnh sửa bằng công cụ AI khác. Đọc file này trước, sau đó [README.md](README.md) để biết hướng dẫn setup/vận hành đầy đủ (từng mục có đánh số, đã cập nhật theo các thay đổi dưới đây).

## 1. Trạng thái dự án hiện tại

- **2026-09-20: đã CHUYỂN sang project Supabase mới** (project ref `somfruwvvnnyyqwrxozh`, thay cho project cũ `qrodjneqbfvgfisjvzwp`). `config.js` đã điền URL + publishable key của project mới. `supabase/.temp/*` (kể cả `project-ref`) trong repo vẫn còn trỏ project CŨ vì phiên AI không có quyền chạy `supabase login`/`link` (cần trình duyệt) — **người dùng cần tự chạy `npx supabase link --project-ref somfruwvvnnyyqwrxozh` trên máy họ** để các file `.temp` này (có tracked trong git) khớp với project đang dùng thật, trước khi deploy lại Edge Function.
- **Project mới cần thiết lập từ đầu**: chạy `schema.sql` rồi 3 migration `20260916`/`20260917`/`20260918` (bỏ qua `20260915` — nội dung đã nằm sẵn trong `schema.sql`), tạo lại Admin đầu tiên, deploy lại Edge Function `admin-users`, phục hồi dữ liệu Finding/Settings từ file backup JSON (tài khoản/mật khẩu KHÔNG tự chuyển qua, phải tạo lại thủ công). Xem hướng dẫn đầy đủ README.md mục 1, 5, 8.
- **Đã có GitHub repo**: `origin` trỏ tới `https://github.com/ngocthanhthien/CloseCAPGMP.git`, nhánh `main` đang track `origin/main`.
- **Chưa xác minh được** (không có quyền truy cập Supabase Dashboard từ phiên làm việc AI): trên project MỚI, migration nào đã thực sự chạy, Edge Function `admin-users` đã deploy chưa. Việc đầu tiên nên làm khi tiếp tục: vào Supabase Dashboard của project mới → SQL Editor, đối chiếu thủ công từng cột/hàm được liệt kê ở mục 2 để biết đã áp dụng tới migration nào.
- **Nợ tài liệu**: mục 2 bên dưới (lịch sử thay đổi) dừng ở phiên 09-18 — các phiên sau đó (tối ưu Egress: audit log giới hạn 20 dòng + tải theo nhu cầu, `member()` dùng `getSession()` thay `getUser()`, poll 60s, bỏ full-reload khi mạng nối lại; thêm phân quyền Tab cho User ở Cài đặt) **chưa được ghi lại ở đây** — cần đọc trực tiếp `git log`/diff để biết chi tiết nếu cần.

## 2. Lịch sử thay đổi theo phiên làm việc (mới nhất trước)

### Phiên 2026-09-16 → 09-18 (AI: Claude / Claude Code)

1. **Đăng nhập chậm** → tối ưu: gộp 2 lần gọi `member()` thành 1, hiển thị dữ liệu cache ngay thay vì chờ mạng, audit log giảm còn 100 dòng + tự xoá sau 7 ngày (`pg_cron`).
   → **Đã commit**: `d7e82fd` ("dd").
2. **Đồng bộ tốn dung lượng/thời gian** → sync nền 30s chuyển từ full-table-scan sang incremental (`changedRows(syncedAt)`, watermark theo `updated_at`); full reconciliation chỉ còn khi lần đầu mở máy mới / bấm Đồng bộ thủ công / mạng vừa nối lại.
   → **Đã commit**: `814b55e` ("d"). Migration: `supabase/migrations/20260917_incremental_sync.sql`.
3. **Lưu mật khẩu trình duyệt** → dùng Credential Management API (`navigator.credentials.store/get`) để Chrome/Edge hiện hộp thoại lưu mật khẩu cho form đăng nhập kiểu SPA (trước đó `preventDefault()` chặn heuristic mặc định của trình duyệt).
   → **Đã commit**: `333d04d`.
4. **Bỏ yêu cầu email, dùng Username cho User** — Admin vẫn Email+mật khẩu, User dùng Username+mật khẩu (Supabase Auth thật, map Username → email nội bộ tự sinh `<username>@<project-ref>.users.internal`, người dùng không thấy giá trị này). Form "Thêm người dùng" của Admin tự đổi giữa ô Username/Email theo Vai trò chọn.
   → **CHƯA COMMIT** — đang nằm trong working tree (xem mục 3). Migration: `supabase/migrations/20260918_username_login.sql` (thêm cột `username` vào `gmp_members`, chưa chắc đã chạy trên Supabase thật — xem mục 1).
5. **Đã cân nhắc và loại bỏ**: phương án bỏ hẳn đăng nhập cho tầng User, dùng Supabase Anonymous Sign-in + danh sách "roster" không mật khẩu (theo đúng mô hình đã dùng ở dự án `GMP_Score_App` tại `C:\Apps\GMP_Score_App`). Đã build đầy đủ (migration `gmp_is_member()`/`gmp_roster`/RPC 7 tham số, popover chọn tên, `ensureSession()`...) rồi **revert lại hoàn toàn** theo yêu cầu của người dùng ("giữ phiên bản cũ Supabase Auth cho tầng User"). **Không còn dấu vết trong code** — chỉ ghi lại ở đây để AI sau không đề xuất lại mà không biết đã cân nhắc. Nếu muốn làm lại, tham khảo README/schema thật của `C:\Apps\GMP_Score_App` (đã verify chạy được ở dự án đó) thay vì làm từ đầu.

## 3. Git — chính xác cái gì đã lên `origin/main` và cái gì chưa

```
git log --oneline -6
814b55e d                                                          ← origin/main hiện trỏ tới đây (cần tự git fetch để chắc chắn)
333d04d Save/autofill login credentials via Credential Management API
d7e82fd dd
cf0d725 2
e127db7 add
6a1618e Update config.js
```

**Working tree hiện KHÔNG sạch** — 4 file đang sửa dở (mục 2.4, Username-login), chưa commit:

```
 M README.md
 M cloud.js
 M index.html
 M supabase/functions/admin-users/index.ts
?? supabase/migrations/20260918_username_login.sql
```

Đây là các thay đổi **muốn giữ** (không phải nhánh ẩn danh đã bỏ ở mục 2.5). Nên `git add` + `git commit` các file này trước khi làm gì tiếp, để tránh mất việc nếu công cụ AI khác hoặc thao tác thủ công vô tình `git checkout`/`git reset`.

## 4. Kiến trúc file (không đổi so với bản gốc, chỉ cập nhật mô tả)

- [index.html](index.html): giao diện + code nghiệp vụ chuyển thể từ app offline. Không sửa cấu trúc gốc ngoài phần liên quan tới cloud/login.
- [cloud.js](cloud.js): cầu nối Supabase — xác thực (Email hoặc Username+mật khẩu), kiểm tra `gmp_members`, bridge IndexedDB, optimistic concurrency theo `revision`, đồng bộ incremental, Storage ảnh gốc, backup/import JSON.
- [config.js](config.js): Project URL + publishable key **đã điền thật**, không phải placeholder.
- `supabase/schema.sql` + `supabase/migrations/*.sql`: chạy `schema.sql` một lần đầu trên project mới, sau đó các migration theo thứ tự thời gian trong tên file. Xem mục 1 về việc xác minh đã chạy tới đâu trên project thật.
- `supabase/functions/admin-users/index.ts`: Edge Function service_role, quản lý tài khoản (tạo/đổi vai trò/vô hiệu hoá), gồm cả logic Username→email nội bộ (mục 2.4). Deploy bằng `npx supabase functions deploy admin-users`.
- `vendor/supabase.js`: SDK Supabase đóng gói local, bản 2.116.0, có hỗ trợ `signInAnonymously` (dùng thử ở mục 2.5, hiện không dùng) — xem THIRD_PARTY_NOTICES.md.

## 5. Việc cần làm khi tiếp tục

1. Quyết định: commit các thay đổi Username-login (mục 3) hay không, trước khi sửa thêm.
2. Xác minh migration nào đã chạy trên Supabase thật (mục 1) — đặc biệt `20260918_username_login.sql` (cột `username`) và Edge Function `admin-users` bản mới (có hỗ trợ tham số `username`) — nếu chưa chạy/deploy, tính năng Username-login trong code sẽ lỗi khi Admin thử tạo tài khoản User.
3. README.md đã cập nhật đầy đủ hướng dẫn setup theo từng mục — coi đó là nguồn chính, file này chỉ tóm tắt lịch sử/bàn giao.
