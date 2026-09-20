# GMP Close Gap — GitHub Pages + Supabase

Bản web được tạo từ app offline ngày 14/09/2026. Chưa kết nối project thật và chưa publish.
Chỉ upload **nội dung thư mục ready** vào repository; không upload HTML/handoff gốc vì có mật khẩu cũ.

## 1. Tạo Supabase

1. Đăng nhập https://supabase.com/dashboard và chọn New project. Đặt tên `gmp-closegap`, chọn khu vực gần Việt Nam. Tự đặt và giữ kín mật khẩu database.
2. Vào SQL Editor, chạy toàn bộ `supabase/schema.sql` **một lần trên project mới**. Script tạo bảng, phân quyền, hàm lưu dữ liệu và bucket ảnh riêng tư.
3. Vào Authentication → Users → Add user → Create new user. Tạo email/mật khẩu cho Admin đầu tiên và từng nhân viên. Không dùng lại mật khẩu nhúng trong bản offline.
4. Cấp quyền cho tài khoản bằng SQL dưới đây (thay email/tên thật). Mỗi người phải có tài khoản Authentication trước. Không có trong `gmp_members` thì không truy cập dữ liệu được, kể cả đăng ký thành công.

```sql
insert into public.gmp_members(user_id, display_name, role)
select id, 'Tên quản trị viên', 'admin'
from auth.users where lower(email) = lower('EMAIL_ADMIN_CUA_BAN')
on conflict(user_id) do update
set display_name=excluded.display_name, role=excluded.role;
```

Dùng role `'user'` cho nhân viên. Kiểm tra bảng `gmp_members` có dòng mới sau khi chạy. Chỉ quản trị viên có quyền dashboard/database được cấp/sửa vai trò; app không tự cấp Admin.

5. Vào Project Settings → API hoặc Connect để lấy **Project URL** và **publishable key** (`sb_publishable_...`, hoặc legacy anon key). Điền vào `config.js`. Tuyệt đối không dùng `sb_secret_...`, `service_role` hoặc database password trong mã nguồn.
6. Vào Authentication → URL Configuration: đặt Site URL bằng địa chỉ GitHub Pages sau khi publish. App dùng email/mật khẩu, không tự gửi thư mời hoặc email.
7. Nên tắt tự đăng ký mới trong Authentication nếu chỉ dùng tài khoản quản trị viên cấp.

## 2. Tạo GitHub repository và publish

1. Đăng nhập https://github.com/new, tạo repository tên `gmp-closegap` (hoặc tên bạn muốn).
2. Upload toàn bộ **nội dung bên trong** `ready`, giữ thư mục `vendor` và `supabase`. `index.html` phải nằm ngay ở thư mục gốc repository.
3. Vào Settings → Pages → Build and deployment → Deploy from a branch → chọn `main`, thư mục `/ (root)` → Save.
4. Chờ GitHub Pages triển khai xong. Link thường là `https://TEN_GITHUB.github.io/gmp-closegap/`; dùng link thực tế do GitHub hiển thị.
5. Kiểm tra: mở link bằng cửa sổ riêng tư phải thấy đăng nhập; đăng nhập Admin, tạo Finding thử, mở trên thiết bị thứ hai để xác nhận đồng bộ. Kiểm tra nhân viên không xác nhận/xoá Finding được.

GitHub Pages chỉ host giao diện tĩnh. Supabase mới lưu dữ liệu, xác thực và kiểm tra quyền. Mã giao diện có thể được tải xuống; quyền dữ liệu được thực thi trong database.

## 3. Chuyển dữ liệu từ app cũ

- Mở bản offline trên đúng trình duyệt đang giữ dữ liệu, dùng Admin xuất bản sao lưu JSON.
- Đăng nhập Admin ở bản web → Cài đặt → Phục hồi từ JSON. App tải một bản sao lưu trước khi nhập.
- Nhập là **gộp theo ID**: Finding cùng ID lấy nội dung file, Finding khác giữ nguyên. Bản ghi cùng ID vừa đổi trên máy khác sẽ báo xung đột, không tự ghi đè.
- Tài khoản/mật khẩu và nhật ký cũ không được nhập thành tài khoản/nhật ký máy chủ. Ảnh nén có trong JSON được chuyển cùng Finding. Ảnh gốc Mediasave cũ cần giữ bản sao riêng; app không tự quét/di chuyển thư mục cũ.
- Chỉ coi là hoàn tất khi thanh trạng thái báo **Đã đồng bộ Supabase** và kiểm tra trên thiết bị thứ hai.

