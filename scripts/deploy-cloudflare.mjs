import { mkdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareD1Config, RESOLVED_CONFIG } from "./prepare-d1-config.mjs";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const SECRETS_FILE = path.join(
  PROJECT_ROOT,
  ".wrangler",
  "deploy",
  "secrets.json",
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

function deploymentSecrets() {
  const names = [
    "ADMIN_PASSWORD",
    "KEEPER_PASSWORD",
    "VIEWER_PASSWORD",
    "SESSION_SECRET",
  ];
  return Object.fromEntries(
    names
      .map((name) => [name, String(process.env[name] || "")])
      .filter(([, value]) => value.length > 0),
  );
}

async function main() {
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

  const secrets = deploymentSecrets();
  const deployArgs = [
    "deploy",
    "--config",
    RESOLVED_CONFIG,
    "--no-x-provision",
  ];

  try {
    if (Object.keys(secrets).length > 0) {
      await mkdir(path.dirname(SECRETS_FILE), { recursive: true });
      await writeFile(SECRETS_FILE, `${JSON.stringify(secrets)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      deployArgs.push("--secrets-file", SECRETS_FILE);
    }
    runWrangler(deployArgs);
  } finally {
    await rm(SECRETS_FILE, { force: true });
  }
}

main().catch((error) => {
  console.error(`Triển khai thất bại: ${error.message}`);
  process.exitCode = 1;
});
