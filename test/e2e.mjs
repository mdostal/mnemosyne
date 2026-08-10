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
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

  console.log(fails ? `\n${fails} check(s) failed` : "\nall e2e checks passed");
  process.exit(fails ? 1 : 0);
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