## 4. Hành vi và giới hạn

- Nhân viên: xem dữ liệu chung, tạo Finding, thêm/sửa/xoá Action Open, gửi Pending khi có ảnh. Action Pending/Closed được khoá với nhân viên. Admin: sửa Finding/cài đặt, duyệt/từ chối/mở lại và đánh dấu xoá.
- Finding mới tối đa một Action. Admin được nhập Finding lịch sử có nhiều Action; không được tăng thêm số Action của Finding đã có nhiều Action.
- Lưu sau khoảng 1,5 giây ngừng nhập; lấy dữ liệu từ máy khác mỗi 60 giây khi không nhập liệu. Nút Đồng bộ dùng khi muốn lấy/gửi ngay. Đây là polling, không phải realtime subscription. Vòng lấy dữ liệu tự động mỗi 60 giây chỉ tải bản ghi thay đổi kể từ lần đồng bộ trước (dựa trên `updated_at`), không tải lại toàn bộ dữ liệu mỗi lần — giảm dung lượng và thời gian đáng kể khi đã có nhiều Finding. Lần đăng nhập đầu tiên trên một máy hoặc bấm nút Đồng bộ thủ công vẫn tải đầy đủ để đối chiếu (safety net). Mạng vừa nối lại (wifi chập chờn, máy vừa thức dậy) chỉ đồng bộ phần thay đổi như vòng nền, không tải lại toàn bộ — để tránh tải lại mọi ảnh nhúng mỗi lần mạng gián đoạn rồi nối lại; có giới hạn tối đa 1 lần/phút để không dồn dập khi mạng chập chờn liên tục.
- Mỗi trình duyệt chỉ một tab chỉnh sửa cho cùng tài khoản/project. Bản chờ trên máy tách theo project và tài khoản, lưu cùng phiên bản máy chủ trong một giao dịch IndexedDB.
- Bản chờ giữ khi mất mạng; sau tải lại cần xác thực online để mở app. Không xóa cache trình duyệt nếu còn thay đổi chưa gửi. Không cam kết mở offline từ đầu.
- Xung đột không tự chọn bên thắng: tải hai bản để đối chiếu, chọn bản máy chủ, sau đó nhập lại thay đổi cần giữ. Bản chờ không tự ghi đè máy chủ.
- Ảnh nén lưu dạng data URL trong JSONB để báo cáo Excel/HTML và backup vẫn hoạt động. Tối đa 20 MB mỗi Finding. Đây là lựa chọn tương thích cho quy mô nội bộ, chưa tối ưu cho kho ảnh rất lớn: mỗi Finding thay đổi vẫn gửi/nhận trọn vẹn ảnh nhúng trong đó (không tách phần ảnh riêng), phân trang tối đa 100 bản ghi/lượt gọi.
- Ảnh gốc mới được tải riêng vào bucket private `gmp-mediasave`, tối đa 20 MiB/file; có thông báo khi lỗi. Tải ảnh gốc không có hàng đợi bền vững qua lần đóng trang: nếu tải thất bại, giữ file gốc và chọn lại ảnh khi mạng ổn định. Gỡ ảnh trong Finding không xóa bản sao gốc.
- Nhật ký do máy chủ tự ghi với danh tính xác thực, hiển thị 20 mục gần nhất. Chỉ tải lại khi bấm Đồng bộ thủ công, lúc đăng nhập, hoặc khi đang mở đúng tab Data Input Log — vòng lấy dữ liệu nền không tự tải lại nhật ký nếu không ai đang xem, để giảm dung lượng. Máy chủ tự động xoá mục cũ hơn 7 ngày bằng tác vụ định kỳ (`pg_cron`, xem mục 6). Dấu xoá Finding vẫn giữ bản cũ trong database để tránh hồi sinh dữ liệu và hỗ trợ quản trị khôi phục — không liên quan đến nhật ký thao tác.
- Đồng bộ thư mục, dọn file thiết bị cũ, mốc ngắt đồng bộ, tài khoản/mật khẩu local được thay thế trong bản web. Bản offline gốc giữ nguyên.
- CSV vẫn xuất toàn bộ dữ liệu như bản gốc. Excel/HTML giữ các bộ lọc hiện có. Email chỉ tạo file .eml để người dùng tự kiểm tra/gửi trong Outlook.

## 5. Thiết lập Quản lý Người dùng (Admin User Management Setup)

