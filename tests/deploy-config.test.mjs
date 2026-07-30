import assert from "node:assert/strict";
import test from "node:test";
import {
  makeResolvedConfig,
  parseDatabaseList,
} from "../scripts/prepare-d1-config.mjs";

const DATABASE_ID = "123e4567-e89b-42d3-a456-426614174000";

test("đọc được cả đầu ra Wrangler và đầu ra Cloudflare API", () => {
  assert.equal(
    parseDatabaseList(JSON.stringify([{ name: "warehouse", uuid: DATABASE_ID }]))
      .length,
    1,
  );
  assert.equal(
    parseDatabaseList({
      success: true,
      result: [{ name: "warehouse", uuid: DATABASE_ID }],
    })[0].uuid,
    DATABASE_ID,
  );
});

test("tạo cấu hình DB đã liên kết và giữ nguyên các binding khác", () => {
  const result = makeResolvedConfig(
    {
      name: "quanlykhovattu2",
      d1_databases: [
        { binding: "ARCHIVE", database_id: DATABASE_ID },
        { binding: "DB", migrations_dir: "migrations" },
      ],
    },
    { name: "quanlykhovattu2-db", uuid: DATABASE_ID },
  );

  assert.equal(result.d1_databases.length, 2);
  assert.deepEqual(result.d1_databases[1], {
    binding: "DB",
    database_name: "quanlykhovattu2-db",
    database_id: DATABASE_ID,
    migrations_dir: "migrations",
  });
});

test("chặn Database ID sai định dạng", () => {
  assert.throws(
    () =>
      makeResolvedConfig(
        { name: "quanlykhovattu2", d1_databases: [] },
        { name: "quanlykhovattu2-db", uuid: "sai-id" },
      ),
    /không hợp lệ/,
  );
});
