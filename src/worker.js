const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_BYTES = 300 * 1024;
const PBKDF2_ITERATIONS = 260_000;
const SESSION_COOKIE = "kho_session";
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_FAILURE_LIMIT = 8;

const CONTENT_SECURITY_POLICY =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; " +
  "img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; " +
  "base-uri 'self'; form-action 'self'";

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function num(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function cleanText(value, maxLength = 500) {
  return String(value ?? "").trim().slice(0, maxLength);
}

export function makeId(prefix) {
  const stamp = nowIso().replace(/\D/g, "").slice(0, 14);
  const random = crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();
  return `${prefix}-${stamp}-${random}`;
}

export function isValidIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function base64UrlEncode(bytes, keepPadding = false) {
  let binary = "";
  const step = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
  }
  const encoded = btoa(binary).replaceAll("+", "-").replaceAll("/", "_");
  return keepPadding ? encoded : encoded.replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function utf8(value) {
  return new TextEncoder().encode(value);
}

function utf8Decode(value) {
  return new TextDecoder().decode(value);
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export async function passwordHash(password, iterations = PBKDF2_ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", utf8(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations,
    },
    key,
    256,
  );
  return `${iterations}$${base64UrlEncode(salt, true)}$${base64UrlEncode(
    new Uint8Array(bits),
    true,
  )}`;
}

export async function passwordVerify(password, encoded) {
  try {
    const [iterationText, saltText, digestText] = String(encoded).split("$", 3);
    const iterations = Number(iterationText);
    if (!Number.isInteger(iterations) || iterations < 10_000 || iterations > 2_000_000) {
      return false;
    }
    const salt = base64UrlDecode(saltText);
    const expected = base64UrlDecode(digestText);
    const key = await crypto.subtle.importKey("raw", utf8(password), "PBKDF2", false, [
      "deriveBits",
    ]);
    const bits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt,
        iterations,
      },
      key,
      expected.length * 8,
    );
    return constantTimeEqual(new Uint8Array(bits), expected);
  } catch {
    return false;
  }
}

async function dbFirst(db, sql, ...bindings) {
  return db.prepare(sql).bind(...bindings).first();
}

async function dbAll(db, sql, ...bindings) {
  const result = await db.prepare(sql).bind(...bindings).all();
  return result.results ?? [];
}

async function metadataGet(db, key, fallback = "") {
  const row = await dbFirst(db, "SELECT value FROM metadata WHERE key=?", key);
  return row?.value ?? fallback;
}

