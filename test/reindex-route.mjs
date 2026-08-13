// reindex-route.mjs — TDD tests for s-05's Operations panel wiring:
// POST /index (Reindex) and POST /cache/refresh (Refresh config cache).
//
// This is the highest-risk story in the epic (SERVICE.md's hard guardrail:
// no endpoint/UI action/code path may ever delete/wipe/drop a Qdrant
// collection or any data therein). These tests are written to actively try
// to find and rule out any such path, not just assume it's absent — see the
// "hard constraint" block at the bottom.
//
// Two server postures, matching this repo's existing conventions:
//   - The Reindex (POST /index) tests run against a REAL (subprocess) server
//     talking to the REAL live Qdrant Cloud SSOT (same posture as
//     test/smoke.mjs / test/search-route.mjs / test/hooks.mjs) — but scoped
//     to ONE small throwaway file indexed into 'personal_memory' (the same
//     playground collection smoke.mjs and hooks.mjs already write throwaway
//     notes into), never the production corpus wholesale. This is the only
//     way to genuinely prove the CLI round-trips real success/chunk-count
//     output back through the route, which is the acceptance criterion.
//   - The cache-refresh "zero subprocess calls" proof needs to observe an
//     actual negative (no process spawned) — not provable against the real
//     `swarm-memory` binary from the outside, so that one block points
//     SWARM_MEMORY_BIN (an env override engine.mjs already supports, for
//     exactly this purpose) at a tiny throwaway stub script that logs every
//     invocation it receives. This never touches the real config.toml,
//     Qdrant, or graph.sqlite — the stub does nothing else.
//
// Usage: node test/reindex-route.mjs
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, "..", "src", "server.mjs");
const ENGINE_PATH = path.join(__dirname, "..", "src", "engine.mjs");
const SERVER_SRC_PATH = path.join(__dirname, "..", "src", "server.mjs");
const PORT = Number(process.env.MNEMOSYNE_TEST_PORT || 8491);
const BASE = `http://127.0.0.1:${PORT}`;

let fails = 0;
const ok = (c, m) => { console.log(`${c ? "  PASS" : "  FAIL"}  ${m}`); if (!c) fails++; };

