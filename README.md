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
- Lưu sau khoảng 1,5 giây ngừng nhập; lấy dữ liệu từ máy khác mỗi 30 giây khi không nhập liệu. Nút Đồng bộ dùng khi muốn lấy/gửi ngay. Đây là polling, không phải realtime subscription.
- Mỗi trình duyệt chỉ một tab chỉnh sửa cho cùng tài khoản/project. Bản chờ trên máy tách theo project và tài khoản, lưu cùng phiên bản máy chủ trong một giao dịch IndexedDB.
- Bản chờ giữ khi mất mạng; sau tải lại cần xác thực online để mở app. Không xóa cache trình duyệt nếu còn thay đổi chưa gửi. Không cam kết mở offline từ đầu.
- Xung đột không tự chọn bên thắng: tải hai bản để đối chiếu, chọn bản máy chủ, sau đó nhập lại thay đổi cần giữ. Bản chờ không tự ghi đè máy chủ.
- Ảnh nén lưu dạng data URL trong JSONB để báo cáo Excel/HTML và backup vẫn hoạt động. Tối đa 20 MB mỗi Finding. Đây là lựa chọn tương thích cho quy mô nội bộ, chưa tối ưu cho kho ảnh rất lớn; mỗi lượt đồng bộ đọc toàn bộ bản ghi theo trang 100.
- Ảnh gốc mới được tải riêng vào bucket private `gmp-mediasave`, tối đa 20 MiB/file; có thông báo khi lỗi. Tải ảnh gốc không có hàng đợi bền vững qua lần đóng trang: nếu tải thất bại, giữ file gốc và chọn lại ảnh khi mạng ổn định. Gỡ ảnh trong Finding không xóa bản sao gốc.
- Nhật ký do máy chủ tự ghi với danh tính xác thực, hiển thị 1.000 mục gần nhất. Dữ liệu máy chủ vẫn giữ nhật ký cũ. Dấu xoá giữ bản cũ trong database để tránh hồi sinh dữ liệu và hỗ trợ quản trị khôi phục.
- Đồng bộ thư mục, dọn file thiết bị cũ, mốc ngắt đồng bộ, tài khoản/mật khẩu local được thay thế trong bản web. Bản offline gốc giữ nguyên.
- CSV vẫn xuất toàn bộ dữ liệu như bản gốc. Excel/HTML giữ các bộ lọc hiện có. Email chỉ tạo file .eml để người dùng tự kiểm tra/gửi trong Outlook.

## Kiểm tra trước bàn giao

SQL được thực thi trong PostgreSQL WASM (PGlite) với schema Auth/Storage mô phỏng: đã kiểm tra quyền khách, người ngoài, nhân viên/Admin, revision conflict, xoá/khôi phục, ảnh không hợp lệ, ghi nhật ký.
Luồng trình duyệt được kiểm tra bằng jsdom + IndexedDB mô phỏng + Supabase mock: đăng nhập, khởi động, lưu, mất mạng/tải lại, giữ xung đột và chọn bản máy chủ.
Chưa kiểm thử end-to-end với Supabase/GitHub thật vì chưa có project/repository.

Tài liệu chính thức: [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site), [Supabase Auth](https://supabase.com/docs/guides/auth/passwords), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).
