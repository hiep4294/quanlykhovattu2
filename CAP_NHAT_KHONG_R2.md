# Cập nhật bản Cloudflare không dùng R2

## Cách cập nhật repository GitHub

1. Giải nén file ZIP này.
2. Upload **toàn bộ nội dung bên trong** lên nhánh `main` của repository
   `Quan_ly_kho_vat_tu2`, ghi đè các file cũ.
3. Không xóa cơ sở dữ liệu D1 đã được Cloudflare tạo trước đó.
4. Vào **GitHub → Actions → Deploy Cloudflare Worker → Run workflow**.
5. Chờ bước `Test`, `Apply database migrations` và `Publish production version`
   đều chuyển màu xanh.

## Kết quả

- Không tạo hoặc sử dụng R2 Bucket.
- Không còn lỗi Cloudflare `Code 10042`.
- Migration `0004_item_images_d1.sql` tự tạo bảng ảnh trong D1.
- Dữ liệu vật tư, phiếu và đối tác đang có trong D1 được giữ nguyên.
- Ảnh mới được trình duyệt nén WebP dưới 300 KB trước khi lưu.

## Nếu vẫn báo lỗi R2

Repository vẫn còn file cũ. Kiểm tra `wrangler.jsonc`: file đúng chỉ có binding
`DB`, không có mục `r2_buckets` hoặc binding `IMAGES`.