async function waitForServer(url, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

// --- source-level: reindexPaths()'s own CLI-argv construction ---------------
// Proves, from the actual code (not prose), that reindexPaths() (the
// targeted POST /index action — renamed from reindex() when the
// mnemosyne-foundation merge introduced a separate bulk reindex(scope, opts)
// for POST /reindex; see SERVICE.md's "Two reindex paths") builds exactly
// `["index", collection, ...paths]` — no --no-prune (that's remember()'s
// flag, for its own pure-additive note write, never reindexPaths()'s general
// path) and no destructive verb of any kind.
{
  const engineSrc = await readFile(ENGINE_PATH, "utf8");
  const fnStart = engineSrc.indexOf("export async function reindexPaths(");
  ok(fnStart !== -1, "engine.mjs exports a reindexPaths() function");
  const fnEnd = engineSrc.indexOf("\nexport ", fnStart + 10);
  const reindexSrc = engineSrc.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);

  ok(/\[\s*["'`]index["'`]\s*,\s*String\(collection\)\s*,\s*\.\.\.pathList\s*\]/.test(reindexSrc),
    "reindexPaths() constructs args as exactly [\"index\", collection, ...paths] (verified against actual source text)");
  ok(!/--no-prune/.test(reindexSrc),
    "reindexPaths() never passes --no-prune (default CLI pruning behavior only)");
  ok(!/["'`](delete|remove|drop|wipe)["'`]/i.test(reindexSrc),
    "reindexPaths() never references a delete/remove/drop/wipe verb");

  // remember()'s own --no-prune usage is the one legitimate place that flag
  // appears anywhere in engine.mjs — confirm it's isolated to remember(),
  // not shared/leaked into reindex()'s code path.
  const rememberStart = engineSrc.indexOf("export async function remember(");
  const rememberEnd = engineSrc.indexOf("\nexport ", rememberStart + 10);
  const rememberSrc = engineSrc.slice(rememberStart, rememberEnd === -1 ? undefined : rememberEnd);
  ok(/--no-prune/.test(rememberSrc), "remember() (the additive note-write path) still uses --no-prune, unchanged");
}

// --- live functional round-trip: POST /index against a real, tiny, scoped ---
// throwaway file in personal_memory (never the production corpus wholesale).
{
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverOutput = "";
  child.stdout.on("data", (d) => { serverOutput += d.toString(); });
  child.stderr.on("data", (d) => { serverOutput += d.toString(); });

  const dir = await mkdtemp(path.join(tmpdir(), "mnemosyne-reindex-route-"));
  const token = `MNEMO-REINDEX-ROUTE-${Date.now()}`;
  const file = path.join(dir, "reindex-route-test-note.md");
  await writeFile(
    file,
    `<!-- s-05 reindex-route.mjs throwaway test artifact -->\n` +
      `Mnemosyne reindex-route test note. Unique token ${token}. ` +
      `Deliberately small — this proves POST /index round-trips a real ` +
      `\`swarm-memory index\` call without reindexing the production corpus.\n`,
    "utf8"
  );

  try {
    const up = await waitForServer(BASE + "/scopes");
    ok(up, "test server (real CLI, live Qdrant) came up");

    // --- missing collection / empty paths -> 400, before touching Qdrant ---
    {
      const res = await fetch(BASE + "/index", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paths: [file] }),
      });
      const body = await res.json();
      ok(res.status === 400, `POST /index with no collection -> 400 (got ${res.status}, ${JSON.stringify(body)})`);
      ok(/collection/i.test(body.error || ""), "error message mentions the missing collection");
    }
    {
      const res = await fetch(BASE + "/index", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ collection: "personal_memory", paths: [] }),
      });
      const body = await res.json();
      ok(res.status === 400, `POST /index with empty paths -> 400 (got ${res.status}, ${JSON.stringify(body)})`);
      ok(/path/i.test(body.error || ""), "error message mentions the missing path");
    }
    {
      const res = await fetch(BASE + "/index", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ collection: "personal_memory" }),
      });
      const body = await res.json();
      ok(res.status === 400, `POST /index with no paths key at all -> 400 (got ${res.status}, ${JSON.stringify(body)})`);
    }

    // --- valid reindex: real CLI call, real (tiny, scoped) result ----------
    {
      const t0 = Date.now();
      const res = await fetch(BASE + "/index", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ collection: "personal_memory", paths: [file] }),
      });
      const body = await res.json();
      const elapsed = Date.now() - t0;
      ok(res.status === 200, `POST /index (valid) -> 200 (got ${res.status}, ${JSON.stringify(body)}) in ${elapsed}ms`);
      ok(body.reindexed === true, "response has reindexed:true");
      ok(body.collection === "personal_memory", `response echoes collection (${body.collection})`);
      ok(Array.isArray(body.paths) && body.paths[0] === file, "response echoes the requested path(s)");
      ok(body.files_indexed === 1, `files_indexed === 1 for a single-file reindex (got ${body.files_indexed})`);
      ok(typeof body.chunks_upserted === "number" && body.chunks_upserted >= 1,
        `chunks_upserted is a real positive number from the CLI's own output (${body.chunks_upserted})`);
      ok(body.embed_failures === 0, `embed_failures === 0 (got ${body.embed_failures})`);
      ok(typeof body.total_points === "number" && body.total_points >= 1,
        `total_points reflects the CLI's own collection count (${body.total_points})`);
      ok(typeof body.engine_output === "string" && /files indexed/.test(body.engine_output),
        "engine_output carries the CLI's own real stdout (not synthesized)");
    }
  } finally {
    child.kill();
    await rm(dir, { recursive: true, force: true });
    if (fails) {
      console.log("\n--- server output (live round-trip block) ---");
      console.log(serverOutput);
    }
  }
}

