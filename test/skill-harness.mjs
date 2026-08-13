// skill-harness.mjs — TDD tests for s-06's Claude Code skill harness:
// bin/mnemosyne-skill-helper.mjs's ensureRunning() health-check-then-start
// logic, and its recall/remember/grep/reindex/graph-* action pass-throughs.
//
// Three postures, matching this repo's existing conventions
// (test/reindex-route.mjs, test/graph-route.mjs):
//
//   1. Not-running-then-start: point ensureRunning() at a port nothing is
//      listening on (real spawnFn) and prove it spawns bin/mnemosyne, polls
//      GET /health for real, and reports readiness + the /ui URL.
//   2. Already-running-skip-start: start a REAL server subprocess first
//      (same pattern as graph-route.mjs/reindex-route.mjs), then call
//      ensureRunning() with a SPY spawnFn and prove the spy is never
//      invoked — i.e. no second process / no second port-bind attempt.
//   3. Pass-through correctness: against that same already-running server,
//      call every exposed action (recall/remember/grep/reindex/graph-*)
//      through the helper and diff the result against a direct fetch() to
//      the same route — same top-level keys (nothing dropped/reformatted)
//      and matching values on every field that isn't inherently
//      per-call-nondeterministic (timestamps, took_ms).
//
// Uses a distinct PORT range (8497+) so this never collides with a server
// already running on the default 8477, or with any other test file's port.
//
// Usage: node test/skill-harness.mjs
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureRunning,
  checkHealth,
  uiUrl,
  recallAction,
  rememberAction,
  grepAction,
  reindexAction,
  graphStatsAction,
  graphEdgesAction,
  graphImpactAction,
  graphDepsAction,
} from "../bin/mnemosyne-skill-helper.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, "..", "src", "server.mjs");

// Not-running port: nothing should ever be listening here before test 1 runs.
const NOT_RUNNING_PORT = Number(process.env.MNEMOSYNE_TEST_PORT || 8497);
// Already-running port: we spawn a real server here ourselves for tests 2+3.
const RUNNING_PORT = NOT_RUNNING_PORT + 1;

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

// Strips per-call-nondeterministic fields (timing/timestamps) before
// comparing two responses to the "same" call for structural/value equality.
function stripVolatile(obj) {
  const clone = JSON.parse(JSON.stringify(obj));
  const strip = (o) => {
    if (o && typeof o === "object") {
      for (const k of Object.keys(o)) {
        if (k === "took_ms" || k === "retrieved_at") delete o[k];
        else strip(o[k]);
      }
    }
  };
  strip(clone);
  return clone;
}

// =========================================================================
// 1) Not-running-then-start: real spawnFn, nothing listening on this port.
// =========================================================================
{
  const preCheck = await checkHealth(NOT_RUNNING_PORT, { timeoutMs: 800 });
  ok(preCheck.ok === false, `precondition: nothing healthy on port ${NOT_RUNNING_PORT} yet`);

  let result;
  let threw = null;
  try {
    result = await ensureRunning({ port: NOT_RUNNING_PORT, startTimeoutMs: 45_000 });
  } catch (e) {
    threw = e;
  }

  try {
    ok(threw === null, `ensureRunning() did not throw (${threw && threw.message})`);
    ok(!!result && result.started === true, "ensureRunning() reports started:true (it spawned bin/mnemosyne)");
    ok(result && result.alreadyRunning === false, "ensureRunning() reports alreadyRunning:false");
    ok(result && result.health && result.health.ok === true, "ensureRunning() polled GET /health until it went green");
    ok(result && result.ui === uiUrl(NOT_RUNNING_PORT), `ensureRunning() reports the /ui URL (${result && result.ui})`);
    ok(result && typeof result.pid === "number" && result.pid > 0, "ensureRunning() returns the spawned process's pid");

    // Confirm it's genuinely reachable now, independent of the helper.
    const direct = await fetch(`http://127.0.0.1:${NOT_RUNNING_PORT}/health`);
    const directBody = await direct.json();
    ok(direct.status === 200 && directBody.ok === true, "the newly-started server independently answers GET /health -> 200 {ok:true}");
  } finally {
    // Clean up the process we started (bin/mnemosyne execs into `node
    // src/server.mjs`, so the pid IS the node process — no process group to
    // chase).
    if (result && result.pid) {
      try { process.kill(result.pid); } catch { /* already gone */ }
    }
  }
}