function metadataSetStatement(db, key, value) {
  return db
    .prepare(
      "INSERT INTO metadata(key,value) VALUES(?,?) " +
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
    .bind(key, value);
}

async function getSessionSecret(env) {
  const configured = String(env.SESSION_SECRET ?? "");
  if (configured.length >= 32) return configured;

  let stored = await metadataGet(env.DB, "session_secret", "");
  if (stored) return stored;

  const generated = base64UrlEncode(crypto.getRandomValues(new Uint8Array(48)));
  await env.DB.prepare(
    "INSERT INTO metadata(key,value) VALUES('session_secret',?) ON CONFLICT(key) DO NOTHING",
  )
    .bind(generated)
    .run();
  stored = await metadataGet(env.DB, "session_secret", generated);
  return stored;
}

async function hmacSha256(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    utf8(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, utf8(value));
  return new Uint8Array(signature);
}

async function createSession(env, user) {
  const days = Math.max(1, Math.min(30, Number(env.SESSION_DAYS ?? 7) || 7));
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload = {
    uid: user.id,
    role: user.role,
    iat: nowSeconds,
    exp: nowSeconds + days * 86_400,
    nonce: base64UrlEncode(crypto.getRandomValues(new Uint8Array(8))),
  };
  const body = base64UrlEncode(utf8(JSON.stringify(payload)));
  const signature = base64UrlEncode(
    await hmacSha256(await getSessionSecret(env), body),
  );
  return { token: `${body}.${signature}`, maxAge: days * 86_400 };
}

function parseCookie(header, name) {
  for (const part of String(header ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return "";
}

async function currentUser(request, env) {
  const token = parseCookie(request.headers.get("Cookie"), SESSION_COOKIE);
  if (!token) return null;
  try {
    const [body, suppliedSignature] = token.split(".", 2);
    if (!body || !suppliedSignature) return null;
    const expectedSignature = base64UrlEncode(
      await hmacSha256(await getSessionSecret(env), body),
    );
    if (
      !constantTimeEqual(
        utf8(suppliedSignature),
        utf8(expectedSignature),
      )
    ) {
      return null;
    }
    const payload = JSON.parse(utf8Decode(base64UrlDecode(body)));
    if (Number(payload.exp ?? 0) < Math.floor(Date.now() / 1000)) return null;
    return dbFirst(
      env.DB,
      "SELECT id,username,display_name,role,active,created_at,updated_at " +
        "FROM users WHERE id=? AND active=1",
      payload.uid,
    );
  } catch {
    return null;
  }
}

async function requireUser(request, env, roles = []) {
  const user = await currentUser(request, env);
  if (!user) {
    throw new ApiError(401, "Chưa đăng nhập hoặc phiên đã hết hạn");
  }
  if (roles.length && !roles.includes(user.role)) {
    throw new ApiError(403, "Tài khoản không có quyền thực hiện thao tác này");
  }
  return user;
}

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    active: Boolean(row.active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function auditStatement(db, user, action, entityType, entityId = "", details = "") {
  return db
    .prepare(
      "INSERT INTO audit_log(user_id,username,action,entity_type,entity_id,details,created_at) " +
        "VALUES(?,?,?,?,?,?,?)",
    )
    .bind(
      user?.id ?? null,
      user?.username ?? "system",
      action,
      entityType,
      entityId,
      cleanText(details, 4000),
      nowIso(),
    );
}

async function audit(env, user, action, entityType, entityId = "", details = "") {
  await auditStatement(
    env.DB,
    user,
    action,
    entityType,
    entityId,
    details,
  ).run();
}

async function currentRevision(env) {
  const row = await dbFirst(
    env.DB,
    "SELECT COALESCE(MAX(id),0) AS revision FROM audit_log",
  );
  return Number(row?.revision ?? 0);
}

function jsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function snapshot(env, user) {
  const [itemRows, partnerRows, voucherRows, transactionRows, metadataRows] =
    await Promise.all([
      dbAll(env.DB, "SELECT * FROM items ORDER BY category,item_type,code,name"),
      dbAll(env.DB, "SELECT * FROM partners ORDER BY name"),
      dbAll(env.DB, "SELECT * FROM vouchers ORDER BY date DESC,number DESC"),
      dbAll(env.DB, "SELECT * FROM transactions ORDER BY created_at,id"),
      dbAll(
        env.DB,
        "SELECT key,value FROM metadata WHERE key IN ('company','settings','source')",
      ),
    ]);

  const metadata = Object.fromEntries(
    metadataRows.map((row) => [row.key, row.value]),
  );
  const result = {
    version: 5.0,
    company: jsonParse(metadata.company ?? "{}", {}),
    settings: jsonParse(metadata.settings ?? "{}", {}),
    items: itemRows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      unit: row.unit,
      category: row.category,
      itemType: row.item_type,
      opening: row.opening,
      minStock: row.min_stock,
      unitPrice: row.unit_price,
      note: row.note,
      imageFile: row.image_file,
      imageUrl: row.image_file
        ? `/images/${encodeURIComponent(row.image_file)}?v=${encodeURIComponent(
            row.updated_at,
          )}`
        : "",
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    partners: partnerRows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      address: row.address,
      taxCode: row.tax_code,
      note: row.note,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    vouchers: voucherRows.map((row) => ({
      id: row.id,
      number: row.number,
      invoiceNo: row.invoice_no,
      date: row.date,
      type: row.type,
      partnerId: row.partner_id,
      partnerCode: row.partner_code,
      partnerName: row.partner_name,
      address: row.address,
      description: row.description,
      warehouse: row.warehouse,
      delivererReceiver: row.deliverer_receiver,
      createdBy: row.created_by_name,
      storekeeper: row.storekeeper,
      approver: row.approver,
      note: row.note,
      source: row.source,
      createdByUserId: row.created_by_user_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    transactions: transactionRows.map((row) => ({
      id: row.id,
      voucherId: row.voucher_id,
      itemId: row.item_id,
      itemCode: row.item_code,
      itemName: row.item_name,
      unit: row.unit,
      quantityIn: row.quantity_in,
      quantityOut: row.quantity_out,
      condition: row.condition_text,
      note: row.note,
      createdAt: row.created_at,
    })),
    me: publicUser(user),
    serverTime: nowIso(),
    source: metadata.source ?? "",
  };
  if (user.role === "admin") {
    const rows = await dbAll(env.DB, "SELECT * FROM users ORDER BY username");
    result.users = rows.map(publicUser);
  }
  return result;
}

function applySecurityHeaders(headers, cacheControl = "no-store") {
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "same-origin");
  headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  headers.set("Cache-Control", cacheControl);
  return headers;
}

function jsonResponse(data, status = 200, additionalHeaders = undefined) {
  const headers = new Headers(additionalHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  applySecurityHeaders(headers, "no-store");
  return new Response(JSON.stringify(data), { status, headers });
}

function emptyResponse(status = 204, additionalHeaders = undefined) {
  const headers = new Headers(additionalHeaders);
  applySecurityHeaders(headers, "no-store");
  return new Response(null, { status, headers });
}

async function readJson(request) {
  const declared = Number(request.headers.get("Content-Length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new ApiError(400, "Dữ liệu gửi lên quá lớn");
  }
  const body = new Uint8Array(await request.arrayBuffer());
  if (!body.length || body.length > MAX_BODY_BYTES) {
    throw new ApiError(400, "Dữ liệu gửi lên rỗng hoặc quá lớn");
  }
  try {
    const parsed = JSON.parse(utf8Decode(body));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("JSON object required");
    }
    return parsed;
  } catch {
    throw new ApiError(400, "Dữ liệu JSON không hợp lệ");
  }
}

function verifyOrigin(request) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  const origin = request.headers.get("Origin");
  if (!origin) return;
  try {
    if (new URL(origin).origin !== new URL(request.url).origin) {
      throw new ApiError(403, "Yêu cầu khác nguồn bị từ chối");
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(403, "Nguồn yêu cầu không hợp lệ");
  }
}

function sessionCookie(request, token, maxAge) {
  const secure = new URL(request.url).protocol === "https:";
  return [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Strict",
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

function clientKey(request) {
  return cleanText(
    request.headers.get("CF-Connecting-IP") ??
      request.headers.get("X-Forwarded-For") ??
      "local",
    120,
  );
}

async function assertLoginAllowed(env, key) {
  const row = await dbFirst(
    env.DB,
    "SELECT failures,window_started,locked_until FROM login_attempts WHERE client_key=?",
    key,
  );
  if (row && Number(row.locked_until || 0) > Date.now()) {
    throw new ApiError(
      429,
      "Đăng nhập sai quá nhiều. Hãy thử lại sau 5 phút",
    );
  }
}

async function recordLoginFailure(env, key) {
  const current = await dbFirst(
    env.DB,
    "SELECT failures,window_started FROM login_attempts WHERE client_key=?",
    key,
  );
  const now = Date.now();
  const windowStarted = Number(current?.window_started || 0);
  const insideWindow = now - windowStarted <= LOGIN_WINDOW_MS;
  const failures = insideWindow ? Number(current?.failures || 0) + 1 : 1;
  const lockedUntil =
    failures >= LOGIN_FAILURE_LIMIT ? String(now + LOGIN_WINDOW_MS) : "";
  await env.DB.prepare(
    "INSERT INTO login_attempts(client_key,failures,window_started,locked_until) " +
      "VALUES(?,?,?,?) ON CONFLICT(client_key) DO UPDATE SET " +
      "failures=excluded.failures,window_started=excluded.window_started,locked_until=excluded.locked_until",
  )
    .bind(key, failures, String(insideWindow ? windowStarted : now), lockedUntil)
    .run();
}

async function ensureBootstrapUsers(env) {
  const row = await dbFirst(env.DB, "SELECT COUNT(*) AS count FROM users");
  if (Number(row?.count ?? 0) > 0) return;

  const passwords = {
    admin: String(env.ADMIN_PASSWORD ?? ""),
    thukho: String(env.KEEPER_PASSWORD ?? ""),
    xem: String(env.VIEWER_PASSWORD ?? ""),
  };
  if (Object.values(passwords).some((value) => value.length < 6)) {
    throw new ApiError(
      503,
      "Hệ thống chưa được cấu hình mật khẩu ban đầu trên Cloudflare",
    );
  }
  const created = nowIso();
  const defaults = [
    ["U-ADMIN", "admin", passwords.admin, "Quản trị", "admin"],
    ["U-KEEPER", "thukho", passwords.thukho, "Thủ kho", "keeper"],
    ["U-VIEWER", "xem", passwords.xem, "Chỉ xem", "viewer"],
  ];
  const hashed = await Promise.all(
    defaults.map(async ([id, username, password, displayName, role]) => [
      id,
      username,
      await passwordHash(password),
      displayName,
      role,
    ]),
  );
  await env.DB.batch(
    hashed.map(([id, username, hash, displayName, role]) =>
      env.DB.prepare(
        "INSERT OR IGNORE INTO users(" +
          "id,username,password_hash,display_name,role,active,created_at,updated_at" +
          ") VALUES(?,?,?,?,?,1,?,?)",
      ).bind(id, username, hash, displayName, role, created, created),
    ),
  );
}

async function apiLogin(request, env) {
  await ensureBootstrapUsers(env);
  const key = clientKey(request);
  await assertLoginAllowed(env, key);
  const data = await readJson(request);
  const username = cleanText(data.username, 80);
  const password = String(data.password ?? "");
  const user = await dbFirst(
    env.DB,
    "SELECT * FROM users WHERE username=? COLLATE NOCASE AND active=1",
    username,
  );
  if (!user || !(await passwordVerify(password, user.password_hash))) {
    await recordLoginFailure(env, key);
    await audit(
      env,
      user,
      "LOGIN_FAILED",
      "session",
      "",
      `username=${username}; ip=${key}`,
    );
    throw new ApiError(401, "Sai tên đăng nhập hoặc mật khẩu");
  }
  await env.DB.prepare("DELETE FROM login_attempts WHERE client_key=?")
    .bind(key)
    .run();
  const session = await createSession(env, user);
  await audit(env, user, "LOGIN", "session", "", `ip=${key}`);
  return jsonResponse(
    { ok: true, user: publicUser(user) },
    200,
    {
      "Set-Cookie": sessionCookie(request, session.token, session.maxAge),
    },
  );
}

async function apiItems(request, env, method, itemId) {
  const user = await requireUser(request, env, ["admin", "keeper"]);
  if (method === "POST" || method === "PUT") {
    const data = await readJson(request);
    const code = cleanText(data.code, 180);
    const name = cleanText(data.name, 300);
    const unit = cleanText(data.unit, 50);
    const category = cleanText(data.category || "KHÁC", 100);
    const itemType = cleanText(data.itemType || "KHÁC", 120);
    if (!code || !name || !unit) {
      throw new ApiError(400, "Mã, tên và đơn vị tính là bắt buộc");
    }
    const when = nowIso();
    const values = [
      code,
      name,
      unit,
      category,
      itemType,
      num(data.opening),
      num(data.minStock),
      Math.max(0, num(data.unitPrice)),
      cleanText(data.note, 2000),
    ];
    if (method === "POST") {
      itemId = makeId("I");
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO items(" +
            "id,code,name,unit,category,item_type,opening,min_stock,unit_price,note,created_at,updated_at" +
            ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        ).bind(itemId, ...values, when, when),
        auditStatement(env.DB, user, "CREATE", "item", itemId, code),
      ]);
    } else {
      if (
        !itemId ||
        !(await dbFirst(env.DB, "SELECT 1 AS found FROM items WHERE id=?", itemId))
      ) {
        throw new ApiError(404, "Không tìm thấy vật tư");
      }
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE items SET code=?,name=?,unit=?,category=?,item_type=?,opening=?," +
            "min_stock=?,unit_price=?,note=?,updated_at=? WHERE id=?",
        ).bind(...values, when, itemId),
        env.DB.prepare(
          "UPDATE transactions SET item_code=?,item_name=?,unit=? WHERE item_id=?",
        ).bind(code, name, unit, itemId),
        auditStatement(env.DB, user, "UPDATE", "item", itemId, code),
      ]);
    }
    return jsonResponse({ ok: true, id: itemId });
  }

  if (method === "DELETE") {
    if (!itemId) throw new ApiError(400, "Thiếu mã vật tư");
    const used = await dbFirst(
      env.DB,
      "SELECT 1 AS found FROM transactions WHERE item_id=? LIMIT 1",
      itemId,
    );
    if (used) throw new ApiError(409, "Không thể xóa vật tư đã có giao dịch");
    const item = await dbFirst(
      env.DB,
      "SELECT code,image_file FROM items WHERE id=?",
      itemId,
    );
    if (!item) throw new ApiError(404, "Không tìm thấy vật tư");
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM item_images WHERE item_id=? OR image_key=?",
      ).bind(itemId, item.image_file || ""),
      env.DB.prepare("DELETE FROM items WHERE id=?").bind(itemId),
      auditStatement(env.DB, user, "DELETE", "item", itemId, item.code),
    ]);
    return jsonResponse({ ok: true });
  }
  throw new ApiError(405, "Phương thức không được hỗ trợ");
}

async function apiItemValues(request, env) {
  const user = await requireUser(request, env, ["admin", "keeper"]);
  const data = await readJson(request);
  if (!Array.isArray(data.values)) {
    throw new ApiError(400, "Danh sách đơn giá không hợp lệ");
  }
  const when = nowIso();
  const rows = data.values
    .map((row) => ({
      id: cleanText(row?.id, 100),
      unitPrice: Math.max(0, num(row?.unitPrice)),
    }))
    .filter((row) => row.id);
  await env.DB.batch([
    ...rows.map((row) =>
      env.DB.prepare(
        "UPDATE items SET unit_price=?,updated_at=? WHERE id=?",
      ).bind(row.unitPrice, when, row.id),
    ),
    auditStatement(
      env.DB,
      user,
      "UPDATE_VALUES",
      "items",
      "",
      `updated=${rows.length}`,
    ),
  ]);
  return jsonResponse({ ok: true, updated: rows.length });
}

function decodeBase64Image(dataUrl) {
  if (!dataUrl.startsWith("data:image/") || !dataUrl.includes(",")) {
    throw new ApiError(400, "Dữ liệu ảnh không hợp lệ");
  }
  const separator = dataUrl.indexOf(",");
  const header = dataUrl.slice(0, separator);
  const encoded = dataUrl.slice(separator + 1);
  const mime = header.slice(5).split(";", 1)[0].toLowerCase();
  const extension = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
  }[mime];
  if (!extension || !header.toLowerCase().includes(";base64")) {
    throw new ApiError(400, "Chỉ hỗ trợ ảnh JPG, PNG hoặc WebP");
  }
  if (encoded.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8) {
    throw new ApiError(400, "Ảnh sau khi xử lý phải không quá 300 KB");
  }
  let bytes;
  try {
    bytes = Uint8Array.from(atob(encoded), (character) =>
      character.charCodeAt(0),
    );
  } catch {
    throw new ApiError(400, "Không đọc được dữ liệu ảnh");
  }
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) {
    throw new ApiError(400, "Ảnh sau khi xử lý phải không quá 300 KB");
  }
  const valid =
    (extension === ".jpg" &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff) ||
    (extension === ".png" &&
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
        (value, index) => bytes[index] === value,
      )) ||
    (extension === ".webp" &&
      bytes.length > 12 &&
      utf8Decode(bytes.subarray(0, 4)) === "RIFF" &&
      utf8Decode(bytes.subarray(8, 12)) === "WEBP");
  if (!valid) {
    throw new ApiError(400, "Nội dung tệp không đúng định dạng ảnh");
  }
  return { bytes, mime, extension };
}