Chức năng Quản lý Người dùng cho phép Admin tạo tài khoản nhân viên, đổi vai trò (User ↔ Admin), và vô hiệu hóa/kích hoạt tài khoản trực tiếp trên giao diện web mà không cần thao tác thủ công trong Supabase Dashboard hay SQL Editor.

### 5.1. Chạy SQL Migration
Vào **Supabase Dashboard → SQL Editor**, mở file `supabase/migrations/20260915_user_management.sql`, copy toàn bộ nội dung và bấm **Run**.
Script này sẽ:
- Thêm cột `disabled` vào bảng `gmp_members`.
- Cập nhật các chính sách bảo mật RLS và hàm `gmp_save_record` để tự động chặn các tài khoản bị vô hiệu hóa.

### 5.2. Cách tạo tài khoản Admin đầu tiên (nếu chưa có)
Nếu hệ thống chưa có tài khoản Admin nào:
1. Vào **Authentication → Users → Add user → Create new user**, tạo email và mật khẩu cho Admin.
2. Vào **SQL Editor**, chạy lệnh sau (thay `EMAIL_ADMIN_CUA_BAN` và tên thật):
```sql
insert into public.gmp_members(user_id, display_name, role, disabled)
select id, 'Tên Quản Trị Viên', 'admin', false
from auth.users where lower(email) = lower('EMAIL_ADMIN_CUA_BAN')
on conflict(user_id) do update
set display_name=excluded.display_name, role='admin', disabled=false;
```

### 5.3. Triển khai Edge Function `admin-users`
Hệ thống sử dụng một Supabase Edge Function có tên `admin-users` (được lưu tại `supabase/functions/admin-users/index.ts`). Mọi thao tác đặc quyền được thực thi trên máy chủ và kiểm tra phân quyền độc lập.

**Các bước triển khai bằng dòng lệnh (Terminal / PowerShell):**
```bash
# 1. Đăng nhập tài khoản Supabase (chỉ cần làm lần đầu)
npx supabase login

# 2. Liên kết với project của bạn (thay mã project của bạn từ URL Supabase Dashboard)
npx supabase link --project-ref somfruwvvnnyyqwrxozh

# 3. Triển khai Edge Function
npx supabase functions deploy admin-users
```
*(Ghi chú: Các biến môi trường `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` được Supabase tự động cung cấp trong môi trường chạy của Edge Function, bạn không cần phải tự cấu hình).*

### 5.4. Kiểm tra hoạt động (Verification)
1. **Kiểm tra quyền Admin:** Đăng nhập bằng tài khoản Admin. Bạn sẽ thấy tab `👥 Quản lý người dùng` xuất hiện trên thanh điều hướng. Mở tab ra sẽ thấy danh sách toàn bộ người dùng hiện có.
2. **Kiểm tra Tạo người dùng:** Bấm nút `➕ Thêm người dùng`, điền Họ tên, Email, Mật khẩu (tối thiểu 6 ký tự), chọn vai trò `User` hoặc `Admin` và bấm `Tạo tài khoản`.
3. **Kiểm tra Đổi vai trò:** Bấm `Nâng lên Admin` hoặc `Hạ xuống User` ở cột Thao tác, xác nhận hộp thoại để hoàn tất.
4. **Kiểm tra Vô hiệu hóa:** Bấm `Vô hiệu hóa` để khóa tài khoản một nhân viên. Khi bị khóa, tài khoản đó không thể đăng nhập hoặc lưu dữ liệu; dữ liệu lịch sử và Audit Log vẫn được bảo toàn nguyên vẹn. Bấm `Kích hoạt` để mở khóa lại.
5. **Kiểm tra tài khoản User thường:** Đăng nhập bằng tài khoản vừa tạo (role = `user`). Tab `👥 Quản lý người dùng` hoàn toàn bị ẩn; nếu cố tình gõ lệnh `switchTab('users')` từ Console, hệ thống sẽ cảnh báo và chặn lại ngay lập tức.

## 6. Tự động xoá nhật ký thao tác cũ (Audit Log Retention)

Nhật ký thao tác (`gmp_audit`) không có quyền xoá từ trình duyệt (RLS chỉ cho `select`), để không ai — kể cả Admin qua giao diện — chỉnh sửa được lịch sử thao tác. Việc dọn dữ liệu cũ chạy định kỳ trên máy chủ bằng `pg_cron`.

