PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'keeper', 'viewer')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  unit TEXT NOT NULL,
  category TEXT NOT NULL,
  item_type TEXT NOT NULL DEFAULT '',
  opening REAL NOT NULL DEFAULT 0,
  min_stock REAL NOT NULL DEFAULT 0,
  unit_price REAL NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  image_file TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS partners (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  tax_code TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vouchers (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL COLLATE NOCASE,
  invoice_no TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('IN', 'OUT')),
  partner_id TEXT,
  partner_code TEXT NOT NULL DEFAULT '',
  partner_name TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  warehouse TEXT NOT NULL DEFAULT '',
  deliverer_receiver TEXT NOT NULL DEFAULT '',
  created_by_name TEXT NOT NULL DEFAULT '',
  storekeeper TEXT NOT NULL DEFAULT '',
  approver TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'WEB',
  created_by_user_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (partner_id) REFERENCES partners(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  voucher_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  item_code TEXT NOT NULL,
  item_name TEXT NOT NULL,
  unit TEXT NOT NULL,
  quantity_in REAL NOT NULL DEFAULT 0,
  quantity_out REAL NOT NULL DEFAULT 0,
  condition_text TEXT NOT NULL DEFAULT 'Mới',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY (voucher_id) REFERENCES vouchers(id) ON DELETE CASCADE,
  FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  username TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  client_key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  window_started TEXT NOT NULL,
  locked_until TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_items_group_type
  ON items(category, item_type);
CREATE INDEX IF NOT EXISTS idx_items_code
  ON items(code COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_transactions_voucher
  ON transactions(voucher_id);
CREATE INDEX IF NOT EXISTS idx_transactions_item
  ON transactions(item_id);
CREATE INDEX IF NOT EXISTS idx_vouchers_date
  ON vouchers(date);
CREATE INDEX IF NOT EXISTS idx_audit_created
  ON audit_log(created_at DESC);