async function apiItemImage(request, env, method, itemId) {
  const user = await requireUser(request, env, ["admin", "keeper"]);
  const item = await dbFirst(
    env.DB,
    "SELECT id,code,image_file FROM items WHERE id=?",
    itemId,
  );
  if (!item) throw new ApiError(404, "Không tìm thấy vật tư");
  const oldFile = item.image_file || "";

  if (method === "POST") {
    const data = await readJson(request);
    const image = decodeBase64Image(String(data.dataUrl ?? ""));
    const filename = `${itemId}-${crypto
      .randomUUID()
      .replaceAll("-", "")
      .slice(0, 12)}${image.extension}`;
    const when = nowIso();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO item_images(" +
          "image_key,item_id,mime_type,image_data,size_bytes,updated_at" +
          ") VALUES(?,?,?,?,?,?) " +
          "ON CONFLICT(item_id) DO UPDATE SET " +
          "image_key=excluded.image_key,mime_type=excluded.mime_type," +
          "image_data=excluded.image_data,size_bytes=excluded.size_bytes," +
          "updated_at=excluded.updated_at",
      ).bind(
        filename,
        itemId,
        image.mime,
        image.bytes,
        image.bytes.byteLength,
        when,
      ),
      env.DB.prepare(
        "UPDATE items SET image_file=?,updated_at=? WHERE id=?",
      ).bind(filename, when, itemId),
      auditStatement(
        env.DB,
        user,
        "UPLOAD_IMAGE",
        "item",
        itemId,
        `${item.code}; bytes=${image.bytes.byteLength}`,
      ),
    ]);
    return jsonResponse({
      ok: true,
      imageUrl: `/images/${encodeURIComponent(filename)}`,
    });
  }

  if (method === "DELETE") {
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM item_images WHERE item_id=? OR image_key=?",
      ).bind(itemId, oldFile),
      env.DB.prepare(
        "UPDATE items SET image_file='',updated_at=? WHERE id=?",
      ).bind(nowIso(), itemId),
      auditStatement(
        env.DB,
        user,
        "DELETE_IMAGE",
        "item",
        itemId,
        item.code,
      ),
    ]);
    return jsonResponse({ ok: true });
  }
  throw new ApiError(405, "Phương thức không được hỗ trợ");
}