// --- GET /ui: Operations panel present with unambiguous, distinct labels ----
{
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const up = await waitForServer(BASE + "/scopes");
    ok(up, "test server came up (for GET /ui check)");
    const res = await fetch(BASE + "/ui");
    const body = await res.text();
    ok(res.status === 200, `GET /ui -> 200 (got ${res.status})`);
    ok(/operations/i.test(body), "GET /ui body mentions an Operations panel");
    ok(/reindex-form/i.test(body), "GET /ui body has a reindex form");
    ok(/refresh-cache-btn/i.test(body), "GET /ui body has a refresh-cache button");
    ok(/Refresh config cache/.test(body), "the local-only action is labeled 'Refresh config cache' verbatim");
    // Never label the local cache action "Clear" in the visible UI copy —
    // that word invites confusion with data deletion.
    const h3Matches = [...body.matchAll(/<h3>([^<]*)<\/h3>/g)].map((m) => m[1]);
    ok(!h3Matches.some((h) => /^clear\b/i.test(h.trim())),
      `no Operations sub-heading starts with 'Clear' (headings: ${JSON.stringify(h3Matches)})`);
  } finally {
    child.kill();
  }
}

// --- Refresh config cache: proves the effect AND proves zero subprocess -----
// spawns for that action specifically, via a throwaway stub CLI (the
// SWARM_MEMORY_BIN test seam engine.mjs already exposes) that logs every
// invocation it receives. The stub never touches the real config.toml,
// Qdrant, or graph.sqlite — it's a local script, not a network call.
{
  const dir = await mkdtemp(path.join(tmpdir(), "mnemosyne-cache-refresh-"));
  const callLog = path.join(dir, "calls.log");
  const configJsonPath = path.join(dir, "fake-config.json");
  const stubPath = path.join(dir, "fake-swarm-memory");

  await writeFile(callLog, "", "utf8");
  await writeFile(
    configJsonPath,
    JSON.stringify({
      qdrant_url: "https://example.invalid:6333",
      embedder: { provider: "ollama", model: "nomic-embed-text", url: "http://localhost:11434", dim: 768 },
      scopes: { top: "fixture_top_collection" },
      ladder: {},
      default_scope: "top",
      fallback_collection: "fixture_fallback",
    }),
    "utf8"
  );
  await writeFile(
    stubPath,
    `#!/usr/bin/env bash\n` +
      `# throwaway stub for s-05 reindex-route.mjs — logs invocations, never touches\n` +
      `# real Qdrant / config.toml / graph.sqlite.\n` +
      `echo "$@" >> "$FAKE_CALL_LOG"\n` +
      `if [ "$1" = "config" ]; then cat "$FAKE_CONFIG_JSON"; exit 0; fi\n` +
      `echo "unsupported fake command: $@" >&2\n` +
      `exit 1\n`,
    "utf8"
  );
  await chmod(stubPath, 0o755);

  const cachePort = PORT + 1;
  const cacheBase = `http://127.0.0.1:${cachePort}`;
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: {
      ...process.env,
      PORT: String(cachePort),
      SWARM_MEMORY_BIN: stubPath,
      FAKE_CALL_LOG: callLog,
      FAKE_CONFIG_JSON: configJsonPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverOutput = "";
  child.stdout.on("data", (d) => { serverOutput += d.toString(); });
  child.stderr.on("data", (d) => { serverOutput += d.toString(); });

  const callCount = async () => {
    const text = await readFile(callLog, "utf8").catch(() => "");
    return text.split("\n").filter((l) => l.trim()).length;
  };

  try {
    const up = await waitForServer(cacheBase + "/scopes");
    ok(up, "stub-backed test server came up");

    // First GET /config: populates the cache — the stub IS called once.
    const before = await (await fetch(cacheBase + "/config")).json();
    ok(before.fallback_collection === "fixture_fallback", "GET /config (1st) reflects the fixture's initial value");
    const countAfterFirstConfig = await callCount();
    ok(countAfterFirstConfig >= 1, `stub CLI was invoked to populate the cache (calls so far: ${countAfterFirstConfig})`);

    // Mutate the "config.toml" (stand-in) out of band, WITHOUT refreshing yet.
    const mutated = JSON.parse(await readFile(configJsonPath, "utf8"));
    mutated.fallback_collection = "fixture_fallback_CHANGED";
    await writeFile(configJsonPath, JSON.stringify(mutated), "utf8");

    // Second GET /config, still before refresh: must still be the STALE
    // cached value (proves the cache is genuinely being served, not
    // re-read every time) — and must NOT re-invoke the stub.
    const stillStale = await (await fetch(cacheBase + "/config")).json();
    ok(stillStale.fallback_collection === "fixture_fallback",
      `GET /config (2nd, pre-refresh) still serves the CACHED value (got ${stillStale.fallback_collection})`);
    const countBeforeRefresh = await callCount();
    ok(countBeforeRefresh === countAfterFirstConfig,
      `cached GET /config did not re-invoke the CLI (calls: ${countBeforeRefresh})`);

    // --- the action under test: POST /cache/refresh ------------------------
    const refreshRes = await fetch(cacheBase + "/cache/refresh", { method: "POST" });
    const refreshBody = await refreshRes.json();
    ok(refreshRes.status === 200 && refreshBody.cache_cleared === true,
      `POST /cache/refresh -> 200 {cache_cleared:true} (got ${refreshRes.status}, ${JSON.stringify(refreshBody)})`);

    const countAfterRefresh = await callCount();
    ok(countAfterRefresh === countBeforeRefresh,
      `POST /cache/refresh itself spawned ZERO subprocesses (calls before: ${countBeforeRefresh}, after: ${countAfterRefresh})`);

    const configJsonAfterRefresh = await readFile(configJsonPath, "utf8");
    ok(JSON.parse(configJsonAfterRefresh).fallback_collection === "fixture_fallback_CHANGED",
      "the fixture 'config.toml' file itself is untouched by the refresh action (only reflects our own earlier out-of-band edit)");

    // GET /config AFTER refresh: now reflects the out-of-band change — proves
    // the cache was genuinely cleared, not just claimed — and this GET (not
    // the refresh call) is what re-invokes the CLI.
    const after = await (await fetch(cacheBase + "/config")).json();
    ok(after.fallback_collection === "fixture_fallback_CHANGED",
      `GET /config (post-refresh) reflects the out-of-band change (got ${after.fallback_collection})`);
    const countAfterFinalConfig = await callCount();
    ok(countAfterFinalConfig === countAfterRefresh + 1,
      `the fresh re-read happened on the NEXT GET /config, not during refresh itself (calls: ${countAfterFinalConfig})`);
  } finally {
    child.kill();
    if (fails) {
      console.log("\n--- server output (cache-refresh block) ---");
      console.log(serverOutput);
    }
    await rm(dir, { recursive: true, force: true });
  }
}

// --- hard constraint: no destructive/wipe verb reachable from ANY route -----
// Checked against actual REACHABLE-code patterns (route registrations, CLI
// argv construction, fetch() targets), not a blanket prose grep — this file's
// own comments legitimately discuss "delete/wipe/drop", which would
// otherwise false-positive a naive text match.
{
  const engineSrc = await readFile(ENGINE_PATH, "utf8");
  const serverSrc = await readFile(SERVER_SRC_PATH, "utf8");
  const appJs = await readFile(path.join(__dirname, "..", "ui", "app.js"), "utf8");

  // 1) No CLI argv construction anywhere in engine.mjs builds a destructive
  //    swarm-memory verb. The only legitimate "index" invocations are
  //    remember()'s (with --no-prune) and reindex()'s (without) — both
  //    upsert/refresh, never delete a collection. swarm-memory's CLI has no
  //    delete/wipe/drop-collection verb at all (confirmed via `swarm-memory
  //    --help`: {recall,search,grep,check,scopes,index,graph,config,
  //    install-hermes} — index is the only mutating verb besides `graph
  //    add`/`graph remove`, which s-04 already proved unreachable).
  const cliArgvArrays = [...engineSrc.matchAll(/\[\s*["'`][a-z-]+["'`][\s\S]{0,120}?\]/g)].map((m) => m[0]);
  const destructivePattern = /["'`](delete|remove|drop|wipe|purge|truncate|erase|reset-collection|clear-collection)["'`]/i;
  const suspicious = cliArgvArrays.filter((s) => destructivePattern.test(s) && !/graph.{0,30}remove/i.test(s));
  ok(suspicious.length === 0,
    `no CLI-argv array in engine.mjs matches a destructive verb (checked ${cliArgvArrays.length} argv-shaped arrays; suspicious: ${JSON.stringify(suspicious)})`);

  // 2) server.mjs registers no route whose path or handler name suggests
  //    deletion/wiping, and no route dispatches to a DELETE method against
  //    any collection/index/scope resource.
  ok(!/["'`](DELETE)\s+\/(index|lanes|scopes|graph|collection)/i.test(serverSrc),
    "server.mjs registers no DELETE route over index/lanes/scopes/graph/collection resources");
  ok(!/\b(deleteCollection|wipeCollection|dropCollection|clearCollection|purgeCollection)\b/.test(serverSrc),
    "server.mjs never references a delete/wipe/drop/clear/purge-collection function");
  ok(!/\b(deleteCollection|wipeCollection|dropCollection|clearCollection|purgeCollection)\b/.test(engineSrc),
    "engine.mjs exports no delete/wipe/drop/clear/purge-collection function");

  // 3) engine.mjs's ONLY two argv-array constructions that start with the
  //    "index" verb are remember()'s and reindex()'s — no third site, no
  //    variant that could smuggle in a wipe under the same verb.
  // 3 legitimate call sites as of the mnemosyne-foundation merge: remember()
  // (additive, --no-prune), reindexPaths() (targeted, POST /index, default
  // pruning), and reindex() (bulk, POST /reindex, default pruning, scans a
  // whole directory). All three upsert/refresh via the same CLI verb — none
  // deletes/wipes a collection. See SERVICE.md's "Two reindex paths".
  const indexArgvSites = [...engineSrc.matchAll(/\[\s*["'`]index["'`]/g)];
  ok(indexArgvSites.length === 3,
    `exactly 3 argv-array constructions start with "index" (remember() + reindexPaths() + reindex()) — found ${indexArgvSites.length}`);

  // 4) resetScopeMapCache() (the "refresh"/"clear" action) touches only the
  //    in-process _scopeMap variable — no call to run()/execFile inside its
  //    body, and no fs write call either.
  const resetStart = engineSrc.indexOf("export function resetScopeMapCache(");
  ok(resetStart !== -1, "engine.mjs exports resetScopeMapCache()");
  const resetEnd = engineSrc.indexOf("\n}", resetStart);
  const resetSrc = engineSrc.slice(resetStart, resetEnd + 2);
  ok(!/run\(|execFile|writeFile|unlink|rename/.test(resetSrc),
    `resetScopeMapCache() body calls no subprocess/file-mutation primitive (body: ${JSON.stringify(resetSrc)})`);

  // 5) ui/app.js never fetch()es anything other than the known-safe route
  //    set for the reindex/cache actions — no DELETE method, no /wipe or
  //    /drop or /clear-collection path string anywhere in the whole file.
  ok(!/fetch\([^)]*method:\s*["'`]DELETE["'`]/i.test(appJs), "ui/app.js never issues a DELETE fetch() anywhere");
  ok(!/["'`]\/(wipe|drop|purge)[^"'`]*["'`]/i.test(appJs), "ui/app.js references no /wipe, /drop, or /purge path string");
  ok(appJs.includes('fetch("/index"') && appJs.includes('fetch("/cache/refresh"'),
    "ui/app.js reaches exactly the two intended new routes (/index, /cache/refresh)");
}

console.log(fails ? `\n${fails} check(s) failed` : "\nall reindex-route checks passed");
process.exit(fails ? 1 : 0);
