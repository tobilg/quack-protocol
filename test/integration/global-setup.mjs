import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_EXTERNAL_TOKEN = "super_secret";
const SERVER_START_TIMEOUT_MS = Number(process.env.QUACK_SERVER_START_TIMEOUT_MS ?? 30000);

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../..");
const startServerScript = resolve(repoRoot, "scripts/start-quack-server.sh");
const checkDuckdbScript = resolve(repoRoot, "scripts/check-duckdb.mjs");

export default async function setup() {
  const check = spawnSync(process.execPath, [checkDuckdbScript], { stdio: "inherit", cwd: repoRoot });
  if (check.status !== 0) {
    throw new Error(`DuckDB version check failed with status ${check.status ?? 1}`);
  }

  const providedUrl = process.env.QUACK_INTEGRATION_URL;
  const shouldStartLocalServer = !providedUrl && process.env.QUACK_START_LOCAL_SERVER !== "0";

  if (!providedUrl && !shouldStartLocalServer) {
    console.log("Set QUACK_INTEGRATION_URL or allow local startup with QUACK_START_LOCAL_SERVER=1.");
    return;
  }

  const integrationUrl = providedUrl ?? process.env.QUACK_SERVER_URI ?? `quack:127.0.0.1:${await getFreePort()}`;
  process.env.QUACK_AUTH_TOKEN ??= shouldStartLocalServer ? `quack_ts_${randomBytes(12).toString("hex")}` : DEFAULT_EXTERNAL_TOKEN;
  process.env.QUACK_INTEGRATION_URL = integrationUrl;
  process.env.QUACK_SERVER_URI ??= integrationUrl;

  if (!shouldStartLocalServer) {
    return;
  }

  const server = startLocalServer(process.env);
  try {
    await waitForServer(integrationUrl, SERVER_START_TIMEOUT_MS, server);
  } catch (error) {
    stopServer(server);
    throw error;
  }

  return () => stopServer(server);
}

function startLocalServer(env) {
  const child = spawn("bash", [startServerScript], {
    cwd: repoRoot,
    detached: true,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout?.on("data", (data) => process.stdout.write(data));
  child.stderr?.on("data", (data) => process.stderr.write(data));
  return child;
}

function stopServer(server) {
  if (!server?.pid) {
    return;
  }
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    try {
      server.kill("SIGTERM");
    } catch {
      // Ignore cleanup failures after tests have already finished.
    }
  }
}

async function waitForServer(quackUri, timeoutMs, child) {
  const url = `${quackUriToHttpBase(quackUri)}/`;
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`DuckDB Quack server exited early with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = new Error(`Readiness check returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }

  throw new Error(
    `Timed out waiting for DuckDB Quack server at ${url}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

function quackUriToHttpBase(uri) {
  if (uri.startsWith("http://") || uri.startsWith("https://")) {
    const url = new URL(uri);
    return `${url.protocol}//${url.host}`;
  }

  let rest = uri.trim();
  if (rest.startsWith("quack://")) {
    rest = rest.slice("quack://".length);
  } else if (rest.startsWith("quack:")) {
    rest = rest.slice("quack:".length);
  }

  if (rest.startsWith("[")) {
    const end = rest.indexOf("]");
    if (end < 0) {
      throw new Error(`Invalid Quack URI: ${uri}`);
    }
    const host = rest.slice(0, end + 1);
    const suffix = rest.slice(end + 1);
    const port = suffix.startsWith(":") ? suffix.slice(1) : "9494";
    return `http://${host}:${port}`;
  }

  const parts = rest.split(":");
  if (parts.length > 2) {
    throw new Error(`IPv6 Quack URI hosts must be bracketed: ${uri}`);
  }
  const host = parts[0];
  const port = parts[1] ?? "9494";
  return `http://${host}:${port}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate an integration test port")));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}