async function apiPartners(request, env, method, partnerId) {
  const user = await requireUser(request, env, ["admin", "keeper"]);
  if (method === "POST" || method === "PUT") {
    const data = await readJson(request);
    const code = cleanText(data.code, 100);
    const name = cleanText(data.name, 300);
    if (!code || !name) {
      throw new ApiError(400, "Mã và tên đối tác là bắt buộc");
    }
    const when = nowIso();
    const values = [
      code,
      name,
      cleanText(data.address, 500),
      cleanText(data.taxCode, 80),
      cleanText(data.note, 2000),
    ];
    if (method === "POST") {
      partnerId = makeId("P");
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO partners(id,code,name,address,tax_code,note,created_at,updated_at) " +
            "VALUES(?,?,?,?,?,?,?,?)",
        ).bind(partnerId, ...values, when, when),
        auditStatement(env.DB, user, "CREATE", "partner", partnerId, code),
      ]);
    } else {
      if (
        !(await dbFirst(
          env.DB,
          "SELECT 1 AS found FROM partners WHERE id=?",
          partnerId,
        ))
      ) {
        throw new ApiError(404, "Không tìm thấy đối tác");
      }
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE partners SET code=?,name=?,address=?,tax_code=?,note=?,updated_at=? WHERE id=?",
        ).bind(...values, when, partnerId),
        auditStatement(env.DB, user, "UPDATE", "partner", partnerId, code),
      ]);
    }
    return jsonResponse({ ok: true, id: partnerId });
  }

  if (method === "DELETE") {
    const used = await dbFirst(
      env.DB,
      "SELECT 1 AS found FROM vouchers WHERE partner_id=? LIMIT 1",
      partnerId,
    );
    if (used) throw new ApiError(409, "Không thể xóa đối tác đã có phiếu");
    const partner = await dbFirst(
      env.DB,
      "SELECT code FROM partners WHERE id=?",
      partnerId,
    );
    if (!partner) throw new ApiError(404, "Không tìm thấy đối tác");
    await env.DB.batch([
      env.DB.prepare("DELETE FROM partners WHERE id=?").bind(partnerId),
      auditStatement(
        env.DB,
        user,
        "DELETE",
        "partner",
        partnerId,
        partner.code,
      ),
    ]);
    return jsonResponse({ ok: true });
  }
  throw new ApiError(405, "Phương thức không được hỗ trợ");
}

async function inventoryForItem(env, itemId, excludeVoucherId = "") {
  const item = await dbFirst(
    env.DB,
    "SELECT opening FROM items WHERE id=?",
    itemId,
  );
  if (!item) throw new ApiError(400, "Vật tư không tồn tại");
  const row = excludeVoucherId
    ? await dbFirst(
        env.DB,
        "SELECT COALESCE(SUM(quantity_in-quantity_out),0) AS delta " +
          "FROM transactions WHERE item_id=? AND voucher_id<>?",
        itemId,
        excludeVoucherId,
      )
    : await dbFirst(
        env.DB,
        "SELECT COALESCE(SUM(quantity_in-quantity_out),0) AS delta " +
          "FROM transactions WHERE item_id=?",
        itemId,
      );
  return num(item.opening) + num(row?.delta);
}

