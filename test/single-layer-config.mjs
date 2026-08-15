// single-layer-config.mjs — cr-04-single-layer-config-proof
//
// Proves Mnemosyne's core pluggability claim end-to-end: a consumer can run
// with a SINGLE configured layer (not the full default cascade) and get
// correct, isolated behavior — no other layer is ever constructed, queried,
// or written through, even when it would trivially "help" (e.g. a file on
// disk that would match the query, or a vector CLI that's fully functional
// but simply not in the configured stack).
//
// Same rigor as test/http-api.mjs: real `tsx lib/mnemosyne/server.ts`
// subprocesses, real HTTP calls, real fake-binary subprocesses standing in
// for `swarm-memory`/`graphify` — never a mock of LayerRegistry/client.ts.
// "No cross-layer leakage" is proven by process/output inspection (a
// sentinel log the fake `swarm-memory` binary writes to on every invocation,
// and canary content placed where an un-configured layer WOULD find it if
// it were incorrectly still active), not just "the response looked right".
//
// Usage: node test/single-layer-config.mjs

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const SERVER = path.join(ROOT, "lib", "mnemosyne", "server.ts");

let fails = 0;
const ok = (condition, message) => {
  console.log(`${condition ? "  PASS" : "  FAIL"}  ${message}`);
  if (!condition) fails++;
};

