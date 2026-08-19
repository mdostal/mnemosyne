// e2e.mjs - Minerva-style Mnemosyne consumption test.
//
// Exercises the slice-2 path a Pantheon god uses:
//   import MnemosyneClient -> recall("authentication flow", "project")
//   -> vector hits with provenance -> file fallback when vector is degraded
//   -> POST /recall parity through the client HTTP API -> fresh reindex
//   provenance.
//
// Usage: npm run test:e2e

import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { MnemosyneClient } from "../lib/mnemosyne/client.js";
import { VectorLayerAdapter } from "../lib/mnemosyne/layers/VectorLayerAdapter.js";

const execFileAsync = promisify(execFile);
const QUERY = "authentication flow";
const SCOPE = "project";
const PORT = 32141 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;

let fails = 0;
const ok = (condition, message) => {
  console.log(`${condition ? "  PASS" : "  FAIL"}  ${message}`);
  if (!condition) fails++;
};

async function main() {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "mnemosyne-e2e-"));
  const projectRoot = path.join(tempRoot, "minerva-project");
  const fakeSwarm = path.join(tempRoot, "fake-swarm-memory.mjs");
  const stateFile = path.join(tempRoot, "fake-swarm-memory-state.json");

  await mkdir(projectRoot, { recursive: true });
  await writeFile(
    path.join(projectRoot, "notes.md"),
    [
      "# Minerva auth note",
      "The authentication flow starts at login and validates redirect state before issuing session cookies.",
      "Unrelated planning text.",
    ].join("\n"),
    "utf8",
  );

  const initialIndexedAt = "2026-08-09T00:00:00.000Z";
  await writeFile(
    stateFile,
    JSON.stringify({
      indexed_at: initialIndexedAt,
      retrieved_at: "2026-08-09T00:00:01.000Z",
    }),
    "utf8",
  );
  await writeFakeSwarmMemory(fakeSwarm);

  const previousMode = process.env.FAKE_SWARM_MEMORY_MODE;
  const previousState = process.env.FAKE_SWARM_MEMORY_STATE;
  process.env.FAKE_SWARM_MEMORY_MODE = "hits";
  process.env.FAKE_SWARM_MEMORY_STATE = stateFile;

  const vectorLayer = new VectorLayerAdapter({ command: fakeSwarm, timeoutMs: 2_000 });
  const client = new MnemosyneClient({ rootDirectory: projectRoot, vectorLayer });
  let child;

  try {
    const vectorResult = await client.recall(QUERY, SCOPE);
    ok(vectorResult.ok === true, "library recall returns RecallSuccess");
    ok(vectorResult.ok && vectorResult.hits.length > 0, "library recall returns hits");
    ok(
      vectorResult.ok && vectorResult.hits.every((hit) => hit.provenance.layer === "vector"),
      "library recall returns vector-layer hits",
    );
    ok(
      vectorResult.ok && JSON.stringify(vectorResult.layers_queried) === JSON.stringify(["vector"]),
      `library recall records queried layers -> ${vectorResult.ok ? vectorResult.layers_queried.join(",") : "failed"}`,
    );
    ok(
      vectorResult.ok && !!vectorResult.hits[0]?.provenance.index_timestamp,
      "vector hit includes provenance.index_timestamp",
    );

    process.env.FAKE_SWARM_MEMORY_MODE = "error";
    const degradedResult = await client.recall(QUERY, SCOPE);
    ok(degradedResult.ok === true, "library recall succeeds when vector layer is unavailable");
    ok(
      degradedResult.ok && degradedResult.degraded === true,
      "vector failure is reported with degraded:true",
    );
    ok(
      degradedResult.ok && degradedResult.layers_skipped.some((skip) => skip.layer === "vector"),
      "vector failure is reported in layers_skipped",
    );
    ok(
      degradedResult.ok && degradedResult.layers_queried.includes("file"),
      "fallback queries file layer",
    );
    ok(
      degradedResult.ok && degradedResult.hits.some((hit) => hit.provenance.layer === "file"),
      "fallback returns file-layer hits",
    );

    process.env.FAKE_SWARM_MEMORY_MODE = "hits";
    child = await startClientHttpApi({ rootDirectory: projectRoot, fakeSwarm, stateFile });
    const httpLibraryResult = await client.recall(QUERY, SCOPE);
    const httpResult = await j("POST", "/recall", { query: QUERY, scope: SCOPE });
    ok(httpResult.status === 200, `POST /recall returns 200 (got ${httpResult.status})`);
    ok(
      JSON.stringify(normalizeRecall(httpResult.body)) === JSON.stringify(normalizeRecall(httpLibraryResult)),
      "POST /recall returns the same recall result as library import",
    );

    const reindexStartedAt = Date.now();
    await execFileAsync(fakeSwarm, ["index", projectRoot], {
      env: {
        ...process.env,
        FAKE_SWARM_MEMORY_STATE: stateFile,
      },
    });

    const freshResult = await client.recall(QUERY, SCOPE);
    const freshTimestamp =
      freshResult.ok ? freshResult.hits[0]?.provenance.index_timestamp : undefined;
    ok(
      !!freshTimestamp && Date.parse(freshTimestamp) >= reindexStartedAt,
      `recall after reindex has fresh index_timestamp -> ${freshTimestamp ?? "missing"}`,
    );
  } finally {
    if (child) await stopChild(child);
    restoreEnv("FAKE_SWARM_MEMORY_MODE", previousMode);
    restoreEnv("FAKE_SWARM_MEMORY_STATE", previousState);
    await rm(tempRoot, { recursive: true, force: true });
  }

  // mc-06: layer-coherence + drift-detection extension (AC1-AC4). Runs
  // against a second, independent src/server.mjs (the JS zero-dep HTTP
  // service) instance -- the recall/remember round-trip above exercises
  // lib/mnemosyne/server.ts + client.js instead, which has no /remember
  // route at all, so it cannot carry this story's write-then-recall +
  // drift assertions.
  await testConsistencyAndDrift();

  console.log(fails ? `\n${fails} check(s) failed` : "\nall e2e checks passed");
  process.exit(fails ? 1 : 0);
}