async function validateVoucher(env, data, voucherId = "") {
  const type = cleanText(data.type, 3).toUpperCase();
  if (!["IN", "OUT"].includes(type)) {
    throw new ApiError(400, "Loại phiếu không hợp lệ");
  }
  const date = cleanText(data.date, 10);
  if (!isValidIsoDate(date)) {
    throw new ApiError(400, "Ngày phiếu không hợp lệ");
  }
  if (!Array.isArray(data.lines) || !data.lines.length) {
    throw new ApiError(400, "Phiếu phải có ít nhất một dòng vật tư");
  }

  const totals = new Map();
  const lines = [];
  for (const line of data.lines) {
    const itemId = cleanText(line?.itemId, 100);
    const quantity = num(line?.quantity);
    if (quantity <= 0) throw new ApiError(400, "Số lượng phải lớn hơn 0");
    const item = await dbFirst(env.DB, "SELECT * FROM items WHERE id=?", itemId);
    if (!item) throw new ApiError(400, "Có vật tư không tồn tại");
    totals.set(itemId, (totals.get(itemId) ?? 0) + quantity);
    lines.push({
      itemId,
      itemCode: item.code,
      itemName: item.name,
      unit: item.unit,
      quantity,
      condition: cleanText(line?.condition || "Mới", 100),
      note: cleanText(line?.note, 1000),
    });
  }

  const settings = jsonParse(
    await metadataGet(env.DB, "settings", "{}"),
    {},
  );
  if (type === "OUT" && !Boolean(settings.allowNegative ?? true)) {
    for (const [itemId, quantity] of totals) {
      const available = await inventoryForItem(env, itemId, voucherId);
      if (quantity > available + 1e-9) {
        const item = await dbFirst(
          env.DB,
          "SELECT code,name FROM items WHERE id=?",
          itemId,
        );
        throw new ApiError(
          409,
          `${item.code} chỉ còn ${available}, không đủ xuất ${quantity}`,
        );
      }
    }
  }

  const partnerId = cleanText(data.partnerId, 100) || null;
  const partner = partnerId
    ? await dbFirst(env.DB, "SELECT * FROM partners WHERE id=?", partnerId)
    : null;
  const header = {
    number: cleanText(data.number, 160),
    invoiceNo: cleanText(data.invoiceNo, 100),
    date,
    type,
    partnerId,
    partnerCode: cleanText(data.partnerCode || partner?.code || "", 100),
    partnerName: cleanText(data.partnerName || partner?.name || "", 300),
    address: cleanText(data.address || partner?.address || "", 500),
    description: cleanText(data.description, 1000),
    warehouse: cleanText(data.warehouse || "Kho công ty", 200),
    delivererReceiver: cleanText(data.delivererReceiver, 200),
    createdBy: cleanText(data.createdBy, 200),
    storekeeper: cleanText(data.storekeeper, 200),
    approver: cleanText(data.approver, 200),
    note: cleanText(data.note, 2000),
  };
  return { header, lines };
}

async function generateVoucherNumber(env, type, date) {
  const prefix = type === "IN" ? "PNK" : "PXK";
  const stem = `${prefix}-${date.replaceAll("-", "")}-`;
  const rows = await dbAll(
    env.DB,
    "SELECT number FROM vouchers WHERE number LIKE ?",
    `${stem}%`,
  );
  let maximum = 0;
  for (const row of rows) {
    const number = Number(String(row.number).split("-").at(-1));
    if (Number.isInteger(number)) maximum = Math.max(maximum, number);
  }
  return `${stem}${String(maximum + 1).padStart(3, "0")}`;
}

async function apiVouchers(request, env, method, voucherId) {
  const user = await requireUser(request, env, ["admin", "keeper"]);
  if (method === "POST" || method === "PUT") {
    const data = await readJson(request);
    const { header, lines } = await validateVoucher(
      env,
      data,
      method === "PUT" ? voucherId : "",
    );
    const when = nowIso();
    if (!header.number) {
      header.number = await generateVoucherNumber(env, header.type, header.date);
    }
    const statements = [];
    let action;
    if (method === "POST") {
      voucherId = makeId("V");
      statements.push(
        env.DB.prepare(
          "INSERT INTO vouchers(" +
            "id,number,invoice_no,date,type,partner_id,partner_code,partner_name,address,description," +
            "warehouse,deliverer_receiver,created_by_name,storekeeper,approver,note,source," +
            "created_by_user_id,created_at,updated_at" +
            ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ).bind(
          voucherId,
          header.number,
          header.invoiceNo,
          header.date,
          header.type,
          header.partnerId,
          header.partnerCode,
          header.partnerName,
          header.address,
          header.description,
          header.warehouse,
          header.delivererReceiver,
          header.createdBy,
          header.storekeeper,
          header.approver,
          header.note,
          "WEB",
          user.id,
          when,
          when,
        ),
      );
      action = "CREATE";
    } else {
      if (
        !(await dbFirst(
          env.DB,
          "SELECT 1 AS found FROM vouchers WHERE id=?",
          voucherId,
        ))
      ) {
        throw new ApiError(404, "Không tìm thấy phiếu");
      }
      statements.push(
        env.DB.prepare(
          "UPDATE vouchers SET number=?,invoice_no=?,date=?,type=?,partner_id=?," +
            "partner_code=?,partner_name=?,address=?,description=?,warehouse=?," +
            "deliverer_receiver=?,created_by_name=?,storekeeper=?,approver=?,note=?,updated_at=? " +
            "WHERE id=?",
        ).bind(
          header.number,
          header.invoiceNo,
          header.date,
          header.type,
          header.partnerId,
          header.partnerCode,
          header.partnerName,
          header.address,
          header.description,
          header.warehouse,
          header.delivererReceiver,
          header.createdBy,
          header.storekeeper,
          header.approver,
          header.note,
          when,
          voucherId,
        ),
      );
      statements.push(
        env.DB.prepare("DELETE FROM transactions WHERE voucher_id=?").bind(
          voucherId,
        ),
      );
      action = "UPDATE";
    }
    for (const line of lines) {
      const quantityIn = header.type === "IN" ? line.quantity : 0;
      const quantityOut = header.type === "OUT" ? line.quantity : 0;
      statements.push(
        env.DB.prepare(
          "INSERT INTO transactions(" +
            "id,voucher_id,item_id,item_code,item_name,unit,quantity_in,quantity_out," +
            "condition_text,note,created_at" +
            ") VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        ).bind(
          makeId("T"),
          voucherId,
          line.itemId,
          line.itemCode,
          line.itemName,
          line.unit,
          quantityIn,
          quantityOut,
          line.condition,
          line.note,
          when,
        ),
      );
    }
    statements.push(
      auditStatement(
        env.DB,
        user,
        action,
        "voucher",
        voucherId,
        header.number,
      ),
    );
    await env.DB.batch(statements);
    return jsonResponse({
      ok: true,
      id: voucherId,
      number: header.number,
    });
  }

  if (method === "DELETE") {
    const voucher = await dbFirst(
      env.DB,
      "SELECT number FROM vouchers WHERE id=?",
      voucherId,
    );
    if (!voucher) throw new ApiError(404, "Không tìm thấy phiếu");
    await env.DB.batch([
      env.DB.prepare("DELETE FROM vouchers WHERE id=?").bind(voucherId),
      auditStatement(
        env.DB,
        user,
        "DELETE",
        "voucher",
        voucherId,
        voucher.number,
      ),
    ]);
    return jsonResponse({ ok: true });
  }
  throw new ApiError(405, "Phương thức không được hỗ trợ");
}

