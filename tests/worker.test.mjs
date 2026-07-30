import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import worker, {
  cleanText,
  isValidIsoDate,
  num,
  passwordHash,
  passwordVerify,
} from "../src/worker.js";


class D1StatementMock {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.bindings = [];
  }

  bind(...bindings) {
    this.bindings = bindings;
    return this;
  }

  first() {
    return this.database.prepare(this.sql).get(...this.bindings) ?? null;
  }

  all() {
    return {
      success: true,
      results: this.database.prepare(this.sql).all(...this.bindings),
    };
  }

  run() {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return {
      success: true,
      meta: {
        changes: Number(result.changes ?? 0),
        last_row_id: Number(result.lastInsertRowid ?? 0),
      },
      results: [],
    };
  }
}


class D1Mock {
  constructor() {
    this.database = new DatabaseSync(":memory:");
    this.database.exec("PRAGMA foreign_keys=ON");
  }

  prepare(sql) {
    return new D1StatementMock(this.database, sql);
  }

  async batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}


function applyMigrations(db) {
  const directory = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
    db.database.exec(readFileSync(new URL(file, directory), "utf8"));
  }
}


function createEnvironment() {
  const DB = new D1Mock();
  applyMigrations(DB);
  return {
    DB,
    ASSETS: {
      fetch: async () =>
        new Response("<!doctype html><title>KODSDOOR</title>", {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
    },
    SESSION_DAYS: "7",
    ADMIN_PASSWORD: "admin-test-5291",
    KEEPER_PASSWORD: "keeper-test-5291",
    VIEWER_PASSWORD: "viewer-test-5291",
    SESSION_SECRET: "integration-test-session-secret-at-least-32-characters",
  };
}


async function request(env, path, options = {}) {
  const headers = new Headers(options.headers);
  if (options.json !== undefined) {
    headers.set("Content-Type", "application/json");
    headers.set("Origin", "https://kho.example.test");
  }
  if (options.cookie) headers.set("Cookie", options.cookie);
  const response = await worker.fetch(
    new Request(`https://kho.example.test${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.json === undefined ? undefined : JSON.stringify(options.json),
    }),
    env,
  );
  let body = null;
  if (response.headers.get("Content-Type")?.includes("application/json")) {
    body = await response.json();
  }
  return { response, body };
}


async function login(env, username, password) {
  const result = await request(env, "/api/login", {
    method: "POST",
    json: { username, password },
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  const cookie = result.response.headers.get("Set-Cookie").split(";", 1)[0];
  return cookie;
}


test("pure helpers handle dates, numbers and compatible passwords", async () => {
  assert.equal(isValidIsoDate("2026-07-30"), true);
  assert.equal(isValidIsoDate("2026-02-30"), false);
  assert.equal(num("12.5"), 12.5);
  assert.equal(num("không phải số"), 0);
  assert.equal(cleanText("  KHO  ", 10), "KHO");
  const encoded = await passwordHash("mat-khau-thu", 10_000);
  assert.equal(await passwordVerify("mat-khau-thu", encoded), true);
  assert.equal(await passwordVerify("sai", encoded), false);
});


test("full warehouse API keeps the original workflow and permissions", async () => {
  const env = createEnvironment();

  const health = await request(env, "/api/health");
  assert.equal(health.response.status, 200);

  const wrong = await request(env, "/api/login", {
    method: "POST",
    json: { username: "admin", password: "sai-mat-khau" },
  });
  assert.equal(wrong.response.status, 401);

  const adminCookie = await login(env, "admin", env.ADMIN_PASSWORD);
  const initial = await request(env, "/api/snapshot", { cookie: adminCookie });
  assert.equal(initial.response.status, 200);
  assert.equal(initial.body.data.items.length, 219);
  assert.equal(initial.body.data.users.length, 3);

  const item = await request(env, "/api/items", {
    method: "POST",
    cookie: adminCookie,
    json: {
      code: "VT-TEST-CF",
      name: "Vật tư kiểm thử Cloudflare",
      unit: "Cái",
      category: "KIỂM THỬ",
      itemType: "D1",
      opening: 0,
      minStock: 2,
      unitPrice: 125000,
      note: "Kiểm thử tự động",
    },
  });
  assert.equal(item.response.status, 200, JSON.stringify(item.body));
  const itemId = item.body.id;

  const partner = await request(env, "/api/partners", {
    method: "POST",
    cookie: adminCookie,
    json: {
      code: "NCC-TEST",
      name: "Nhà cung cấp kiểm thử",
      address: "Hà Nội",
    },
  });
  assert.equal(partner.response.status, 200, JSON.stringify(partner.body));

  const settings = await request(env, "/api/settings", {
    method: "PUT",
    cookie: adminCookie,
    json: {
      company: {
        name: "CÔNG TY CỔ PHẦN KODSDOOR VIỆT NAM",
        address: "Hà Nội",
        taxCode: "0108276927",
      },
      defaultWarehouse: "Kho công ty",
      allowNegative: false,
    },
  });
  assert.equal(settings.response.status, 200);

  const today = "2026-07-30";
  const incoming = await request(env, "/api/vouchers", {
    method: "POST",
    cookie: adminCookie,
    json: {
      type: "IN",
      date: today,
      partnerId: partner.body.id,
      warehouse: "Kho công ty",
      description: "Nhập thử",
      lines: [
        {
          itemId,
          quantity: 5,
          condition: "Mới",
          note: "",
        },
      ],
    },
  });
  assert.equal(incoming.response.status, 200, JSON.stringify(incoming.body));
  assert.match(incoming.body.number, /^PNK-20260730-/);

  const outgoing = await request(env, "/api/vouchers", {
    method: "POST",
    cookie: adminCookie,
    json: {
      type: "OUT",
      date: today,
      partnerName: "Bộ phận sản xuất",
      warehouse: "Kho công ty",
      description: "Xuất thử",
      lines: [
        {
          itemId,
          quantity: 3,
          condition: "Mới",
          note: "",
        },
      ],
    },
  });
  assert.equal(outgoing.response.status, 200, JSON.stringify(outgoing.body));
  assert.match(outgoing.body.number, /^PXK-20260730-/);

  const overStock = await request(env, "/api/vouchers", {
    method: "POST",
    cookie: adminCookie,
    json: {
      type: "OUT",
      date: today,
      warehouse: "Kho công ty",
      lines: [
        {
          itemId,
          quantity: 3,
          condition: "Mới",
          note: "",
        },
      ],
    },
  });
  assert.equal(overStock.response.status, 409);

  const onePixelPng =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const upload = await request(env, `/api/items/${itemId}/image`, {
    method: "POST",
    cookie: adminCookie,
    json: { dataUrl: onePixelPng, filename: "test.png" },
  });
  assert.equal(upload.response.status, 200, JSON.stringify(upload.body));
  const storedImage = env.DB.database
    .prepare(
      "SELECT item_id,mime_type,size_bytes,length(image_data) AS stored_bytes " +
        "FROM item_images WHERE item_id=?",
    )
    .get(itemId);
  assert.equal(storedImage.item_id, itemId);
  assert.equal(storedImage.mime_type, "image/png");
  assert.equal(storedImage.size_bytes, storedImage.stored_bytes);
  assert.ok(storedImage.size_bytes > 0 && storedImage.size_bytes <= 300 * 1024);

  const oversizedImage =
    "data:image/webp;base64," +
    Buffer.alloc(300 * 1024 + 1).toString("base64");
  const rejectedImage = await request(env, `/api/items/${itemId}/image`, {
    method: "POST",
    cookie: adminCookie,
    json: { dataUrl: oversizedImage, filename: "qua-lon.webp" },
  });
  assert.equal(rejectedImage.response.status, 400);

  const after = await request(env, "/api/snapshot", { cookie: adminCookie });
  const savedItem = after.body.data.items.find((row) => row.id === itemId);
  assert.equal(savedItem.opening, 0);
  assert.match(savedItem.imageUrl, /^\/images\//);
  assert.equal(after.body.data.vouchers.length, 2);
  assert.equal(after.body.data.transactions.length, 2);

  const image = await request(env, savedItem.imageUrl.split("?")[0], {
    cookie: adminCookie,
  });
  assert.equal(image.response.status, 200);
  assert.equal(image.response.headers.get("Content-Type"), "image/png");

  const backup = await request(env, "/api/backup", { cookie: adminCookie });
  assert.equal(backup.response.status, 200);
  assert.equal("users" in backup.body.data, false);
  assert.equal("me" in backup.body.data, false);

  const viewerCookie = await login(env, "xem", env.VIEWER_PASSWORD);
  const viewerSnapshot = await request(env, "/api/snapshot", {
    cookie: viewerCookie,
  });
  assert.equal(viewerSnapshot.response.status, 200);
  assert.equal("users" in viewerSnapshot.body.data, false);

  const forbidden = await request(env, "/api/items", {
    method: "POST",
    cookie: viewerCookie,
    json: { code: "X", name: "X", unit: "X" },
  });
  assert.equal(forbidden.response.status, 403);

  const auditLog = await request(env, "/api/audit?limit=200", {
    cookie: adminCookie,
  });
  assert.equal(auditLog.response.status, 200);
  assert.ok(auditLog.body.data.length >= 8);

  const restored = await request(env, "/api/restore", {
    method: "POST",
    cookie: adminCookie,
    json: { data: backup.body.data },
  });
  assert.equal(restored.response.status, 200, JSON.stringify(restored.body));
  const afterRestore = await request(env, "/api/snapshot", { cookie: adminCookie });
  const restoredItem = afterRestore.body.data.items.find((row) => row.id === itemId);
  assert.match(restoredItem.imageUrl, /^\/images\//);
  const restoredImage = await request(
    env,
    restoredItem.imageUrl.split("?")[0],
    { cookie: adminCookie },
  );
  assert.equal(restoredImage.response.status, 200);

  const staticPage = await request(env, "/");
  assert.equal(staticPage.response.status, 200);
  assert.match(staticPage.response.headers.get("Content-Security-Policy"), /default-src/);
});
