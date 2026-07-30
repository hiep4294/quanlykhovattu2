# Quản lý kho nội bộ KODSDOOR V5.8.2 — Cloudflare D1

Bản này giữ nguyên giao diện và nghiệp vụ của phần mềm trong file
`Phan_mem_quan_ly_kho_noi_bo_KODSDOOR_V5_8_1_CO_KEO_COT_HANG_KHI_IN.zip`.
Chỉ thay máy chủ Python/SQLite cục bộ bằng:

- Cloudflare Worker: API và xác thực.
- Cloudflare D1: dữ liệu kho dùng chung và ảnh vật tư đã nén.
- Workers Static Assets: giao diện HTML/CSS/JS gốc.

Bản V5.8.2 không dùng R2, vì vậy tài khoản Cloudflare miễn phí không cần kích
hoạt R2 hoặc thêm thẻ thanh toán.

## Chức năng được giữ nguyên

- Đăng nhập, phân quyền quản trị/thủ kho/chỉ xem.
- Danh mục, hình ảnh, tồn kho, đơn giá và giá trị tồn.
- Đối tác/bộ phận, phiếu nhập–xuất, in phiếu.
- Sổ kho, báo cáo, xuất CSV.
- Cài đặt công ty, người dùng, nhật ký thao tác.
- Sao lưu và phục hồi JSON.
- Đồng bộ thay đổi giữa điện thoại và PC.

Migration `0003_seed_items.sql` chứa đủ 219 mã vật tư của cơ sở dữ liệu gốc.

## Triển khai tự động từ GitHub

Trong repository, mở **Settings → Secrets and variables → Actions** và tạo:

| Secret | Nội dung |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | Account ID của Cloudflare |
| `CLOUDFLARE_API_TOKEN` | API token có quyền Workers và D1 |
| `ADMIN_PASSWORD` | Mật khẩu ban đầu cho tài khoản `admin` |
| `KEEPER_PASSWORD` | Mật khẩu ban đầu cho tài khoản `thukho` |
| `VIEWER_PASSWORD` | Mật khẩu ban đầu cho tài khoản `xem` |

Sau đó vào **Actions → Deploy Cloudflare Worker → Run workflow**.
Wrangler tự tạo D1 ở lần triển khai đầu, áp dụng migration rồi xuất bản Worker.
Không cần điền thủ công `database_id` và không cần tạo R2 Bucket.

Không ghi API token hoặc mật khẩu trực tiếp vào repository.
Nếu đang nâng cấp từ bản R2 bị lỗi, xem `CAP_NHAT_KHONG_R2.md`.

## Chạy và kiểm tra cục bộ

```bash
npm ci
cp .dev.vars.example .dev.vars
npm run db:local
npm run dev
```

Kiểm thử toàn bộ luồng chính:

```bash
npm test
```

Tài liệu tham chiếu:

- [Cloudflare tự động tạo tài nguyên từ binding](https://developers.cloudflare.com/changelog/post/2025-10-24-automatic-resource-provisioning/)
- [Cloudflare Workers với GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [Lệnh migration D1](https://developers.cloudflare.com/d1/wrangler-commands/)
- [Giới hạn D1](https://developers.cloudflare.com/d1/platform/limits/)

## Lưu ý vận hành

- Đổi mật khẩu mặc định ngay sau lần đăng nhập đầu.
- Tải file **Sao lưu** định kỳ.
- Trình duyệt tự nén ảnh thành WebP tối đa 300 KB rồi lưu trong bảng riêng của
  D1; giao diện tải/xem/xóa ảnh giữ nguyên.
- File sao lưu JSON không chứa dữ liệu nhị phân của ảnh. Khi phục hồi trên cùng
  cơ sở dữ liệu, ảnh của các vật tư có cùng mã nội bộ vẫn được giữ lại.
- D1 miễn phí có giới hạn 500 MB. Nên chỉ dùng ảnh minh họa cần thiết và xóa ảnh
  cũ không còn sử dụng.