async function j(base, method, pathname, body) {
  const res = await fetch(base + pathname, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

async function waitForUp(base, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  let exited = false;
  const onExit = () => {
    exited = true;
  };
  child.once("exit", onExit);
  try {
    while (Date.now() < deadline) {
      if (exited) return false;
      try {
        const res = await fetch(base + "/health");
        if (res.status === 200 || res.status === 503) return true;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  } finally {
    child.off("exit", onExit);
  }
}

function spawnServer(port, env) {
  const child = spawn(TSX, [SERVER], {
    cwd: ROOT,
    env: { ...process.env, MNEMOSYNE_PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (c) => (output += c));
  child.stderr.on("data", (c) => (output += c));
  return { child, getOutput: () => output };
}

// A fake `swarm-memory` CLI binary (the ONLY way VectorLayerAdapter ever
// touches the outside world — see lib/mnemosyne/layers/VectorLayerAdapter.ts,
// it shells out via execFile, never imports a Qdrant client). Every
// invocation is appended to SENTINEL_LOG, so "was the vector CLI ever
// invoked at all" is a real process-level fact, not an inference from
// output shape. A query containing EMPTY_MARKER gets zero hits (a real,
// legitimate "vector layer has zero hits" case); any other query gets one
// canned hit.
async function writeSentinelSwarmMemory(dir) {
  const implPath = path.join(dir, "sentinel-swarm-memory.mjs");
  const shimPath = path.join(dir, "sentinel-swarm-memory.sh");

  await writeFile(
    implPath,
    `import { appendFileSync } from 'node:fs';
const [, , cmd, ...args] = process.argv;
const sentinel = process.env.SENTINEL_LOG;
if (sentinel) appendFileSync(sentinel, cmd + ' ' + args.join(' ') + '\\n');
const emptyMarker = process.env.EMPTY_MARKER || '__EMPTY__';

if (cmd === 'config') {
  process.stdout.write(JSON.stringify({ scopes: { project: 'test_collection', enterprise: 'test_collection', meta: 'test_collection' } }));
  process.exit(0);
}
if (cmd === 'index') {
  process.stdout.write('indexed 1 file(s), upserted 3 chunks into test_collection\\n');
  process.exit(0);
}
if (cmd === 'recall') {
  const query = args[0] || '';
  const isEmpty = query.includes(emptyMarker);
  process.stdout.write(JSON.stringify({
    query,
    total_hits: isEmpty ? 0 : 1,
    scopes: [{ scope: 'project', collection: 'test_collection', hits: isEmpty ? [] : [{ text: 'sentinel vector hit', score: 0.9, source: 'sentinel-vector-source' }] }],
  }));
  process.exit(0);
}
process.stderr.write('sentinel-swarm-memory: unknown command ' + cmd + '\\n');
process.exit(2);
`,
    "utf8",
  );

  // Shell shim so the fake binary never depends on `env node` PATH
  // resolution order (same reasoning as test/fixtures/fake-swarm-memory).
  await writeFile(
    shimPath,
    `#!/bin/sh\nexec "\${MNEMO_TEST_NODE:-node}" "$(dirname "$0")/sentinel-swarm-memory.mjs" "$@"\n`,
    "utf8",
  );
  await chmod(shimPath, 0o755);
  return shimPath;
}

async function sentinelLogLines(logPath) {
  if (!existsSync(logPath)) return [];
  const raw = await readFile(logPath, "utf8");
  return raw.split("\n").filter((line) => line.trim().length > 0);
}

// --- Scenario 1: pure vector-only -------------------------------------------
async function testVectorOnly() {
  console.log("\n-- pure vector-only (MNEMOSYNE_LAYERS={\"layers\":[{\"name\":\"vector\"}]}) --");

  const tmp = await mkdtemp(path.join(tmpdir(), "mnemosyne-cr04-vector-"));
  const swarmBin = await writeSentinelSwarmMemory(tmp);
  const sentinelLog = path.join(tmp, "sentinel.log");
  const notesDir = path.join(tmp, "notes");
  await mkdir(notesDir, { recursive: true });

  // A root directory that does not exist AND, if it did, contains content
  // that would match our canary query — proves the file layer is not just
  // "returning nothing" but genuinely never constructed/queried: if it were
  // still in the cascade, a nonexistent root would surface as a distinct
  // failure/degradation, and if it somehow read real content it would find
  // the canary line below.
  const missingRoot = path.join(tmp, "does-not-exist");

  const port = 31420;
  const base = `http://127.0.0.1:${port}`;
  const { child, getOutput } = spawnServer(port, {
    MNEMOSYNE_LAYERS: JSON.stringify({ layers: [{ name: "vector" }] }),
    MNEMOSYNE_ROOT_DIR: missingRoot,
    SWARM_MEMORY_BIN: swarmBin,
    MNEMO_TEST_NODE: process.execPath,
    SENTINEL_LOG: sentinelLog,
    EMPTY_MARKER: "EMPTY_MARKER_CR04",
    MNEMOSYNE_NOTES_DIR: notesDir,
  });

  try {
    const up = await waitForUp(base, 15000, child);
    ok(up, "vector-only server started and is reachable");
    if (!up) {
      console.error(getOutput());
      throw new Error("vector-only server never became reachable");
    }

    // GET /layers reports EXACTLY the one configured layer.
    const layers = await j(base, "GET", "/layers");
    ok(layers.status === 200, `GET /layers -> 200 (got ${layers.status})`);
    ok(
      Array.isArray(layers.body.layers) &&
        layers.body.layers.length === 1 &&
        layers.body.layers[0].layer === "vector" &&
        layers.body.layers[0].writable === true,
      `GET /layers -> exactly [{layer:vector,writable:true}] (got ${JSON.stringify(layers.body.layers)})`,
    );

    // A query the vector layer has ZERO hits for (real fixture behavior,
    // not simulated) must return a clean empty result, not an escalation —
    // there is nowhere to escalate TO since only vector is configured.
    const canaryQuery = "EMPTY_MARKER_CR04 canary-file-layer-marker";
    const emptyRecall = await j(base, "POST", "/recall", { query: canaryQuery, scope: "project" });
    ok(emptyRecall.status === 200, `POST /recall (vector zero-hit query) -> 200 (got ${emptyRecall.status})`);
    ok(emptyRecall.body.ok === true, "POST /recall (vector zero-hit query) -> ok:true (clean, not a failure)");
    ok(
      Array.isArray(emptyRecall.body.hits) && emptyRecall.body.hits.length === 0,
      "POST /recall (vector zero-hit query) -> hits:[] (no silent escalation)",
    );
    ok(emptyRecall.body.escalated === false, "POST /recall (vector zero-hit query) -> escalated:false");
    ok(emptyRecall.body.degraded === false, "POST /recall (vector zero-hit query) -> degraded:false");
    ok(
      Array.isArray(emptyRecall.body.layers_queried) &&
        emptyRecall.body.layers_queried.length === 1 &&
        emptyRecall.body.layers_queried[0] === "vector",
      `POST /recall (vector zero-hit query) -> layers_queried:['vector'] only (got ${JSON.stringify(emptyRecall.body.layers_queried)})`,
    );
    ok(
      Array.isArray(emptyRecall.body.layers_skipped) && emptyRecall.body.layers_skipped.length === 0,
      "POST /recall (vector zero-hit query) -> layers_skipped:[] (no other layer even attempted)",
    );

    // A normal query gets a real hit, sourced only from the fake vector CLI.
    const hitRecall = await j(base, "POST", "/recall", { query: "widget", scope: "project" });
    ok(hitRecall.status === 200, `POST /recall (vector hit query) -> 200 (got ${hitRecall.status})`);
    ok(
      Array.isArray(hitRecall.body.hits) &&
        hitRecall.body.hits.length === 1 &&
        hitRecall.body.hits[0].provenance?.layer === "vector",
      `POST /recall (vector hit query) -> 1 hit, provenance.layer:vector (got ${JSON.stringify(hitRecall.body.hits)})`,
    );

    // remember() with no explicit layer defaults to vector — confirm the
    // write actually goes through the real fake-CLI subprocess path.
    const remember = await j(base, "POST", "/remember", {
      content: { text: "remembered via vector-only config" },
      scope: "project",
    });
    ok(remember.status === 200, `POST /remember -> 200 (got ${remember.status})`);
    ok(remember.body.ok === true, "POST /remember -> ok:true");
    ok(remember.body.layer === "vector", "POST /remember -> layer:vector");

    const noteFiles = await readdir(notesDir);
    ok(noteFiles.length === 1, `POST /remember -> exactly one note file written to notesDirectory (got ${noteFiles.length})`);

    // remember() explicitly targeting a layer that ISN'T configured must
    // fail cleanly, never silently succeed via vector or anywhere else.
    const rememberFile = await j(base, "POST", "/remember", {
      content: { text: "should not be writable" },
      scope: "project",
      layer: "file",
    });
    ok(rememberFile.status === 200, `POST /remember (layer:file, unconfigured) -> 200 (got ${rememberFile.status})`);
    ok(
      rememberFile.body.ok === false && rememberFile.body.error?.code === "layer_not_writable",
      `POST /remember (layer:file, unconfigured) -> ok:false, error.code:layer_not_writable (got ${JSON.stringify(rememberFile.body)})`,
    );

    // Real process-level proof: the fake swarm-memory CLI ran exactly for
    // the 2 recall()s + config+index of the 1 successful remember() = 4
    // invocations. No more, no less — nothing extra fired.
    const logLines = await sentinelLogLines(sentinelLog);
    ok(
      logLines.length === 4,
      `fake swarm-memory CLI invoked exactly 4 times (2 recalls + config + index) (got ${logLines.length}: ${JSON.stringify(logLines)})`,
    );
  } finally {
    child.kill();
    await rm(tmp, { recursive: true, force: true });
  }
}

// --- Scenario 2: pure file-only ---------------------------------------------
async function testFileOnly() {
  console.log("\n-- pure file-only (MNEMOSYNE_LAYERS={\"layers\":[{\"name\":\"file\"}]}) --");

  const tmp = await mkdtemp(path.join(tmpdir(), "mnemosyne-cr04-file-"));
  const root = path.join(tmp, "root");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "notes.md"), "alpha\ntarget line\nomega target\n", "utf8");

  const swarmBin = await writeSentinelSwarmMemory(tmp);
  const sentinelLog = path.join(tmp, "sentinel.log");

  const port = 31421;
  const base = `http://127.0.0.1:${port}`;
  const { child, getOutput } = spawnServer(port, {
    MNEMOSYNE_LAYERS: JSON.stringify({ layers: [{ name: "file" }] }),
    MNEMOSYNE_ROOT_DIR: root,
    // If the file-only stack EVER shelled out to swarm-memory, this sentinel
    // binary would record it. It must never be invoked in this scenario.
    SWARM_MEMORY_BIN: swarmBin,
    MNEMO_TEST_NODE: process.execPath,
    SENTINEL_LOG: sentinelLog,
  });

  try {
    const up = await waitForUp(base, 15000, child);
    ok(up, "file-only server started and is reachable");
    if (!up) {
      console.error(getOutput());
      throw new Error("file-only server never became reachable");
    }

    const layers = await j(base, "GET", "/layers");
    ok(layers.status === 200, `GET /layers -> 200 (got ${layers.status})`);
    ok(
      Array.isArray(layers.body.layers) &&
        layers.body.layers.length === 1 &&
        layers.body.layers[0].layer === "file" &&
        layers.body.layers[0].writable === false,
      `GET /layers -> exactly [{layer:file,writable:false}] (got ${JSON.stringify(layers.body.layers)})`,
    );

    const hitRecall = await j(base, "POST", "/recall", { query: "target", scope: "project" });
    ok(hitRecall.status === 200, `POST /recall (file hit query) -> 200 (got ${hitRecall.status})`);
    ok(
      Array.isArray(hitRecall.body.hits) &&
        hitRecall.body.hits.length === 2 &&
        hitRecall.body.hits.every((h) => h.provenance?.layer === "file"),
      `POST /recall (file hit query) -> 2 hits, all provenance.layer:file (got ${JSON.stringify(hitRecall.body.hits)})`,
    );

    const emptyRecall = await j(base, "POST", "/recall", { query: "nothing-matches-this-string", scope: "project" });
    ok(emptyRecall.status === 200, `POST /recall (file zero-hit query) -> 200 (got ${emptyRecall.status})`);
    ok(
      emptyRecall.body.ok === true && Array.isArray(emptyRecall.body.hits) && emptyRecall.body.hits.length === 0,
      "POST /recall (file zero-hit query) -> clean ok:true, hits:[]",
    );

    // remember() defaults to vector, which isn't configured here — must
    // fail cleanly, never silently redirect to the file layer either.
    const remember = await j(base, "POST", "/remember", {
      content: { text: "should not be writable" },
      scope: "project",
    });
    ok(remember.status === 200, `POST /remember (default layer, unconfigured) -> 200 (got ${remember.status})`);
    ok(
      remember.body.ok === false && remember.body.error?.code === "layer_not_writable",
      `POST /remember (default layer, unconfigured) -> ok:false, layer_not_writable (got ${JSON.stringify(remember.body)})`,
    );

    // Explicitly targeting the configured 'file' layer also fails cleanly —
    // FileLayerAdapter doesn't implement remember() at all.
    const rememberFile = await j(base, "POST", "/remember", {
      content: { text: "should not be writable either" },
      scope: "project",
      layer: "file",
    });
    ok(
      rememberFile.body.ok === false && rememberFile.body.error?.code === "layer_not_writable",
      `POST /remember (layer:file, recall-only adapter) -> ok:false, layer_not_writable (got ${JSON.stringify(rememberFile.body)})`,
    );

    // The definitive proof for this scenario's acceptance criterion: the
    // fake swarm-memory CLI (the ONLY way a vector/Qdrant call could ever
    // happen) was never invoked, not even once, across every call above.
    const logLines = await sentinelLogLines(sentinelLog);
    ok(
      logLines.length === 0,
      `fake swarm-memory CLI never invoked during file-only test (no vector/Qdrant call attempted) (got ${logLines.length}: ${JSON.stringify(logLines)})`,
    );
  } finally {
    child.kill();
    await rm(tmp, { recursive: true, force: true });
  }
}

// --- Scenario 3: graphify-only (this epic's new layer, standalone) ---------
async function testGraphifyOnly() {
  console.log("\n-- graphify-only (MNEMOSYNE_LAYERS={\"layers\":[{\"name\":\"graphify\"}]}) --");

  const tmp = await mkdtemp(path.join(tmpdir(), "mnemosyne-cr04-graphify-"));
  const graphPath = path.join(tmp, "graph.json");
  await writeFile(
    graphPath,
    JSON.stringify({
      directed: true,
      multigraph: false,
      graph: {},
      built_at_commit: "cr04fixture",
      nodes: [
        { id: "n1", label: "WidgetFactory", file_type: "class", source_file: "src/widget.py", source_location: "L10" },
        { id: "n2", label: "buildWidget", file_type: "function", source_file: "src/widget.py", source_location: "L20" },
      ],
      links: [{ source: "n1", target: "n2", relation: "calls", source_file: "src/widget.py", source_location: "L15" }],
      hyperedges: [],
    }),
    "utf8",
  );

  const port = 31422;
  const base = `http://127.0.0.1:${port}`;
  const { child, getOutput } = spawnServer(port, {
    MNEMOSYNE_LAYERS: JSON.stringify({
      layers: [
        {
          name: "graphify",
          options: {
            graphPath,
            autoUpdate: false,
            // A real, always-present executable path so the adapter's
            // "is the binary actually resolvable" construction-time check
            // (ensureBinaryOnPath) passes without needing a real `graphify`
            // install — autoUpdate:false means it's never actually
            // executed, only checked for existence.
            command: process.execPath,
          },
        },
      ],
    }),
    // No SWARM_MEMORY_BIN override needed: graphify-only must not construct
    // a vector adapter at all, so a missing/default swarm-memory command is
    // irrelevant here — proves graphify doesn't secretly need it.
  });

  try {
    const up = await waitForUp(base, 15000, child);
    ok(up, "graphify-only server started and is reachable");
    if (!up) {
      console.error(getOutput());
      throw new Error("graphify-only server never became reachable");
    }

    const layers = await j(base, "GET", "/layers");
    ok(layers.status === 200, `GET /layers -> 200 (got ${layers.status})`);
    ok(
      Array.isArray(layers.body.layers) &&
        layers.body.layers.length === 1 &&
        layers.body.layers[0].layer === "graphify" &&
        layers.body.layers[0].writable === false,
      `GET /layers -> exactly [{layer:graphify,writable:false}] (got ${JSON.stringify(layers.body.layers)})`,
    );

    const hitRecall = await j(base, "POST", "/recall", { query: "WidgetFactory", scope: "project" });
    ok(hitRecall.status === 200, `POST /recall (graphify hit query) -> 200 (got ${hitRecall.status})`);
    ok(
      Array.isArray(hitRecall.body.hits) &&
        hitRecall.body.hits.length > 0 &&
        hitRecall.body.hits.every((h) => h.provenance?.layer === "graphify"),
      `POST /recall (graphify hit query) -> hits present, all provenance.layer:graphify (got ${JSON.stringify(hitRecall.body.hits)})`,
    );

    const emptyRecall = await j(base, "POST", "/recall", { query: "totally-unknown-node-xyz", scope: "project" });
    ok(emptyRecall.status === 200, `POST /recall (graphify zero-hit query) -> 200 (got ${emptyRecall.status})`);
    ok(
      emptyRecall.body.ok === true && Array.isArray(emptyRecall.body.hits) && emptyRecall.body.hits.length === 0,
      "POST /recall (graphify zero-hit query) -> clean ok:true, hits:[] (standalone, no vector/file/code-graph to fall back to)",
    );

    // remember() defaults to vector, which isn't configured — must fail
    // cleanly (graphify itself is read-only, and standalone doesn't imply
    // any other layer secretly becomes writable).
    const remember = await j(base, "POST", "/remember", {
      content: { text: "should not be writable" },
      scope: "project",
    });
    ok(remember.status === 200, `POST /remember (default layer, unconfigured) -> 200 (got ${remember.status})`);
    ok(
      remember.body.ok === false && remember.body.error?.code === "layer_not_writable",
      `POST /remember (default layer, unconfigured) -> ok:false, layer_not_writable (got ${JSON.stringify(remember.body)})`,
    );

    // Explicitly targeting the configured 'graphify' layer by name: it's
    // the one layer actually in the stack, so this must be recognized as a
    // real, known, currently-recall-only layer (layer_not_writable) —
    // NOT rejected upstream as an unrecognized layer NAME (invalid_layer),
    // which would be a stale-validation bug independent of pluggability.
    const rememberGraphify = await j(base, "POST", "/remember", {
      content: { text: "should not be writable either" },
      scope: "project",
      layer: "graphify",
    });
    ok(
      rememberGraphify.body.ok === false && rememberGraphify.body.error?.code === "layer_not_writable",
      `POST /remember (layer:graphify, recall-only adapter) -> ok:false, layer_not_writable, not invalid_layer (got ${JSON.stringify(rememberGraphify.body)})`,
    );
  } finally {
    child.kill();
    await rm(tmp, { recursive: true, force: true });
  }
}

// --- Scenario 4: crossref-linker-only (cr-02's new layer, standalone) ------
//
// cr-02-crossrepo-identifier-linker landed on this branch before this test
// ran (confirmed via `git log` immediately before finalizing this story —
// see the story's note on checking again before final push), so this is a
// full real-subprocess standalone proof, not a skip. Two real fixture repos:
// repoA defines a Sanity "tool" document schema, repoB queries `_type ==
// "tool"` — the actual validated cross-repo case this layer exists for (see
// CrossRepoLinkerAdapter.ts's header). Neither vector, file, graphify, nor
// code-graph is configured, and none is needed for this to work.
async function testCrossrefLinkerOnly() {
  console.log("\n-- crossref-linker-only (MNEMOSYNE_LAYERS={\"layers\":[{\"name\":\"crossref-linker\"}]}) --");

  const tmp = await mkdtemp(path.join(tmpdir(), "mnemosyne-cr04-crossref-"));
  const repoA = path.join(tmp, "repoA");
  const repoB = path.join(tmp, "repoB");
  await mkdir(repoA, { recursive: true });
  await mkdir(repoB, { recursive: true });
  await writeFile(
    path.join(repoA, "schema.ts"),
    "export default {\n  name: 'tool',\n  title: 'Tool',\n  type: 'document',\n  fields: [],\n};\n",
    "utf8",
  );
  await writeFile(
    path.join(repoB, "query.ts"),
    'const q = `*[_type == "tool" && hidden != true]`;\n',
    "utf8",
  );

  const port = 31423;
  const base = `http://127.0.0.1:${port}`;
  const { child, getOutput } = spawnServer(port, {
    MNEMOSYNE_LAYERS: JSON.stringify({
      layers: [{ name: "crossref-linker", options: { repos: [repoA, repoB] } }],
    }),
    // No SWARM_MEMORY_BIN / MNEMOSYNE_ROOT_DIR overrides: crossref-linker-only
    // must not construct a vector or file adapter at all.
  });

  try {
    const up = await waitForUp(base, 15000, child);
    ok(up, "crossref-linker-only server started and is reachable");
    if (!up) {
      console.error(getOutput());
      throw new Error("crossref-linker-only server never became reachable");
    }

    const layers = await j(base, "GET", "/layers");
    ok(layers.status === 200, `GET /layers -> 200 (got ${layers.status})`);
    ok(
      Array.isArray(layers.body.layers) &&
        layers.body.layers.length === 1 &&
        layers.body.layers[0].layer === "crossref-linker" &&
        layers.body.layers[0].writable === false,
      `GET /layers -> exactly [{layer:crossref-linker,writable:false}] (got ${JSON.stringify(layers.body.layers)})`,
    );

    // The real cross-repo case: "tool" is DEFINED in repoA, QUERIED in
    // repoB — this layer's whole reason for existing.
    const hitRecall = await j(base, "POST", "/recall", { query: "tool", scope: "project" });
    ok(hitRecall.status === 200, `POST /recall (crossref-linker hit query) -> 200 (got ${hitRecall.status})`);
    ok(
      Array.isArray(hitRecall.body.hits) &&
        hitRecall.body.hits.length >= 2 &&
        hitRecall.body.hits.every((h) => h.provenance?.layer === "crossref-linker"),
      `POST /recall (crossref-linker hit query) -> hits present, all provenance.layer:crossref-linker (got ${JSON.stringify(hitRecall.body.hits)})`,
    );
    ok(
      hitRecall.body.hits.some((h) => /Cross-repo usage/.test(h.content)),
      `POST /recall (crossref-linker hit query) -> a real cross-repo usage hit was found (got ${JSON.stringify(hitRecall.body.hits.map((h) => h.content))})`,
    );

    const emptyRecall = await j(base, "POST", "/recall", { query: "nonexistent-identifier-xyz", scope: "project" });
    ok(emptyRecall.status === 200, `POST /recall (crossref-linker zero-hit query) -> 200 (got ${emptyRecall.status})`);
    ok(
      emptyRecall.body.ok === true && Array.isArray(emptyRecall.body.hits) && emptyRecall.body.hits.length === 0,
      "POST /recall (crossref-linker zero-hit query) -> clean ok:true, hits:[] (standalone, no vector/file/graphify/code-graph to fall back to)",
    );

    const remember = await j(base, "POST", "/remember", {
      content: { text: "should not be writable" },
      scope: "project",
    });
    ok(remember.status === 200, `POST /remember (default layer, unconfigured) -> 200 (got ${remember.status})`);
    ok(
      remember.body.ok === false && remember.body.error?.code === "layer_not_writable",
      `POST /remember (default layer, unconfigured) -> ok:false, layer_not_writable (got ${JSON.stringify(remember.body)})`,
    );

    const rememberCrossref = await j(base, "POST", "/remember", {
      content: { text: "should not be writable either" },
      scope: "project",
      layer: "crossref-linker",
    });
    ok(
      rememberCrossref.body.ok === false && rememberCrossref.body.error?.code === "layer_not_writable",
      `POST /remember (layer:crossref-linker, recall-only adapter) -> ok:false, layer_not_writable, not invalid_layer (got ${JSON.stringify(rememberCrossref.body)})`,
    );
  } finally {
    child.kill();
    await rm(tmp, { recursive: true, force: true });
  }
}

async function main() {
  await testVectorOnly();
  await testFileOnly();
  await testGraphifyOnly();
  await testCrossrefLinkerOnly();

  console.log(fails ? `\n${fails} check(s) failed` : "\nall single-layer-config checks passed");
  process.exit(fails ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
