# GMP Close Gap — GitHub Pages + Cloudflare

App quản lý ghi nhận Finding & đóng Gap GMP theo khu vực (ILD Coffee Vietnam). Frontend host tĩnh trên **GitHub Pages**; toàn bộ backend (dữ liệu, xác thực, ảnh gốc, dọn dẹp định kỳ) chạy trên **Cloudflare** (D1 + R2 + Workers + Cron Triggers). Site thật: https://ngocthanhthien.github.io/CloseCAPGMP/

> Dự án trước đây dùng Supabase — đã chuyển hẳn sang Cloudflare (2026-09-30), không còn phụ thuộc Supabase. Xem [HANDOFF_WEB.md](HANDOFF_WEB.md) nếu cần lịch sử di chuyển.

## 1. Tạo hạ tầng Cloudflare

Cần [Node.js](https://nodejs.org) và tài khoản Cloudflare (miễn phí đủ dùng cho quy mô nội bộ).

```bash
cd cloudflare/worker
npx wrangler login                                  # mở trình duyệt xác thực, chỉ cần làm 1 lần
npx wrangler d1 create gmp-closegap-db               # tạo database — copy database_id in ra
npx wrangler r2 bucket create gmp-mediasave          # tạo bucket lưu ảnh gốc, riêng tư
```

Dán `database_id` vừa tạo vào [`wrangler.toml`](cloudflare/worker/wrangler.toml) (mục `[[d1_databases]]`). Nếu dùng domain GitHub Pages khác, sửa `ALLOWED_ORIGINS` trong cùng file (danh sách origin được phép gọi API, phân cách bằng dấu phẩy — chỉ scheme+host, không path).

```bash
npx wrangler d1 execute gmp-closegap-db --remote --file=schema.sql   # tạo 4 bảng: users, gmp_records, gmp_audit, gmp_traffic_daily
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))" | npx wrangler secret put JWT_SECRET   # sinh khoá ký JWT ngẫu nhiên
npx wrangler deploy                                  # deploy Worker — in ra URL dạng https://gmp-closegap-api.<tài-khoản>.workers.dev
```

Ghi lại URL Worker vừa deploy — cần điền vào `config.js` ở bước 2.

## 2. Tạo GitHub repository và publish

1. Tạo repository trên GitHub, `index.html` phải nằm ngay thư mục gốc.
2. Upload `index.html`, `cloud.js`, `config.js`, `.nojekyll` lên repo (không cần thư mục `vendor`/`supabase` — không còn phụ thuộc SDK ngoài nào).
3. Điền `config.js`:
   ```js
   window.GMP_CONFIG = Object.freeze({
     apiBaseUrl: "https://gmp-closegap-api.<tài-khoản-cloudflare>.workers.dev"
   });
   ```
4. Settings → Pages → Build and deployment → Deploy from a branch → `main`, `/ (root)` → Save.
5. Chờ GitHub Pages triển khai xong. Mở link bằng cửa sổ riêng tư phải thấy màn hình đăng nhập; tạo Admin đầu tiên (mục 5), đăng nhập, tạo Finding thử, mở trên thiết bị thứ hai để xác nhận đồng bộ.

GitHub Pages chỉ host giao diện tĩnh. Cloudflare Worker mới lưu dữ liệu, xác thực và kiểm tra quyền (JWT + kiểm tra `disabled`/`role` tươi từ D1 mỗi request — không có RLS khai báo như Postgres, mọi quyền được Worker tự kiểm tra tường minh trong code, xem `cloudflare/worker/src/`).

## 3. Chuyển dữ liệu từ app cũ (offline hoặc Supabase)

- Mở bản cũ trên đúng trình duyệt đang giữ dữ liệu, dùng Admin xuất bản sao lưu JSON (nút **⬇️ Tải bản sao lưu**).
- Đăng nhập Admin ở bản Cloudflare → Cài đặt → **⬆️ Phục hồi từ file .json**. App tải một bản sao lưu trước khi nhập.
- Nhập là **gộp theo ID**: Finding cùng ID lấy nội dung file, Finding khác giữ nguyên. Bản ghi cùng ID vừa đổi trên máy khác sẽ báo xung đột, không tự ghi đè.
- Tài khoản/mật khẩu và nhật ký cũ **không** tự chuyển thành tài khoản/nhật ký máy chủ — tạo lại thủ công (mục 5). Ảnh nén có trong JSON được chuyển cùng Finding. Ảnh gốc lưu trong Storage/R2 cũ cần giữ bản sao riêng; app không tự quét/di chuyển.
- Chỉ coi là hoàn tất khi thanh trạng thái báo **Đã đồng bộ** và kiểm tra trên thiết bị thứ hai.

## 4. Hành vi và giới hạn

- Nhân viên: xem dữ liệu chung, tạo Finding, thêm/sửa/xoá Action Open, gửi Pending khi có ảnh. Action Pending/Closed được khoá với nhân viên. Admin: sửa Finding/cài đặt, duyệt/từ chối/mở lại và đánh dấu xoá.
- Finding mới tối đa một Action. Admin được nhập Finding lịch sử có nhiều Action; không được tăng thêm số Action của Finding đã có nhiều Action.
- Lưu sau khoảng 1,5 giây ngừng nhập; lấy dữ liệu từ máy khác mỗi 60 giây khi không nhập liệu. Nút Đồng bộ dùng khi muốn lấy/gửi ngay. Đây là polling, không phải realtime subscription. Vòng lấy dữ liệu tự động mỗi 60 giây chỉ tải bản ghi thay đổi kể từ lần đồng bộ trước (dựa trên `updated_at`), không tải lại toàn bộ dữ liệu mỗi lần. Lần đăng nhập đầu tiên trên một máy hoặc bấm nút Đồng bộ thủ công vẫn tải đầy đủ để đối chiếu (safety net); mạng vừa nối lại chỉ đồng bộ phần thay đổi như vòng nền (giới hạn tối đa 1 lần/phút).
- Mỗi trình duyệt chỉ một tab chỉnh sửa cho cùng tài khoản. Bản chờ trên máy lưu cùng phiên bản máy chủ trong một giao dịch IndexedDB.
- Bản chờ giữ khi mất mạng; sau tải lại cần xác thực online để mở app. Không xóa cache trình duyệt nếu còn thay đổi chưa gửi.
- Xung đột không tự chọn bên thắng: tải hai bản để đối chiếu, chọn bản máy chủ, sau đó nhập lại thay đổi cần giữ. Bản chờ không tự ghi đè máy chủ.
- **Xử lý lỗi khi đồng bộ** (rút ra từ một sự cố thật — xem [HANDOFF_WEB.md](HANDOFF_WEB.md)): lỗi xung đột (409) và lỗi quyền/dữ liệu (400/401/403) **không bao giờ tự gửi lại** — chỉ báo cho người dùng, chờ thao tác thủ công. Chỉ lỗi mạng/máy chủ (5xx) mới tự thử lại, tối đa 5 lần, giãn cách tăng dần (2s/4s/8s/16s/32s).
- Ảnh nén lưu dạng data URL ngay trong bản ghi Finding/Action (D1) để báo cáo Excel/HTML và backup vẫn hoạt động độc lập. Tối đa 20 MB mỗi Finding.
- Ảnh gốc tải riêng vào bucket private R2 `gmp-mediasave` (không tính phí băng thông tải xuống), tối đa 20 MiB/file. Khi traffic vượt ngưỡng (mục 9, Data & Egress Control ở trạng thái Protection), ảnh gốc được xếp hàng chờ (`Pending Media`) thay vì huỷ — ảnh nén trong Finding vẫn lưu bình thường, không mất dữ liệu.
- Nhật ký do máy chủ tự ghi với danh tính xác thực, hiển thị 20 mục gần nhất. Chỉ tải lại khi bấm Đồng bộ thủ công, lúc đăng nhập, hoặc khi đang mở đúng tab Data Input Log. Máy chủ tự động xoá mục cũ hơn 7 ngày (Cron Trigger, xem mục 6).
- CSV vẫn xuất toàn bộ dữ liệu. Excel/HTML giữ các bộ lọc hiện có. Email chỉ tạo file .eml để người dùng tự kiểm tra/gửi trong Outlook.

## 5. Quản lý người dùng

Không có form tự đăng ký — tài khoản đầu tiên tạo bằng script, các tài khoản sau Admin tự tạo trong app.

### 5.1. Tạo Admin đầu tiên

```bash
cd cloudflare/worker
node create-first-admin.mjs "ten_dang_nhap_hoac_email" "mat_khau" "Họ và tên"
```
Script in ra lệnh `wrangler d1 execute` — copy chạy trong cùng thư mục để tạo tài khoản.

### 5.2. Quản lý từ trong app

Đăng nhập Admin → tab **👥 Quản lý người dùng**:
- **➕ Thêm người dùng**: chọn vai trò User hiện ô **Tên đăng nhập** (chữ thường/số, có thể chứa `. _ -`); vai trò Admin hiện ô **Email**. Cả hai chỉ là `login_id` lưu thẳng trong D1 — không có hack email nội bộ nào (khác Supabase Auth, D1 không bắt buộc định dạng email).
- **Nâng lên Admin / Hạ xuống User**, **Vô hiệu hóa / Kích hoạt**: đổi ngay lập tức, có chặn tự hạ quyền nếu là Admin hoạt động cuối cùng và chặn tự khoá chính mình.
- Mọi thao tác đi qua route `/admin/users/*` trong cùng Worker đã deploy ở mục 1 — không cần deploy riêng gì thêm khi thêm/sửa tài khoản.

## 6. Dọn dẹp dữ liệu cũ tự động (Cron Trigger)

`gmp_audit` (nhật ký, giữ 7 ngày) và `gmp_traffic_daily` (số liệu Egress theo ngày, giữ 14 ngày) tự động dọn hằng ngày lúc 03:00 UTC — khai báo sẵn trong [`wrangler.toml`](cloudflare/worker/wrangler.toml) (`[triggers]`), chạy trong `scheduled()` của [`src/index.js`](cloudflare/worker/src/index.js). Không cần thiết lập gì thêm — có hiệu lực ngay khi `wrangler deploy`.

## 7. Đồng bộ tăng trưởng (Incremental Sync)

Vòng đồng bộ nền mỗi 60 giây chỉ tải bản ghi có `updated_at` mới hơn lần đồng bộ gần nhất (index sẵn trong `schema.sql`), thay vì tải lại toàn bộ `gmp_records` mỗi lần — giảm mạnh số row D1 phải đọc và dung lượng truyền khi dữ liệu đã lớn. Lần đầu trên máy mới, bấm Đồng bộ thủ công, hoặc mạng vừa nối lại vẫn đối chiếu đầy đủ để tự sửa sai lệch nếu có.

## 8. Đăng nhập bằng Tên đăng nhập hoặc Email

Nhân viên đăng nhập bằng **Tên đăng nhập + mật khẩu**; Admin có thể dùng Tên đăng nhập hoặc **Email + mật khẩu** — cả hai chỉ là `login_id` lưu trực tiếp trong bảng `users` (D1), không có hack quy đổi email nội bộ nào (đó chỉ là giải pháp bắt buộc hồi còn dùng Supabase Auth). Mật khẩu băm bằng **PBKDF2-SHA256, 100.000 vòng lặp** (mức trần cứng của Cloudflare Workers — Web Crypto ở đây từ chối số vòng lặp cao hơn) qua Web Crypto, không dùng thư viện ngoài.

Phiên đăng nhập là JWT tự ký (HS256, hạn 30 ngày) — nhưng token chỉ chứng minh danh tính, **mọi request đều tự tra lại `disabled`/`role` tươi từ D1**, nên khoá tài khoản có hiệu lực ngay lập tức bất kể token còn hạn.

## 9. Data & Egress Control

Admin tự kiểm soát lưu lượng app tạo ra mỗi ngày ngay trong app, tại **⚙️ Cài đặt → 🛡️ Data & Egress Control**. Có 3 trạng thái, tự động, không bao giờ khoá việc ghi nhận Finding/Action:

- **🟢 Normal** (traffic < Soft Limit): hoạt động như bình thường.
- **🟠 Data Saving** (Soft ≤ traffic < Hard): giãn vòng đồng bộ nền từ 60s lên 180s. Nghiệp vụ chính không đổi.
- **🔴 Protection** (traffic ≥ Hard + Extra hôm nay, trừ khi đang Unlock): dừng hẳn vòng đồng bộ nền, tạm dừng tải Data Input Log nền, và **tạm hoãn upload ảnh gốc** lên R2 (ảnh nén vẫn lưu trong Finding/Action bình thường — không mất ảnh, không mất Action, chỉ ảnh gốc chờ tải lên sau, xem `Pending Media` ở mục 4).

Soft/Hard Limit (mặc định 100/200 MB), bật/tắt Protection, "+ Extra MB Today" và "Unlock Today" đều là cấu hình chỉ Admin sửa được, đồng bộ tự động giữa các máy (nằm trong `SETTINGS`, ghi qua route `/records` vốn đã bắt buộc quyền Admin cho `kind='settings'`). **Extra MB** và **Unlock Today** chỉ có hiệu lực trong ngày hiện tại, tự hết hiệu lực khi sang ngày mới; Soft/Hard Limit giữ nguyên qua các ngày cho tới khi Admin đổi lại.

Traffic hiển thị là **ước tính riêng của app này** (đo qua kích thước request/response thật khi đồng bộ, không phải số liệu chính xác trên hoá đơn Cloudflare — lưu ý R2 không tính phí băng thông tải xuống, nên phần chi phí thực tế trên Cloudflare thường lệch sang số lượng request/row D1 hơn là băng thông), tổng hợp từ nhiều máy bằng cách mỗi máy tự báo cáo tổng byte của mình theo ngày (gộp vào nhịp đồng bộ có sẵn, không tạo request riêng chỉ để đo).

---

## Cấu trúc thư mục

- [index.html](index.html) — giao diện + toàn bộ logic nghiệp vụ (single-file, chuyển thể từ app offline).
- [cloud.js](cloud.js) — cầu nối tới Worker: xác thực, đồng bộ incremental, optimistic concurrency theo `revision`, upload ảnh gốc, Data & Egress Control.
- [config.js](config.js) — chỉ chứa `apiBaseUrl` công khai, không có khoá bí mật nào.
- `cloudflare/worker/` — mã nguồn Worker (`src/*.js`), schema D1 (`schema.sql`), cấu hình (`wrangler.toml`), script tạo Admin đầu tiên (`create-first-admin.mjs`).
- `cloudflare/README.md` — ghi chú kỹ thuật/lệnh thao tác nhanh cho riêng phần Worker.

## Kiểm tra trước bàn giao (gần nhất)

Đã kiểm thử trực tiếp trên hạ tầng Cloudflare thật (không phải giả lập): đăng nhập, tạo/sửa/xoá Finding qua UI thật, phát hiện xung đột revision, phân quyền Admin/User, upload ảnh lên R2, CORS đúng origin, toàn bộ 20 tài khoản thật đã tạo và đăng nhập được, 394 Finding đã phục hồi từ backup JSON. Chi tiết lịch sử di chuyển và các lần kiểm thử: [HANDOFF_WEB.md](HANDOFF_WEB.md).

Tài liệu chính thức: [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site), [Cloudflare Workers](https://developers.cloudflare.com/workers/), [Cloudflare D1](https://developers.cloudflare.com/d1/), [Cloudflare R2](https://developers.cloudflare.com/r2/).