async function apiUsers(request, env, method, userId) {
  const admin = await requireUser(request, env, ["admin"]);
  if (method === "POST" || method === "PUT") {
    const data = await readJson(request);
    const username = cleanText(data.username, 80);
    const displayName = cleanText(data.displayName, 160);
    const role = cleanText(data.role, 20);
    const active = data.active ?? true ? 1 : 0;
    const password = String(data.password ?? "");
    if (
      !["admin", "keeper", "viewer"].includes(role) ||
      !username ||
      !displayName
    ) {
      throw new ApiError(400, "Thông tin người dùng không hợp lệ");
    }
    const when = nowIso();
    if (method === "POST") {
      if (password.length < 6) {
        throw new ApiError(400, "Mật khẩu phải có ít nhất 6 ký tự");
      }
      userId = makeId("U");
      const hash = await passwordHash(password);
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO users(" +
            "id,username,password_hash,display_name,role,active,created_at,updated_at" +
            ") VALUES(?,?,?,?,?,?,?,?)",
        ).bind(
          userId,
          username,
          hash,
          displayName,
          role,
          active,
          when,
          when,
        ),
        auditStatement(env.DB, admin, "CREATE", "user", userId, username),
      ]);
    } else {
      const existing = await dbFirst(
        env.DB,
        "SELECT * FROM users WHERE id=?",
        userId,
      );
      if (!existing) throw new ApiError(404, "Không tìm thấy người dùng");
      if (userId === admin.id && !active) {
        throw new ApiError(400, "Không thể tự khóa tài khoản đang dùng");
      }
      if (password && password.length < 6) {
        throw new ApiError(400, "Mật khẩu phải có ít nhất 6 ký tự");
      }
      const statement = password
        ? env.DB.prepare(
            "UPDATE users SET username=?,display_name=?,role=?,active=?," +
              "password_hash=?,updated_at=? WHERE id=?",
          ).bind(
            username,
            displayName,
            role,
            active,
            await passwordHash(password),
            when,
            userId,
          )
        : env.DB.prepare(
            "UPDATE users SET username=?,display_name=?,role=?,active=?,updated_at=? WHERE id=?",
          ).bind(username, displayName, role, active, when, userId);
      await env.DB.batch([
        statement,
        auditStatement(env.DB, admin, "UPDATE", "user", userId, username),
      ]);
    }
    return jsonResponse({ ok: true, id: userId });
  }

  if (method === "DELETE") {
    if (userId === admin.id) {
      throw new ApiError(400, "Không thể tự xóa tài khoản đang dùng");
    }
    const user = await dbFirst(
      env.DB,
      "SELECT username FROM users WHERE id=?",
      userId,
    );
    if (!user) throw new ApiError(404, "Không tìm thấy người dùng");
    await env.DB.batch([
      env.DB.prepare("DELETE FROM users WHERE id=?").bind(userId),
      auditStatement(
        env.DB,
        admin,
        "DELETE",
        "user",
        userId,
        user.username,
      ),
    ]);
    return jsonResponse({ ok: true });
  }
  throw new ApiError(405, "Phương thức không được hỗ trợ");
}

async function apiChangePassword(request, env) {
  const user = await requireUser(request, env);
  const data = await readJson(request);
  const current = String(data.currentPassword ?? "");
  const next = String(data.newPassword ?? "");
  const row = await dbFirst(
    env.DB,
    "SELECT password_hash FROM users WHERE id=?",
    user.id,
  );
  if (!row || !(await passwordVerify(current, row.password_hash))) {
    throw new ApiError(400, "Mật khẩu hiện tại không đúng");
  }
  if (next.length < 6) {
    throw new ApiError(400, "Mật khẩu mới phải có ít nhất 6 ký tự");
  }
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE users SET password_hash=?,updated_at=? WHERE id=?",
    ).bind(await passwordHash(next), nowIso(), user.id),
    auditStatement(
      env.DB,
      user,
      "CHANGE_PASSWORD",
      "user",
      user.id,
    ),
  ]);
  return jsonResponse({ ok: true });
}

async function apiSettings(request, env) {
  const user = await requireUser(request, env, ["admin"]);
  const data = await readJson(request);
  const settings = {
    allowNegative: Boolean(data.allowNegative ?? true),
    defaultWarehouse: cleanText(
      data.defaultWarehouse || "Kho công ty",
      200,
    ),
  };
  const companyData = data.company ?? {};
  const company = {
    name: cleanText(companyData.name, 300),
    address: cleanText(companyData.address, 500),
    taxCode: cleanText(companyData.taxCode, 100),
  };
  await env.DB.batch([
    metadataSetStatement(env.DB, "settings", JSON.stringify(settings)),
    metadataSetStatement(env.DB, "company", JSON.stringify(company)),
    auditStatement(env.DB, user, "UPDATE", "settings"),
  ]);
  return jsonResponse({ ok: true });
}

