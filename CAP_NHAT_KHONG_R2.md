# Cập nhật V5.8.3: không R2 và không tạo trùng D1

## Thay thế mã trên GitHub

1. Giải nén ZIP.
2. Upload toàn bộ **nội dung bên trong** lên nhánh `main`, ghi đè file cũ.
3. Không xóa D1 `quanlykhovattu2-db`.
4. Chọn một cách triển khai:
   - GitHub Actions: chạy workflow `Deploy Cloudflare Worker`.
   - Cloudflare Builds: đặt Deploy command là `npm run deploy:cloudflare`.

Không chạy trực tiếp `npx wrangler deploy` cho lần cập nhật này.

## Bản sửa xử lý hai lỗi

- Không còn binding R2 nên không gặp `Code 10042`.
- Script tự tìm D1 đã có, lấy Database ID và triển khai với
  `--no-x-provision`, nên không gặp `A database with that name already exists`.

## Dữ liệu

- Giữ nguyên vật tư, phiếu, đối tác và người dùng trong D1 hiện tại.
- Migration chỉ bổ sung bảng còn thiếu.
- Ảnh mới được nén WebP tối đa 300 KB rồi lưu trong D1.