// =========================================================================
// 2) Already-running-skip-start + 3) pass-through correctness — share one
//    real subprocess server on RUNNING_PORT.
// =========================================================================
{
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, PORT: String(RUNNING_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverOutput = "";
  child.stdout.on("data", (d) => { serverOutput += d.toString(); });
  child.stderr.on("data", (d) => { serverOutput += d.toString(); });

  const dir = await mkdtemp(path.join(tmpdir(), "mnemosyne-skill-harness-"));

  try {
    const up = await waitForServer(`http://127.0.0.1:${RUNNING_PORT}/scopes`);
    ok(up, "already-running test server came up");

    // --- 2) already-running-skip-start: spy proves NO second process ------
    let spyCalls = 0;
    const spawnSpy = (...args) => {
      spyCalls += 1;
      throw new Error(`spawnFn should never be called when already healthy (args: ${JSON.stringify(args)})`);
    };
    const result = await ensureRunning({ port: RUNNING_PORT, spawnFn: spawnSpy, healthCheckTimeoutMs: 8000 });
    ok(result.alreadyRunning === true && result.started === false, "ensureRunning() reports alreadyRunning:true, started:false");
    ok(spyCalls === 0, `ensureRunning() spawned ZERO processes when already healthy (spy calls: ${spyCalls})`);
    ok(result.ui === uiUrl(RUNNING_PORT), `ensureRunning() still reports the /ui URL when already running (${result.ui})`);

    // --- 3) pass-through correctness: helper action vs direct fetch() -----
    // recall
    {
      const query = "mnemosyne skill harness pass-through recall check";
      const direct = await (await fetch(`http://127.0.0.1:${RUNNING_PORT}/recall`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, hits: 3 }),
      })).json();
      const viaHelper = await recallAction(RUNNING_PORT, { query, hits: 3 });
      ok(Object.keys(viaHelper).sort().join(",") === Object.keys(direct).sort().join(","),
        `recallAction() top-level keys match GET/POST /recall exactly (${Object.keys(viaHelper).sort().join(",")})`);
      ok(viaHelper.total_hits === direct.total_hits, `recallAction() total_hits matches direct call (${viaHelper.total_hits})`);
      ok(JSON.stringify(stripVolatile(viaHelper.scopes)) === JSON.stringify(stripVolatile(direct.scopes)),
        "recallAction() scopes/hits payload matches direct call (minus volatile fields) — no reformatting or data loss");
    }

    // grep
    {
      const query = "mnemosyne skill harness pass-through grep check";
      const direct = await (await fetch(`http://127.0.0.1:${RUNNING_PORT}/grep`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, hits: 3 }),
      })).json();
      const viaHelper = await grepAction(RUNNING_PORT, { query, hits: 3 });
      ok(Object.keys(viaHelper).sort().join(",") === Object.keys(direct).sort().join(","),
        `grepAction() top-level keys match POST /grep exactly (${Object.keys(viaHelper).sort().join(",")})`);
      ok(viaHelper.match_mode === "keyword", "grepAction() carries grep's own match_mode:'keyword' marker (genuinely dispatched to grep)");
      ok(JSON.stringify(stripVolatile(viaHelper)) === JSON.stringify(stripVolatile(direct)),
        "grepAction() full payload matches direct call (minus volatile fields)");
    }

    // remember (real, small, additive write — same convention as
    // test/smoke.mjs / test/hooks.mjs: a unique-token throwaway note).
    {
      const token = `MNEMO-SKILL-HARNESS-${Date.now()}`;
      const text = `Skill harness pass-through remember check. Unique token ${token}.`;
      const viaHelper = await rememberAction(RUNNING_PORT, { text, scope: "personal", tag: "skill-harness-test" });
      ok(viaHelper.remembered === true, "rememberAction() -> remembered:true");
      ok(typeof viaHelper.collection === "string" && viaHelper.collection.length > 0,
        `rememberAction() echoes a real collection (${viaHelper.collection})`);
      ok(typeof viaHelper.chunks_upserted === "number", "rememberAction() carries chunks_upserted from the engine's real output");
      const expectedKeys = ["remembered", "scope", "collection", "file", "chunks_upserted", "engine_output", "took_ms"].sort().join(",");
      ok(Object.keys(viaHelper).sort().join(",") === expectedKeys,
        `rememberAction() top-level keys match POST /remember's documented shape exactly (${Object.keys(viaHelper).sort().join(",")})`);
    }

    // reindex (real, tiny, scoped throwaway file into personal_memory — same
    // convention as test/reindex-route.mjs).
    {
      const token = `MNEMO-SKILL-HARNESS-REINDEX-${Date.now()}`;
      const file = path.join(dir, "skill-harness-reindex-note.md");
      await writeFile(
        file,
        `<!-- s-06 skill-harness.mjs throwaway test artifact -->\nSkill harness reindex pass-through check. Unique token ${token}.\n`,
        "utf8"
      );
      const viaHelper = await reindexAction(RUNNING_PORT, { collection: "personal_memory", paths: [file] });
      ok(viaHelper.reindexed === true, "reindexAction() -> reindexed:true");
      ok(viaHelper.collection === "personal_memory", `reindexAction() echoes collection (${viaHelper.collection})`);
      ok(Array.isArray(viaHelper.paths) && viaHelper.paths[0] === file, "reindexAction() echoes the requested path(s)");
      ok(viaHelper.files_indexed === 1, `reindexAction() files_indexed === 1 (${viaHelper.files_indexed})`);
      ok(typeof viaHelper.engine_output === "string" && /files indexed/.test(viaHelper.engine_output),
        "reindexAction() carries the CLI's own real stdout (not synthesized)");

      // 400 path — thin pass-through, no new validation logic invented here.
      let threw400 = null;
      try {
        await reindexAction(RUNNING_PORT, { paths: [file] });
      } catch (e) {
        threw400 = e;
      }
      ok(threw400 && threw400.status === 400, `reindexAction() surfaces the API's own 400 for a missing collection (status=${threw400 && threw400.status})`);
    }

    // graph-stats / graph-edges / graph-impact / graph-deps
    {
      const directStats = await (await fetch(`http://127.0.0.1:${RUNNING_PORT}/graph/stats`)).json();
      const viaStats = await graphStatsAction(RUNNING_PORT);
      ok(JSON.stringify(stripVolatile(viaStats)) === JSON.stringify(stripVolatile(directStats)),
        `graphStatsAction() matches GET /graph/stats exactly (nodes=${viaStats.nodes}, edges=${viaStats.edges})`);

      const directEdges = await (await fetch(`http://127.0.0.1:${RUNNING_PORT}/graph/edges`)).json();
      const viaEdges = await graphEdgesAction(RUNNING_PORT, {});
      ok(JSON.stringify(stripVolatile(viaEdges)) === JSON.stringify(stripVolatile(directEdges)),
        `graphEdgesAction() matches GET /graph/edges exactly (count=${viaEdges.count})`);

      if (Array.isArray(directEdges.edges) && directEdges.edges.length) {
        const node = directEdges.edges[0].dst;
        const directImpact = await (await fetch(`http://127.0.0.1:${RUNNING_PORT}/graph/impact/${encodeURIComponent(node)}`)).json();
        const viaImpact = await graphImpactAction(RUNNING_PORT, node);
        ok(JSON.stringify(stripVolatile(viaImpact)) === JSON.stringify(stripVolatile(directImpact)),
          `graphImpactAction(${node}) matches GET /graph/impact/:node exactly`);

        const srcNode = directEdges.edges[0].src;
        const directDeps = await (await fetch(`http://127.0.0.1:${RUNNING_PORT}/graph/deps/${encodeURIComponent(srcNode)}`)).json();
        const viaDeps = await graphDepsAction(RUNNING_PORT, srcNode);
        ok(JSON.stringify(stripVolatile(viaDeps)) === JSON.stringify(stripVolatile(directDeps)),
          `graphDepsAction(${srcNode}) matches GET /graph/deps/:node exactly`);
      } else {
        // Empty graph is a legitimate live state — still prove the
        // unknown-node contract (empty array, not an error) passes through.
        const unknown = "no-such-node-skill-harness-test";
        const viaImpact = await graphImpactAction(RUNNING_PORT, unknown);
        ok(Array.isArray(viaImpact.impact) && viaImpact.impact.length === 0,
          "graphImpactAction() on an unknown node returns {impact:[]}, not an error (matches API contract)");
      }
    }
  } finally {
    child.kill();
    await rm(dir, { recursive: true, force: true });
    if (fails) {
      console.log("\n--- server output (already-running block) ---");
      console.log(serverOutput);
    }
  }
}

