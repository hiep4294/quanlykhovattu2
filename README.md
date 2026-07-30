# Quản lý kho KODSDOOR V5.8.3 — Cloudflare Worker + D1

Bản web giữ nguyên giao diện và nghiệp vụ V5.8.2, nhưng sửa dứt điểm lỗi:

```text
A database with that name already exists
```

Quy trình triển khai mới tự tìm D1 `quanlykhovattu2-db`, lấy đúng Database ID
và tạo file cấu hình tạm trước khi chạy migration. Nếu D1 chưa tồn tại, hệ
thống tự tạo D1 tại khu vực APAC. Không xóa hoặc tạo lại cơ sở dữ liệu đang có.

## Thành phần

- Cloudflare Worker: API, đăng nhập và phân quyền.
- Cloudflare D1: dữ liệu kho và ảnh vật tư đã nén WebP tối đa 300 KB.
- Workers Static Assets: giao diện HTML/CSS/JavaScript.
- GitHub Actions: kiểm thử, liên kết D1, migration và triển khai.

Không dùng R2 nên không cần thẻ ngân hàng.

## Chức năng

- Đăng nhập; quyền quản trị, thủ kho và chỉ xem.
- 219 mã vật tư ban đầu.
- Danh mục, ảnh, tồn đầu, nhập, xuất, tồn hiện tại.
- Đơn giá và tổng giá trị tồn kho.
- Đối tác, nhà cung cấp, khách hàng và bộ phận nhận.
- Phiếu nhập/xuất, lịch sử phiếu và in phiếu.
- Sổ kho chi tiết từng vật tư.
- Báo cáo nhập–xuất–tồn theo khoảng thời gian và xuất CSV.
- Chặn xuất vượt tồn khi không cho phép tồn âm.
- Người dùng, nhật ký, sao lưu và phục hồi JSON.

## Triển khai bằng GitHub Actions

Tạo các GitHub Actions Secrets:

| Secret | Nội dung |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | Account ID của Cloudflare |
| `CLOUDFLARE_API_TOKEN` | Token có quyền Workers Scripts: Edit và D1: Edit |
| `ADMIN_PASSWORD` | Mật khẩu ban đầu của `admin`, tối thiểu 6 ký tự |
| `KEEPER_PASSWORD` | Mật khẩu ban đầu của `thukho`, tối thiểu 6 ký tự |
| `VIEWER_PASSWORD` | Mật khẩu ban đầu của `xem`, tối thiểu 6 ký tự |
| `SESSION_SECRET` | Tùy chọn, chuỗi ngẫu nhiên từ 32 ký tự |

Sau đó:

1. Upload toàn bộ nội dung thư mục này vào nhánh `main`.
2. Vào **Actions → Deploy Cloudflare Worker → Run workflow**.
3. Chờ bước `Resolve D1, migrate and deploy` hoàn thành.

Không cần nhập Database ID. Script `scripts/prepare-d1-config.mjs` tự lấy ID của
D1 đã tồn tại và dùng `--no-x-provision`, vì vậy Wrangler không tạo trùng D1.

## Nếu dùng Cloudflare Builds kết nối trực tiếp GitHub

Chỉ dùng **một** cách triển khai. Nếu chọn Cloudflare Builds:

- Build command: `npm ci && npm test`
- Deploy command: `npm run deploy:cloudflare`
- Đặt `ADMIN_PASSWORD`, `KEEPER_PASSWORD`, `VIEWER_PASSWORD` trong Build
  variables dạng Secret.
- Có thể đặt `D1_DATABASE_NAME=quanlykhovattu2-db`.

Không dùng deploy command cũ `npx wrangler deploy`, vì lệnh đó không thực hiện
bước nhận diện D1 bị bỏ dở từ lần triển khai có R2.

## Chạy cục bộ

```bash
npm ci
cp .dev.vars.example .dev.vars
npm run db:local
npm run dev
```

Mở `http://localhost:8787`.

Kiểm thử:

```bash
npm test
```

## Cấu hình `wrangler.jsonc`

Binding D1 trong file gốc cố ý không chứa Database ID:

```json
{
  "d1_databases": [
    {
      "binding": "DB",
      "migrations_dir": "migrations"
    }
  ]
}
```

Khi triển khai, ID chỉ được ghi vào
`wrangler.resolved.jsonc`; file này bị loại khỏi Git và không được đưa lên
GitHub. Có thể truyền sẵn ID bằng biến `CLOUDFLARE_D1_DATABASE_ID`, nhưng không
bắt buộc.

## Lưu ý

- Không xóa D1 `quanlykhovattu2-db`.
- Không đưa API token hoặc mật khẩu vào `wrangler.jsonc`.
- Đổi mật khẩu sau lần đăng nhập đầu.
- Tải bản sao lưu JSON định kỳ.
- Ảnh không nằm trong file sao lưu JSON; ảnh vẫn được giữ khi phục hồi trên cùng
  cơ sở dữ liệu.