function restoreItemStatement(db, row, created) {
  return db
    .prepare(
      "INSERT INTO items(" +
        "id,code,name,unit,category,item_type,opening,min_stock,unit_price,note," +
        "image_file,created_at,updated_at" +
        ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      row.id || makeId("I"),
      cleanText(row.code, 180),
      cleanText(row.name, 300),
      cleanText(row.unit, 50),
      cleanText(row.category || "KHÁC", 100),
      cleanText(row.itemType || "KHÁC", 120),
      num(row.opening),
      num(row.minStock),
      Math.max(0, num(row.unitPrice)),
      cleanText(row.note, 2000),
      cleanText(row.imageFile, 255),
      cleanText(row.createdAt || created, 40),
      cleanText(row.updatedAt || created, 40),
    );
}

function restorePartnerStatement(db, row, created) {
  return db
    .prepare(
      "INSERT INTO partners(id,code,name,address,tax_code,note,created_at,updated_at) " +
        "VALUES(?,?,?,?,?,?,?,?)",
    )
    .bind(
      row.id || makeId("P"),
      cleanText(row.code, 100),
      cleanText(row.name, 300),
      cleanText(row.address, 500),
      cleanText(row.taxCode, 80),
      cleanText(row.note, 2000),
      cleanText(row.createdAt || created, 40),
      cleanText(row.updatedAt || created, 40),
    );
}

function restoreVoucherStatement(db, row, created) {
  return db
    .prepare(
      "INSERT INTO vouchers(" +
        "id,number,invoice_no,date,type,partner_id,partner_code,partner_name,address," +
        "description,warehouse,deliverer_receiver,created_by_name,storekeeper,approver," +
        "note,source,created_by_user_id,created_at,updated_at" +
        ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      row.id || makeId("V"),
      cleanText(row.number, 160),
      cleanText(row.invoiceNo, 100),
      cleanText(row.date, 10),
      cleanText(row.type, 3),
      row.partnerId || null,
      cleanText(row.partnerCode, 100),
      cleanText(row.partnerName, 300),
      cleanText(row.address, 500),
      cleanText(row.description, 1000),
      cleanText(row.warehouse, 200),
      cleanText(row.delivererReceiver, 200),
      cleanText(row.createdBy, 200),
      cleanText(row.storekeeper, 200),
      cleanText(row.approver, 200),
      cleanText(row.note, 2000),
      cleanText(row.source || "RESTORE", 30),
      row.createdByUserId || null,
      cleanText(row.createdAt || created, 40),
      cleanText(row.updatedAt || created, 40),
    );
}

function restoreTransactionStatement(db, row, created) {
  return db
    .prepare(
      "INSERT INTO transactions(" +
        "id,voucher_id,item_id,item_code,item_name,unit,quantity_in,quantity_out," +
        "condition_text,note,created_at" +
        ") VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      row.id || makeId("T"),
      row.voucherId,
      row.itemId,
      cleanText(row.itemCode, 180),
      cleanText(row.itemName, 300),
      cleanText(row.unit, 50),
      num(row.quantityIn),
      num(row.quantityOut),
      cleanText(row.condition || "Mới", 100),
      cleanText(row.note, 1000),
      cleanText(row.createdAt || created, 40),
    );
}

async function runBatches(db, statements, chunkSize = 50) {
  for (let offset = 0; offset < statements.length; offset += chunkSize) {
    await db.batch(statements.slice(offset, offset + chunkSize));
  }
}

async function apiRestore(request, env) {
  const user = await requireUser(request, env, ["admin"]);
  const payload = await readJson(request);
  const data = payload.data ?? payload;
  for (const key of ["items", "partners", "vouchers", "transactions"]) {
    if (!Array.isArray(data[key])) {
      throw new ApiError(400, `Tệp sao lưu thiếu dữ liệu ${key}`);
    }
  }
  const created = nowIso();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM transactions"),
    env.DB.prepare("DELETE FROM vouchers"),
    env.DB.prepare("DELETE FROM partners"),
    env.DB.prepare("DELETE FROM items"),
  ]);
  await runBatches(
    env.DB,
    data.items.map((row) => restoreItemStatement(env.DB, row, created)),
  );
  await runBatches(
    env.DB,
    data.partners.map((row) => restorePartnerStatement(env.DB, row, created)),
  );
  await runBatches(
    env.DB,
    data.vouchers.map((row) => restoreVoucherStatement(env.DB, row, created)),
  );
  await runBatches(
    env.DB,
    data.transactions.map((row) =>
      restoreTransactionStatement(env.DB, row, created),
    ),
  );
  await env.DB.batch([
    metadataSetStatement(env.DB, "company", JSON.stringify(data.company ?? {})),
    metadataSetStatement(
      env.DB,
      "settings",
      JSON.stringify(data.settings ?? {}),
    ),
    auditStatement(
      env.DB,
      user,
      "RESTORE",
      "database",
      "",
      `items=${data.items.length}; vouchers=${data.vouchers.length}`,
    ),
  ]);
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM item_images WHERE item_id NOT IN (SELECT id FROM items)",
    ),
    env.DB.prepare(
      "UPDATE items SET image_file='' " +
        "WHERE image_file<>'' AND NOT EXISTS (" +
        "SELECT 1 FROM item_images " +
        "WHERE item_images.item_id=items.id " +
        "AND item_images.image_key=items.image_file" +
        ")",
    ),
  ]);
  return jsonResponse({ ok: true });
}