// =========================================================================
// Source-level: no bypass of the HTTP API anywhere in the helper.
// =========================================================================
{
  const { readFile } = await import("node:fs/promises");
  const helperPath = path.join(__dirname, "..", "bin", "mnemosyne-skill-helper.mjs");
  const helperSrc = await readFile(helperPath, "utf8");
  ok(!/execFile|child_process.*exec\b|from ["'`].*engine\.mjs["'`]/.test(helperSrc),
    "mnemosyne-skill-helper.mjs never imports engine.mjs and never shells out to a CLI directly (execFile/exec) — every action is a fetch() against the HTTP API");
  // The word "swarm-memory" legitimately appears in this file's own doc
  // comments (explaining what it deliberately does NOT do) — so check the
  // executable code only (comment lines stripped), not prose: no string
  // literal naming the CLI binary anywhere reachable code could use it.
  const codeOnly = helperSrc
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
  ok(!/["'`]swarm-memory["'`]/.test(codeOnly),
    "mnemosyne-skill-helper.mjs's executable code never references the swarm-memory binary as a string literal (no CLI invocation)");
  ok(/spawnFn\(/.test(helperSrc) && /BIN_PATH/.test(helperSrc),
    "the only process this file spawns is bin/mnemosyne itself (the existing supervised-run entrypoint)");
}

console.log(fails ? `\n${fails} check(s) failed` : "\nall skill-harness checks passed");
process.exit(fails ? 1 : 0);