// testConsistencyAndDrift — mc-06-consistency-e2e-test's own extension:
//   AC1  POST /remember succeeds -> note file exists on disk at the returned path
//   AC2  POST /recall's top hit carries provenance.full_path whose basename
//        matches the remembered file -- proves file layer and vector layer
//        agree on WHERE the note landed, not just THAT something did
//   AC3  GET /health after a successful remember -> drift_count === 0
//   AC4  A simulated Qdrant/vector upsert failure (index the CLI shells out
//        to for the upsert exits non-zero) still leaves the note file on
//        disk -- mc-01's write-through recovery contract -- so the file
//        layer and vector layer now genuinely disagree; GET /health's real
//        reconcile pass (bin/mnemosyne-reconcile, unmocked) must catch that
//        as drift_count > 0, not silently report clean.
//
// Uses its own fake swarm-memory CLI double (writeFakeSwarmMemoryDrift)
// rather than the recall-only fixture above: this one tracks, in a small
// JSON state file, which note files a `index` call actually "upserted" (so
// its `grep` responses -- what bin/mnemosyne-reconcile actually greps for,
// one call per tracked note file -- can truthfully answer "is this specific
// file really in the vector layer or not"), and can be told to fail the
// NEXT `index` call on demand without needing to restart the server (engine.mjs
// resolves SWARM_MEMORY_BIN once at process start, so the broken-binary
// pattern other suites use, e.g. test/http-api.mjs's
// SWARM_MEMORY_BIN=/definitely/missing/swarm-memory, can only ever simulate
// total, permanent CLI unavailability -- which real reconcile reports as
// drift_count:null + reconcile_error, per test/health-drift.mjs, not the
// drift_count>0 this story's AC4 specifically requires).
async function testConsistencyAndDrift() {
  const PORT2 = 35000 + Math.floor(Math.random() * 1000);
  const BASE2 = `http://127.0.0.1:${PORT2}`;
  const tempRoot = await mkdtemp(path.join(tmpdir(), "mnemosyne-e2e-drift-"));
  const notesDir = path.join(tempRoot, "notes");
  const fakeSwarm = path.join(tempRoot, "fake-swarm-memory-drift.mjs");
  const stateFile = path.join(tempRoot, "drift-state.json");

  await mkdir(notesDir, { recursive: true });
  await writeFile(stateFile, JSON.stringify({ indexMode: "success", indexed: [] }), "utf8");
  await writeFakeSwarmMemoryDrift(fakeSwarm);

  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PORT2),
      SWARM_MEMORY_BIN: fakeSwarm,
      MNEMOSYNE_NOTES_DIR: notesDir,
      FAKE_DRIFT_STATE: stateFile,
      MNEMOSYNE_DRIFT_CACHE_MAX_AGE_MS: "50",
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
    const up = await waitForHealthAt(BASE2, 15_000);
    ok(up, "consistency/drift server (src/server.mjs) started and /health is reachable");
    if (!up) {
      throw new Error(`consistency/drift server never became reachable:\n${serverOutput}`);
    }

    // --- AC1 + AC2: write-then-recall coherence ------------------------------
    const token = `MNEMO-E2E-CONSISTENCY-${Date.now()}`;
    const remember = await jTo(BASE2, "POST", "/remember", {
      text: `Consistency marker note ${token}.`,
      scope: "personal",
      tag: "e2e-consistency",
    });
    ok(
      remember.status === 200 && remember.body.remembered === true,
      `POST /remember succeeds -> ${JSON.stringify(remember.body).slice(0, 200)}`,
    );

    const rememberedFile = remember.body.file;
    ok(
      await pathExists(rememberedFile),
      `AC1: remembered note file exists on disk at ${rememberedFile}`,
    );

    const recall = await jTo(BASE2, "POST", "/recall", { query: token, scope: "personal" });
    const topHit = recall.body?.scopes?.[0]?.hits?.[0];
    ok(
      !!topHit?.provenance?.full_path &&
        path.basename(topHit.provenance.full_path) === path.basename(rememberedFile),
      `AC2: recall top hit provenance.full_path basename matches remembered file -> ${topHit?.provenance?.full_path} vs ${rememberedFile}`,
    );

    // --- AC3: drift_count === 0 after a clean write-through -------------------
    const noDrift = await waitForDriftResolvedAt(BASE2);
    ok(noDrift.status === 200, `AC3: GET /health after remember -> 200 (got ${noDrift.status})`);
    ok(
      noDrift.body.drift_count === 0,
      `AC3: GET /health after successful remember -> drift_count:0 (got ${noDrift.body.drift_count})`,
    );

    // --- AC4: simulate a Qdrant/vector upsert failure --------------------------
    // Flip the fake CLI's next `index` call to fail (non-zero exit, same
    // shape as write-through.mjs's "hard-fail" scenario) without touching
    // the running server's SWARM_MEMORY_BIN itself.
    await writeFile(
      stateFile,
      JSON.stringify({
        indexMode: "upsert-fail",
        indexed: (await readState(stateFile)).indexed,
      }),
      "utf8",
    );

    const driftToken = `MNEMO-E2E-DRIFT-${Date.now()}`;
    const failedRemember = await jTo(BASE2, "POST", "/remember", {
      text: `Drift marker note ${driftToken}.`,
      scope: "personal",
      tag: "e2e-drift",
    });
    ok(
      failedRemember.status === 500,
      `AC4 setup: simulated Qdrant upsert failure -> POST /remember rejects with 500 (got ${failedRemember.status})`,
    );

    // mc-01's write-through recovery contract keeps the note file on disk
    // even though the upsert failed -- confirm the orphan genuinely exists
    // (file layer has it, vector layer never did) before trusting reconcile
    // to catch it, rather than assuming the mock alone proves drift.
    const orphanMatch = /file kept at (\S+) for recovery/.exec(failedRemember.body?.error || "");
    const orphanFile = orphanMatch?.[1];
    ok(!!orphanFile, `AC4 setup: error response names the orphaned recovery file -> ${failedRemember.body?.error}`);
    ok(
      !!orphanFile && (await pathExists(orphanFile)),
      `AC4 setup: orphaned note file (write succeeded, upsert failed) is kept on disk at ${orphanFile}`,
    );

    const drift = await waitForDriftResolvedAt(BASE2);
    ok(drift.status === 200, `AC4: GET /health after simulated upsert failure -> 200 (got ${drift.status})`);
    ok(
      typeof drift.body.drift_count === "number" && drift.body.drift_count > 0,
      `AC4: GET /health after simulated Qdrant upsert failure -> drift_count > 0 (got ${drift.body.drift_count})`,
    );
  } finally {
    await stopChild(child);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function readState(stateFile) {
  const { readFile } = await import("node:fs/promises");
  return JSON.parse(await readFile(stateFile, "utf8"));
}

async function pathExists(p) {
  if (!p) return false;
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// writeFakeSwarmMemoryDrift — test double for the `swarm-memory` CLI used
// only by testConsistencyAndDrift(). Behavior, driven by FAKE_DRIFT_STATE
// (a JSON {indexMode, indexed[]} file the test rewrites mid-run):
//   config            -> scope->collection map (remember()'s scopeMap()).
//   check             -> "result: PASS" (health()'s liveness probe).
//   index <coll> --no-prune <file>
//                     -> indexMode:"success" (default): records the file's
//                        basename as genuinely upserted, reports success.
//                        indexMode:"upsert-fail": exits non-zero, records
//                        nothing -- the real Qdrant-upsert-failed case.
//   recall <query> ...  -> scans MNEMOSYNE_NOTES_DIR for a note file whose
//                        content includes <query> (the marker text
//                        remember() just wrote) and returns it as a real,
//                        on-disk-verifiable hit (full_path/source point at
//                        the actual file, so status-filter.mjs's read of its
//                        flight-status header succeeds instead of dropping
//                        the hit).
//   grep <noteId> ...   -> bin/mnemosyne-reconcile's own per-file lookup:
//                        <noteId> is the ISO-timestamp prefix of a note
//                        filename (see mnemosyne-reconcile's own regex).
//                        Answers truthfully from the `indexed` list above --
//                        found only if that exact file was ever a
//                        successfully-recorded `index` call, never just
//                        because the file exists on disk. This is what lets
//                        AC4's orphaned file (written, never upserted) come
//                        back "not found" and register as real drift.
async function writeFakeSwarmMemoryDrift(filePath) {
  await writeFile(
    filePath,
    `#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [, , cmd, ...args] = process.argv;
const stateFile = process.env.FAKE_DRIFT_STATE;
const notesDir = process.env.MNEMOSYNE_NOTES_DIR;
const NOTE_ID_RE = /^\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z$/;

function readState() {
  return JSON.parse(readFileSync(stateFile, "utf8"));
}

function writeState(next) {
  writeFileSync(stateFile, JSON.stringify(next), "utf8");
}

function emptyResult() {
  return { total_hits: 0, scopes: [{ scope: "personal", collection: "e2e_consistency", hits: [] }] };
}

if (cmd === "config") {
  process.stdout.write(
    JSON.stringify({
      scopes: { personal: "e2e_consistency", top: "e2e_consistency" },
      ladder: {},
      default_scope: "personal",
      fallback_collection: "e2e_consistency",
    })
  );
  process.exit(0);
}

if (cmd === "check") {
  process.stdout.write("result: PASS\\n");
  process.exit(0);
}

if (cmd === "index") {
  const state = readState();
  const file = args[args.length - 1];
  if (state.indexMode === "upsert-fail") {
    process.stderr.write("fake swarm-memory: qdrant upsert connection refused (simulated)\\n");
    process.exit(1);
  }
  const basename = path.basename(file);
  const indexed = state.indexed.includes(basename) ? state.indexed : [...state.indexed, basename];
  writeState({ ...state, indexed });
  process.stdout.write("indexed 1 file(s), upserted 3 chunks into e2e_consistency\\n");
  process.exit(0);
}

if (cmd === "recall") {
  const query = args[0] || "";
  if (!notesDir || !existsSync(notesDir)) {
    process.stdout.write(JSON.stringify(emptyResult()));
    process.exit(0);
  }
  const files = readdirSync(notesDir).filter((f) => f.endsWith(".md"));
  let hitFile = null;
  for (const f of files) {
    const contents = readFileSync(path.join(notesDir, f), "utf8");
    if (contents.includes(query)) {
      hitFile = f;
      break;
    }
  }
  if (!hitFile) {
    process.stdout.write(JSON.stringify(emptyResult()));
    process.exit(0);
  }
  const fullPath = path.join(notesDir, hitFile);
  process.stdout.write(
    JSON.stringify({
      total_hits: 1,
      scopes: [
        {
          scope: "personal",
          collection: "e2e_consistency",
          hits: [
            {
              score: 0.93,
              text: "e2e consistency marker fixture hit",
              source: hitFile,
              full_path: fullPath,
              chunk_index: 0,
              provenance: { source: hitFile, full_path: fullPath, chunk_index: 0 },
            },
          ],
        },
      ],
    })
  );
  process.exit(0);
}

if (cmd === "grep") {
  const query = args[0] || "";
  if (!NOTE_ID_RE.test(query)) {
    // Keyword-layer half of a normal recall() call for marker text -- not
    // mnemosyne-reconcile's per-file drift lookup. No keyword hits needed.
    process.stdout.write(JSON.stringify([]));
    process.exit(0);
  }
  const state = readState();
  const files = notesDir && existsSync(notesDir) ? readdirSync(notesDir) : [];
  const matchFile = files.find((f) => f.startsWith(query));
  if (!matchFile || !state.indexed.includes(matchFile)) {
    // Genuinely not found in the vector layer -- either no such file, or a
    // file that was written but never successfully upserted (AC4's orphan).
    process.stdout.write(JSON.stringify([]));
    process.exit(0);
  }
  process.stdout.write(
    JSON.stringify([
      {
        scope: "personal",
        collection: "e2e_consistency",
        hits: [
          {
            source: matchFile,
            full_path: path.join(notesDir, matchFile),
            chunk_index: 0,
            provenance: { source: matchFile, full_path: path.join(notesDir, matchFile) },
          },
        ],
      },
    ])
  );
  process.exit(0);
}

if (cmd === "graph") {
  // No code-graph fixture data for this scenario -- always empty, which
  // src/layers/code-graph.mjs already treats as a soft no-op.
  process.stdout.write(JSON.stringify([]));
  process.exit(0);
}

process.stderr.write(\`fake swarm-memory: unknown command \${cmd}\\n\`);
process.exit(2);
`,
    "utf8",
  );
  await chmod(filePath, 0o755);
}

async function waitForHealthAt(base, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.status === 200 || res.status === 503) return true;
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function jTo(base, method, pathname, body) {
  const res = await fetch(base + pathname, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// waitForDriftResolvedAt — same cache-vs-live-refresh dance as
// test/health-drift.mjs's waitForDriftResolved(): MNEMOSYNE_DRIFT_CACHE_MAX_AGE_MS
// is set to 50ms above, so wait past that TTL (guaranteeing the *next*
// health() call sees a stale cache and kicks off a fresh reconcile against
// current state) and then poll until reconciling !== true, rather than
// trusting a single synchronous call.
async function waitForDriftResolvedAt(base, timeoutMs = 15_000) {
  await new Promise((resolve) => setTimeout(resolve, 80));
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await jTo(base, "GET", "/health");
    if (last.body.reconciling !== true) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return last;
}

async function writeFakeSwarmMemory(filePath) {
  await writeFile(
    filePath,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const [, , cmd, queryOrPath] = process.argv;
const mode = process.env.FAKE_SWARM_MEMORY_MODE || "hits";
const stateFile = process.env.FAKE_SWARM_MEMORY_STATE;

function readState() {
  return JSON.parse(readFileSync(stateFile, "utf8"));
}

function writeState(next) {
  writeFileSync(stateFile, JSON.stringify(next), "utf8");
}

if (cmd === "index") {
  const state = readState();
  writeState({ ...state, indexed_at: new Date().toISOString() });
  process.stdout.write("indexed 1 file(s), upserted 1 chunks into e2e_project\\n");
  process.exit(0);
}

if (cmd !== "recall") {
  process.stderr.write(\`fake swarm-memory: unknown command \${cmd}\\n\`);
  process.exit(2);
}

if (mode === "error") {
  process.stderr.write("fake swarm-memory: qdrant unavailable for e2e\\n");
  process.exit(1);
}

const state = readState();
const query = queryOrPath;
process.stdout.write(JSON.stringify({
  query,
  total_hits: 1,
  scopes: [
    {
      scope: "project",
      collection: "e2e_project",
      fallback_used: false,
      below_floor: 0,
      error: "",
      hits: [
        {
          score: 0.94,
          location: "/memory/project/authentication-flow.md",
          full_path: "/memory/project/authentication-flow.md",
          source: "authentication-flow.md",
          chunk_index: 0,
          chunk_span: [0, 128],
          text: "authentication flow uses session cookies and redirect validation",
          provenance: {
            source: "authentication-flow.md",
            full_path: "/memory/project/authentication-flow.md",
            chunk_index: 0,
            collection: "e2e_project",
            indexed_at: state.indexed_at,
            content_sha256: "e2e-auth-flow-sha",
            embed_model: "fake-e2e-embedder",
            query,
            embed_model_query: "fake-e2e-embedder",
            retrieved_at: state.retrieved_at,
            chunk_span: [0, 128],
            context_radius: 2
          }
        }
      ]
    }
  ]
}));
`,
    "utf8",
  );
  await chmod(filePath, 0o755);
}

async function startClientHttpApi({ rootDirectory, fakeSwarm, stateFile }) {
  const { spawn } = await import("node:child_process");
  const tsx = path.resolve("node_modules", ".bin", "tsx");
  const server = path.resolve("lib", "mnemosyne", "server.ts");
  const child = spawn(tsx, [server], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MNEMOSYNE_PORT: String(PORT),
      MNEMOSYNE_ROOT_DIR: rootDirectory,
      SWARM_MEMORY_BIN: fakeSwarm,
      FAKE_SWARM_MEMORY_MODE: "hits",
      FAKE_SWARM_MEMORY_STATE: stateFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });

  const up = await waitForHttpApi(15_000);
  ok(up, "client HTTP API started");
  if (!up) {
    child.kill();
    throw new Error(`client HTTP API never became reachable:\n${output}`);
  }

  return child;
}

async function waitForHttpApi(timeoutMs) {
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

async function j(method, pathname, body) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

function normalizeRecall(result) {
  return {
    ok: result.ok,
    query: result.query,
    scope: result.scope,
    intent: result.intent,
    hits: result.hits?.map((hit) => ({
      content: hit.content,
      score: hit.score,
      provenance: hit.provenance,
    })),
    layers_queried: result.layers_queried,
    layers_skipped: result.layers_skipped,
    escalated: result.escalated,
    degraded: result.degraded,
  };
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

function restoreEnv(key, value) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