async function handleImageRequest(request, env, url) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    throw new ApiError(405, "Phương thức không được hỗ trợ");
  }
  await requireUser(request, env);
  let filename;
  try {
    filename = decodeURIComponent(url.pathname.slice("/images/".length)).trim();
  } catch {
    throw new ApiError(400, "Tên ảnh không hợp lệ");
  }
  if (
    !filename ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename === "." ||
    filename === ".."
  ) {
    throw new ApiError(400, "Tên ảnh không hợp lệ");
  }
  const image = await dbFirst(
    env.DB,
    "SELECT mime_type,image_data,size_bytes,updated_at " +
      "FROM item_images WHERE image_key=?",
    filename,
  );
  if (!image) throw new ApiError(404, "Không tìm thấy ảnh");
  const bytes =
    image.image_data instanceof Uint8Array
      ? image.image_data
      : image.image_data instanceof ArrayBuffer
        ? new Uint8Array(image.image_data)
        : ArrayBuffer.isView(image.image_data)
          ? new Uint8Array(
              image.image_data.buffer,
              image.image_data.byteOffset,
              image.image_data.byteLength,
            )
          : Uint8Array.from(image.image_data ?? []);
  if (!bytes.length || bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new ApiError(500, "Dữ liệu ảnh trong D1 không hợp lệ");
  }
  const etag = `"${String(image.updated_at)
    .replace(/\D/g, "")
    .slice(0, 20)}-${bytes.byteLength}"`;
  if (request.headers.get("If-None-Match") === etag) {
    const headers = new Headers({ ETag: etag });
    applySecurityHeaders(headers, "private, max-age=86400");
    return new Response(null, { status: 304, headers });
  }
  const headers = new Headers();
  headers.set("Content-Type", image.mime_type || "application/octet-stream");
  headers.set("ETag", etag);
  headers.set("Content-Length", String(bytes.byteLength));
  applySecurityHeaders(headers, "private, max-age=86400");
  return new Response(request.method === "HEAD" ? null : bytes, {
    status: 200,
    headers,
  });
}

async function handleApi(request, env, url) {
  if (request.method === "OPTIONS") return emptyResponse();
  verifyOrigin(request);
  const method = request.method.toUpperCase();
  const path = url.pathname;

  if (path === "/api/health" && method === "GET") {
    return jsonResponse({ ok: true, time: nowIso(), database: "Cloudflare D1" });
  }
  if (path === "/api/login" && method === "POST") {
    return apiLogin(request, env);
  }
  if (path === "/api/logout" && method === "POST") {
    return jsonResponse(
      { ok: true },
      200,
      { "Set-Cookie": sessionCookie(request, "", 0) },
    );
  }
  if (path === "/api/network" && method === "GET") {
    await requireUser(request, env);
    const origin = url.origin;
    return jsonResponse({
      ok: true,
      data: {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        nameUrl: origin,
        ipUrls: [],
        recommendedUrl: origin,
      },
    });
  }
  if (path === "/api/revision" && method === "GET") {
    await requireUser(request, env);
    return jsonResponse({ ok: true, revision: await currentRevision(env) });
  }
  if (path === "/api/me" && method === "GET") {
    const user = await requireUser(request, env);
    return jsonResponse({ ok: true, user: publicUser(user) });
  }
  if (path === "/api/snapshot" && method === "GET") {
    const user = await requireUser(request, env);
    return jsonResponse({
      ok: true,
      data: await snapshot(env, user),
      revision: await currentRevision(env),
    });
  }
  if (path === "/api/backup" && method === "GET") {
    const user = await requireUser(request, env, ["admin"]);
    const data = await snapshot(env, user);
    delete data.users;
    delete data.me;
    await audit(env, user, "BACKUP", "database");
    return jsonResponse({ ok: true, data });
  }
  if (path === "/api/restore" && method === "POST") {
    return apiRestore(request, env);
  }
  if (path === "/api/audit" && method === "GET") {
    await requireUser(request, env, ["admin"]);
    const requested = Number(url.searchParams.get("limit") ?? 200);
    const limit = Math.min(Math.max(Number.isFinite(requested) ? requested : 200, 1), 1000);
    const rows = await dbAll(
      env.DB,
      `SELECT * FROM audit_log ORDER BY id DESC LIMIT ${Math.trunc(limit)}`,
    );
    return jsonResponse({ ok: true, data: rows });
  }
  if (path === "/api/change-password" && method === "POST") {
    return apiChangePassword(request, env);
  }
  if (path === "/api/settings" && method === "PUT") {
    return apiSettings(request, env);
  }
  if (path === "/api/item-values" && method === "PUT") {
    return apiItemValues(request, env);
  }

  let parts;
  try {
    parts = path
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
  } catch {
    throw new ApiError(400, "Đường dẫn không hợp lệ");
  }
  if (parts[0] !== "api" || !parts[1]) {
    throw new ApiError(404, "Không tìm thấy API");
  }
  const resource = parts[1];
  const entityId = parts[2] ?? "";
  const subresource = parts[3] ?? "";
  if (resource === "items" && subresource === "image") {
    return apiItemImage(request, env, method, entityId);
  }
  if (resource === "items") {
    return apiItems(request, env, method, entityId);
  }
  if (resource === "partners") {
    return apiPartners(request, env, method, entityId);
  }
  if (resource === "vouchers") {
    return apiVouchers(request, env, method, entityId);
  }
  if (resource === "users") {
    return apiUsers(request, env, method, entityId);
  }
  throw new ApiError(404, "Không tìm thấy API");
}

async function serveStatic(request, env, url) {
  if (!env.ASSETS) throw new ApiError(503, "Kho giao diện chưa được cấu hình");
  let assetRequest = request;
  if (url.pathname === "/favicon.ico") {
    const assetUrl = new URL(request.url);
    assetUrl.pathname = "/favicon.png";
    assetRequest = new Request(assetUrl, request);
  }
  const response = await env.ASSETS.fetch(assetRequest);
  const headers = new Headers(response.headers);
  const isDocument =
    headers.get("Content-Type")?.includes("text/html") ||
    url.pathname === "/" ||
    !url.pathname.split("/").at(-1)?.includes(".");
  applySecurityHeaders(
    headers,
    isDocument ? "no-cache" : "public, max-age=604800, immutable",
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function normalizeDatabaseError(error) {
  const message = String(error?.message ?? "");
  if (/UNIQUE constraint|SQLITE_CONSTRAINT_UNIQUE/i.test(message)) {
    return new ApiError(409, "Dữ liệu bị trùng hoặc đang được tham chiếu");
  }
  if (/FOREIGN KEY constraint|SQLITE_CONSTRAINT_FOREIGNKEY/i.test(message)) {
    return new ApiError(409, "Dữ liệu đang được tham chiếu hoặc không hợp lệ");
  }
  return error;
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/")) {
        return await handleApi(request, env, url);
      }
      if (url.pathname.startsWith("/images/")) {
        return await handleImageRequest(request, env, url);
      }
      return await serveStatic(request, env, url);
    } catch (rawError) {
      const error = normalizeDatabaseError(rawError);
      if (error instanceof ApiError) {
        return jsonResponse({ ok: false, error: error.message }, error.status);
      }
      console.error("WORKER_ERROR", error);
      return jsonResponse({ ok: false, error: "Lỗi máy chủ" }, 500);
    }
  },
};
