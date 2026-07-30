import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareD1Config, RESOLVED_CONFIG } from "./prepare-d1-config.mjs";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function runWrangler(args) {
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(command, ["--no-install", "wrangler", ...args], {
    cwd: PROJECT_ROOT,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Wrangler dừng với mã ${result.status}`);
  }
}

await prepareD1Config();
runWrangler([
  "d1",
  "migrations",
  "apply",
  "DB",
  "--remote",
  "--config",
  RESOLVED_CONFIG,
  "--no-x-provision",
]);
