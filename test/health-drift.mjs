// health-drift.mjs - /health drift reporting contract for src/server.mjs.
//
// Verifies mc-03-health-drift-reporting:
//   - GET /health includes drift_count from mnemosyne-reconcile --json.
//   - drift_count: 0 and drift_count > 0 are both surfaced.
//   - GET /health includes a parseable last_check timestamp.
//   - A god-card style freshness check flags health payloads older than 5 min.
//   - Reconcile failures are explicit as drift_count:null, not hidden/omitted.
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 33000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = process.cwd();
const FIVE_MINUTES_MS = 5 * 60 * 1000;

let fails = 0;
const ok = (condition, message) => {
  console.log(`${condition ? "  PASS" : "  FAIL"}  ${message}`);
  if (!condition) fails++;
};

async function main() {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "mnemosyne-health-drift-"));
  const fakeSwarm = path.join(tempRoot, "fake-swarm-memory.mjs");
  const fakeReconcile = path.join(tempRoot, "fake-reconcile.mjs");
  const stateFile = path.join(tempRoot, "reconcile-state.json");

  await writeFakeSwarm(fakeSwarm);
  await writeFakeReconcile(fakeReconcile);
  await writeState(stateFile, "0");

  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      SWARM_MEMORY_BIN: fakeSwarm,
      MNEMOSYNE_RECONCILE_BIN: fakeReconcile,
      FAKE_RECONCILE_STATE: stateFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let serverOutput = "";
  child.stdout.on("data", (chunk) => {
    serverOutput += chunk;
  });
  child.stderr.on("data", (chunk) => {
    serverOutput += chunk;
  });

  try {
    const up = await waitForHealth(15_000);
    ok(up, "server started and /health is reachable");
    if (!up) {
      throw new Error(`server never became reachable:\n${serverOutput}`);
    }

    const noDrift = await j("GET", "/health");
    ok(noDrift.status === 200, `GET /health no drift -> 200 (got ${noDrift.status})`);
    ok(noDrift.body.ok === true, "GET /health no drift -> ok:true");
    ok(noDrift.body.drift_count === 0, `GET /health no drift -> drift_count:0 (got ${noDrift.body.drift_count})`);
    ok(isIsoTimestamp(noDrift.body.last_check), `GET /health includes ISO last_check -> ${noDrift.body.last_check}`);
    ok(godCardFlagsStale(noDrift.body) === false, "fresh health payload is not stale");

    await writeState(stateFile, "3");
    const drift = await j("GET", "/health");
    ok(drift.status === 200, `GET /health with drift -> 200 (got ${drift.status})`);
    ok(drift.body.drift_count === 3, `GET /health with drift -> drift_count:3 (got ${drift.body.drift_count})`);

    const stalePayload = {
      ...drift.body,
      last_check: new Date(Date.now() - FIVE_MINUTES_MS - 1_000).toISOString(),
    };
    ok(godCardFlagsStale(stalePayload) === true, "god-card freshness rule flags cached health older than 5 minutes");

    await writeState(stateFile, "error");
    const reconcileFailure = await j("GET", "/health");
    ok(reconcileFailure.status === 200, `GET /health reconcile failure -> 200 (got ${reconcileFailure.status})`);
    ok(reconcileFailure.body.drift_count === null, "GET /health reconcile failure -> drift_count:null");
    ok(
      typeof reconcileFailure.body.reconcile_error === "string" && reconcileFailure.body.reconcile_error.length > 0,
      "GET /health reconcile failure -> includes reconcile_error",
    );
  } finally {
    await stopChild(child);
    await rm(tempRoot, { recursive: true, force: true });
  }

  console.log(fails ? `\n${fails} check(s) failed` : "\nall health drift checks passed");
  process.exit(fails ? 1 : 0);
}

async function writeFakeSwarm(filePath) {
  await writeFile(
    filePath,
    `#!/bin/sh
if [ "$1" = "check" ]; then
  printf 'result: PASS\\n'
  exit 0
fi
printf 'fake swarm-memory: unknown command %s\\n' "$1" >&2
exit 2
`,
    "utf8",
  );
  await chmod(filePath, 0o755);
}

async function writeFakeReconcile(filePath) {
  await writeFile(
    filePath,
    `#!/bin/sh
state="$(cat "$FAKE_RECONCILE_STATE")"
if [ "$state" = "error" ]; then
  printf 'fake reconcile: Qdrant unavailable\\n' >&2
  exit 2
fi
printf '{"drift_count":%s,"missing_files":[]}' "$state"
if [ "$state" = "0" ]; then
  exit 0
fi
exit 1
`,
    "utf8",
  );
  await chmod(filePath, 0o755);
}

async function writeState(filePath, state) {
  await writeFile(filePath, String(state), "utf8");
}

async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.status === 200 || res.status === 503) return true;
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function j(method, pathname) {
  const res = await fetch(BASE + pathname, { method });
  return { status: res.status, body: await res.json() };
}

function isIsoTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function godCardFlagsStale(payload, now = Date.now()) {
  const checkedAt = Date.parse(payload.last_check || "");
  return !Number.isFinite(checkedAt) || now - checkedAt > FIVE_MINUTES_MS;
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
