PRAGMA foreign_keys = ON;

-- Ảnh được lưu riêng khỏi bảng vật tư để mỗi bản ghi vật tư luôn nhẹ.
-- Không dùng khóa ngoại để ảnh còn nguyên khi phục hồi JSON rồi chèn lại vật tư.
CREATE TABLE IF NOT EXISTS item_images (
  image_key TEXT PRIMARY KEY,
  item_id TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL CHECK (
    mime_type IN ('image/jpeg', 'image/png', 'image/webp')
  ),
  image_data BLOB NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (
    size_bytes > 0 AND size_bytes <= 307200
  ),
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_item_images_item
  ON item_images(item_id);
