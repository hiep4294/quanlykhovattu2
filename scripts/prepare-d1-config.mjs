import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(SCRIPT_FILE), "..");
const SOURCE_CONFIG = path.join(PROJECT_ROOT, "wrangler.jsonc");
export const RESOLVED_CONFIG = path.join(PROJECT_ROOT, "wrangler.resolved.jsonc");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function stripAnsi(value) {
  return String(value).replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

function npxCommand() {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

function runWrangler(args, { allowFailure = false } = {}) {
  const result = spawnSync(
    npxCommand(),
    ["--no-install", "wrangler", ...args],
    {
      cwd: PROJECT_ROOT,
      env: process.env,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    const detail = stripAnsi(result.stderr || result.stdout).trim();
    throw new Error(detail || `Wrangler dừng với mã ${result.status}`);
  }
  return {
    ok: result.status === 0,
    stdout: stripAnsi(result.stdout),
    stderr: stripAnsi(result.stderr),
  };
}

export function parseDatabaseList(value) {
  const parsed = typeof value === "string" ? JSON.parse(value.trim()) : value;
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.result)) return parsed.result;
  throw new Error("Cloudflare không trả về danh sách D1 hợp lệ");
}

export function makeResolvedConfig(source, database) {
  const databaseId = String(database?.uuid || database?.id || "").trim();
  const databaseName = String(database?.name || "").trim();
  if (!UUID_PATTERN.test(databaseId)) {
    throw new Error("Database ID của D1 không hợp lệ");
  }
  if (!databaseName) throw new Error("Tên cơ sở dữ liệu D1 đang trống");

  const previous = Array.isArray(source.d1_databases)
    ? source.d1_databases
    : [];
  const currentBinding = previous.find((entry) => entry?.binding === "DB") || {};
  const otherBindings = previous.filter((entry) => entry?.binding !== "DB");

  return {
    ...source,
    d1_databases: [
      ...otherBindings,
      {
        binding: "DB",
        database_name: databaseName,
        database_id: databaseId,
        migrations_dir: currentBinding.migrations_dir || "migrations",
      },
    ],
  };
}

function listDatabases() {
  const result = runWrangler([
    "d1",
    "list",
    "--json",
    "--config",
    SOURCE_CONFIG,
  ]);
  return parseDatabaseList(result.stdout);
}

function exactDatabase(databases, databaseName) {
  return databases.find(
    (database) =>
      String(database?.name || "").toLocaleLowerCase("en-US") ===
      databaseName.toLocaleLowerCase("en-US"),
  );
}

function createDatabase(databaseName) {
  const location = String(process.env.D1_LOCATION || "apac").trim();
  const allowedLocations = new Set(["wnam", "enam", "weur", "eeur", "apac", "oc"]);
  const args = ["d1", "create", databaseName];
  if (allowedLocations.has(location)) args.push("--location", location);
  return runWrangler(args, { allowFailure: true });
}

export async function prepareD1Config() {
  const source = JSON.parse(await readFile(SOURCE_CONFIG, "utf8"));
  const databaseName = String(
    process.env.D1_DATABASE_NAME || `${source.name}-db`,
  ).trim();
  if (!databaseName) throw new Error("D1_DATABASE_NAME đang trống");

  const suppliedId = String(
    process.env.CLOUDFLARE_D1_DATABASE_ID || process.env.D1_DATABASE_ID || "",
  ).trim();
  let database;

  if (suppliedId) {
    database = { name: databaseName, uuid: suppliedId };
  } else {
    database = exactDatabase(listDatabases(), databaseName);
    if (!database) {
      const creation = createDatabase(databaseName);
      database = exactDatabase(listDatabases(), databaseName);
      if (!database) {
        const detail = (creation.stderr || creation.stdout).trim();
        throw new Error(
          detail || `Không thể tạo cơ sở dữ liệu D1 "${databaseName}"`,
        );
      }
    }
  }

  const resolved = makeResolvedConfig(source, database);
  await mkdir(path.dirname(RESOLVED_CONFIG), { recursive: true });
  await writeFile(
    RESOLVED_CONFIG,
    `${JSON.stringify(resolved, null, 2)}\n`,
    "utf8",
  );
  console.log(`Đã liên kết D1 "${databaseName}" với binding DB.`);
  return RESOLVED_CONFIG;
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(SCRIPT_FILE);

if (isMain) {
  prepareD1Config().catch((error) => {
    console.error(`Lỗi chuẩn bị D1: ${error.message}`);
    process.exitCode = 1;
  });
}