Vào **Supabase Dashboard → SQL Editor**, mở file `supabase/migrations/20260916_audit_retention.sql`, copy toàn bộ nội dung và bấm **Run**. Script này sẽ:
- Tạo index trên cột `ts` để tăng tốc truy vấn/nhật ký.
- Bật extension `pg_cron` (nếu chưa bật).
- Lên lịch chạy hằng ngày lúc 03:00 UTC, xoá mọi mục nhật ký cũ hơn 7 ngày.

Có thể kiểm tra job đã chạy tại SQL Editor bằng `select * from cron.job;` và `select * from cron.job_run_details order by start_time desc limit 20;`.

## 7. Đồng bộ tăng trưởng (Incremental Sync)

Vòng đồng bộ nền mỗi 60 giây chỉ tải bản ghi có `updated_at` mới hơn lần đồng bộ gần nhất, thay vì tải lại toàn bộ `gmp_records` (kể cả ảnh nhúng) mỗi lần — giảm mạnh dung lượng và thời gian cho các lần đồng bộ định kỳ khi dữ liệu đã lớn. Lần đăng nhập đầu tiên trên một máy hoặc bấm nút Đồng bộ thủ công vẫn tải đầy đủ để tự đối chiếu, phòng trường hợp dữ liệu máy bị lệch — mạng vừa nối lại chỉ đồng bộ phần thay đổi (không tải lại toàn bộ) vì đây là tình huống xảy ra thường xuyên hơn nhiều (wifi chập chờn, máy ngủ/thức) và từng là nguồn tốn băng thông đáng kể khi tải lại mọi ảnh nhúng mỗi lần; giới hạn tối đa 1 lần/phút để tránh dồn dập khi mạng chập chờn liên tục.

Vào **Supabase Dashboard → SQL Editor**, mở file `supabase/migrations/20260917_incremental_sync.sql`, copy toàn bộ nội dung và bấm **Run**. Script này tạo index trên cột `updated_at` của `gmp_records` để truy vấn tăng trưởng nhanh.

## 8. Đăng nhập bằng Tên đăng nhập (không cần email cho User)

Nhân viên đăng nhập bằng **Tên đăng nhập + mật khẩu**, không cần địa chỉ email. Admin vẫn đăng nhập bằng **Email + mật khẩu** như trước. Đây vẫn là tài khoản Supabase Auth thật với mật khẩu riêng — không phải "chọn tên không cần mật khẩu" — mỗi thao tác vẫn truy vết đúng người thật vì Supabase Auth chỉ hỗ trợ đăng nhập bằng email/số điện thoại, tài khoản Tên đăng nhập được lưu với một email nội bộ tự sinh (`<tên_đăng_nhập>@<mã-project>.users.internal`, không gửi thư, không ai nhìn thấy hay gõ giá trị này) — trình duyệt tự quy đổi Tên đăng nhập sang email nội bộ này trước khi gọi Supabase.

**Cần làm:**
1. Vào **Supabase Dashboard → SQL Editor**, mở file `supabase/migrations/20260918_username_login.sql`, copy toàn bộ nội dung và bấm **Run**. Script này thêm cột `username` vào `gmp_members`.
2. Triển khai lại Edge Function đã cập nhật:
   ```bash
   npx supabase functions deploy admin-users
   ```
3. Vào tab **👥 Quản lý người dùng → ➕ Thêm người dùng**: chọn vai trò **User** sẽ hiện ô **Tên đăng nhập** (chữ thường/số, có thể chứa `. _ -`, không dấu/khoảng trắng) thay cho Email; chọn vai trò **Admin** vẫn hiện ô **Email** như cũ.
4. Tài khoản Admin/User đã tạo từ trước (bằng email) không bị ảnh hưởng, vẫn đăng nhập bằng email như cũ — script chỉ áp dụng cho tài khoản tạo mới bằng Tên đăng nhập.

---

## Kiểm tra trước bàn giao

SQL được thực thi trong PostgreSQL WASM (PGlite) với schema Auth/Storage mô phỏng: đã kiểm tra quyền khách, người ngoài, nhân viên/Admin, revision conflict, xoá/khôi phục, ảnh không hợp lệ, ghi nhật ký.
Luồng trình duyệt được kiểm tra bằng jsdom + IndexedDB mô phỏng + Supabase mock: đăng nhập, khởi động, lưu, mất mạng/tải lại, giữ xung đột và chọn bản máy chủ.
Chưa kiểm thử end-to-end với Supabase/GitHub thật vì chưa có project/repository.

Tài liệu chính thức: [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site), [Supabase Auth](https://supabase.com/docs/guides/auth/passwords), [Supabase Edge Functions](https://supabase.com/docs/guides/functions), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).

