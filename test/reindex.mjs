// reindex.mjs — bulk reindex contract for engine.reindex() and the
// POST /reindex HTTP route (s2-06-bulk-reindex).
//
// Verifies:
//   AC1  reindex(scope) scans a directory for .ts/.md/.yaml files and shells
//        out to `swarm-memory index <collection> <file>` for each
//   AC2  POST /reindex returns 202 {job_id, scope, status: "running"}
//        immediately (does not block on the reindex itself), and the job's
//        outcome is observable via GET /reindex/:job_id (PANT-837; the
//        stubbed-reindex() job contract lives in test/reindex-jobs.mjs)
//   AC3  reindexing the same scope twice is idempotent: both runs succeed
//        cleanly with no errors (swarm-memory's own dedupe is trusted; this
//        suite only proves Mnemosyne never treats a repeat run as an error)
//   AC4  a failure on one file does not abort the run — it is collected in
//        `errors` and the remaining files still get indexed; since indexing
//        is idempotent, a full retry after a partial failure is always safe
//
// Uses the fake-swarm-memory test double (same fixture as write-through.mjs)
// so this suite never touches Qdrant.
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const FIXTURE = fileURLToPath(new URL("./fixtures/fake-swarm-memory", import.meta.url));

let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "  PASS" : "  FAIL"}  ${m}`);
  if (!c) fails++;
};

let seq = 0;
async function loadEngine(mode) {
  process.env.SWARM_MEMORY_BIN = FIXTURE;
  process.env.FAKE_SWARM_MODE = mode;
  process.env.MNEMO_TEST_NODE = process.execPath;
  seq += 1;
  return import(`../src/engine.mjs?reindex-scenario=${mode}-${seq}`);
}

async function withCapturedStderr(fn) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return lines;
}

async function makeScanDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "mnemosyne-reindex-"));
  await writeFile(path.join(dir, "a.ts"), "export const a = 1;\n", "utf8");
  await writeFile(path.join(dir, "b.md"), "# b\n", "utf8");
  await writeFile(path.join(dir, "c.yaml"), "c: 1\n", "utf8");
  await writeFile(path.join(dir, "ignored.txt"), "not indexable\n", "utf8");
  await mkdir(path.join(dir, "node_modules"), { recursive: true });
  await writeFile(path.join(dir, "node_modules", "d.ts"), "export const d = 1;\n", "utf8");
  return dir;
}

// --- AC1: scans recognized extensions, skips ignored dirs/extensions -------
{
  const { reindex } = await loadEngine("success");
  const dir = await makeScanDir();
  try {
    const result = await reindex("personal", { directory: dir });
    ok(result.files_scanned === 3, `AC1: scans only .ts/.md/.yaml, skips ignored -> got ${result.files_scanned}`);
    ok(result.files_indexed === 3, `AC1: indexes every scanned file -> got ${result.files_indexed}`);
    ok(result.errors.length === 0, `AC1: no errors on a clean run -> got ${result.errors.length}`);
    ok(result.collection === "test_collection", `AC1: resolves scope -> collection -> got ${result.collection}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --- unknown scope -> loud failure, mirrors remember()'s contract ----------
{
  const { reindex } = await loadEngine("success");
  const dir = await makeScanDir();
  try {
    let error = null;
    try {
      await reindex("no-such-scope", { directory: dir });
    } catch (e) {
      error = e;
    }
    ok(!!error, "unknown scope: reindex() rejects instead of silently defaulting");
    ok(error?.status === 400, `unknown scope: rejection carries status 400 -> got ${error?.status}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --- AC3: idempotency — running reindex twice is clean both times ----------
{
  const { reindex } = await loadEngine("success");
  const dir = await makeScanDir();
  try {
    const first = await reindex("personal", { directory: dir });
    const second = await reindex("personal", { directory: dir });
    ok(first.errors.length === 0 && second.errors.length === 0, "AC3: two consecutive reindexes both report zero errors");
    ok(
      first.files_indexed === second.files_indexed,
      `AC3: repeat run indexes the same file count -> ${first.files_indexed} then ${second.files_indexed}`
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --- AC4: one bad file doesn't abort the run; failure is reported ----------
// then a full retry (rename away the bad file, matching a real fix) is clean.
{
  const { reindex } = await loadEngine("success");
  const dir = await makeScanDir();
  const badFile = path.join(dir, "REINDEX_FAIL-broken.md");
  const fixedFile = path.join(dir, "broken.md");
  await writeFile(badFile, "this file's index call will fail\n", "utf8");
  try {
    let result;
    const stderrLines = await withCapturedStderr(async () => {
      result = await reindex("personal", { directory: dir });
    });
    ok(result.files_scanned === 4, `AC4: still scans the bad file -> got ${result.files_scanned}`);
    ok(result.files_indexed === 3, `AC4: good files still get indexed -> got ${result.files_indexed}`);
    ok(result.errors.length === 1, `AC4: bad file reported in errors, not thrown -> got ${result.errors.length}`);
    ok(result.errors[0]?.file === badFile, `AC4: error identifies the failing file -> ${result.errors[0]?.file}`);
    ok(
      stderrLines.some((l) => l.includes("ERROR")),
      `AC4: stderr logs an ERROR-prefixed line for the bad file -> ${JSON.stringify(stderrLines)}`
    );

    // Retry after partial failure: fix the file (rename away the trigger)
    // and rerun the whole scope — safe, since indexing is idempotent, so no
    // resume bookkeeping is needed; already-indexed files just re-upsert.
    await rm(badFile);
    await writeFile(fixedFile, "fixed now\n", "utf8");
    const retried = await reindex("personal", { directory: dir });
    ok(retried.errors.length === 0, `AC4 retry: full rerun after fixing the file reports zero errors -> got ${retried.errors.length}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --- AC2: POST /reindex returns immediately with an observable job ---------
{
  const PORT = 31417;
  const BASE = `http://127.0.0.1:${PORT}`;
  const dir = await makeScanDir();
  // The job's read-only collectionExists() pre-check shells out to
  // $MNEMOSYNE_PYTHON_BIN; point it at a stub that reports "exists" so this
  // suite stays off Qdrant.
  const pyStub = path.join(dir, "fake-python");
  await writeFile(pyStub, `#!/bin/sh\necho '{"exists": true}'\n`, "utf8");
  await chmod(pyStub, 0o755);

  const child = spawn(process.execPath, [path.join(ROOT, "src", "server.mjs")], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      SWARM_MEMORY_BIN: FIXTURE,
      FAKE_SWARM_MODE: "success",
      MNEMO_TEST_NODE: process.execPath,
      MNEMOSYNE_PYTHON_BIN: pyStub,
      MNEMOSYNE_REINDEX_ROOTS: dir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let serverOutput = "";
  child.stdout.on("data", (c) => (serverOutput += c));
  child.stderr.on("data", (c) => (serverOutput += c));

  try {
    const deadline = Date.now() + 15000;
    let up = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${BASE}/healthz`);
        if (res.ok) {
          up = true;
          break;
        }
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    ok(up, "AC2: server started and is reachable");
    if (!up) {
      console.error(serverOutput);
      throw new Error("server never became reachable");
    }

    const start = Date.now();
    const res = await fetch(`${BASE}/reindex`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "personal", directory: dir }),
    });
    const elapsedMs = Date.now() - start;
    const body = await res.json();

    ok(res.status === 202, `AC2: POST /reindex -> 202 (got ${res.status})`);
    ok(body.status === "running" && typeof body.job_id === "string",
      `AC2: POST /reindex -> {job_id, status: "running"} (got ${JSON.stringify(body)})`);
    ok(body.scope === "personal", `AC2: POST /reindex echoes scope -> got ${body.scope}`);
    ok(elapsedMs < 2000, `AC2: POST /reindex returns immediately, not after the run completes -> took ${elapsedMs}ms`);

    // missing scope -> 400
    const missingScope = await fetch(`${BASE}/reindex`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ directory: dir }),
    });
    ok(missingScope.status === 400, `POST /reindex (missing scope) -> 400 (got ${missingScope.status})`);

    // background run completes and its outcome is readable from the job
    const jobDeadline = Date.now() + 5000;
    let job = null;
    while (Date.now() < jobDeadline) {
      job = await (await fetch(`${BASE}/reindex/${body.job_id}`)).json();
      if (job.status !== "running") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    ok(job?.status === "succeeded", `AC2: background reindex job succeeds -> ${JSON.stringify(job)}${job?.status === "succeeded" ? "" : ` ${serverOutput}`}`);
    ok(job?.files_scanned === 3 && job?.files_indexed === 3,
      `AC2: job reports the real scan counts (3/3) -> ${job?.files_indexed}/${job?.files_scanned}`);
  } finally {
    child.kill();
    await rm(dir, { recursive: true, force: true });
  }
}

console.log(fails ? `\n${fails} check(s) failed` : "\nall reindex checks passed");
process.exit(fails ? 1 : 0);
