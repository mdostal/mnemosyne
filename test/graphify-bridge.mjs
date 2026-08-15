// graphify-bridge.mjs — TDD tests for la-02-graphify-adapter's MCP-surface
// wiring: bin/graphify-bridge.mjs's graphifyStatsAction/graphifyEdgesAction/
// graphifyImpactAction/graphifyDepsAction, and the MNEMOSYNE_LAYERS gating
// (isGraphifyConfigured/findGraphifyLayerEntry) that bin/mnemosyne-mcp.mjs
// uses to select between this bridge and the swarm-memory-backed default.
//
// Runs the REAL `graphify` CLI (installed via `uv tool install graphifyy`)
// against a REAL, freshly generated `graph.json` from two small real source
// files across two languages (Python + TypeScript) — no mocking of the core
// read path. `graphify` is not installed in this repo's CI (see
// .github/workflows/ci.yml — Node-only setup), so this file is intentionally
// NOT part of the `npm test` combined script; run it locally via
// `npm run test:graphify-bridge` after installing graphify.
//
// Usage: node test/graphify-bridge.mjs

import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_PATH = path.join(__dirname, "..", "bin", "graphify-bridge.mjs");

import {
  readLayersConfig,
  findGraphifyLayerEntry,
  isGraphifyConfigured,
  isGraphifyExplicitlyConfigured,
  isGraphifyOnPath as isGraphifyOnPathEnv,
  graphifyStatsAction,
  graphifyEdgesAction,
  graphifyImpactAction,
  graphifyDepsAction,
} from "../bin/graphify-bridge.mjs";

function isGraphifyOnPath() {
  try {
    execFileSync("graphify", ["--help"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function makeFixtureRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mnemosyne-graphify-bridge-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "src", "greeter.py"),
    [
      "def greet(name):",
      '    return f"Hello, {name}!"',
      "",
      "",
      "class Greeter:",
      "    def say_hi(self, name):",
      "        return greet(name)",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(root, "src", "main.ts"),
    [
      "export function main() {",
      '  console.log("starting app");',
      "}",
      "",
      "export class App {",
      "  run() {",
      "    main();",
      "  }",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  return root;
}

async function main() {
  let fails = 0;
  const ok = (condition, message) => {
    console.log(`${condition ? "  PASS" : "  FAIL"}  ${message}`);
    if (!condition) fails++;
  };

  // --- MNEMOSYNE_LAYERS gating (no external binary needed) ------------------
  console.log("SECTION: MNEMOSYNE_LAYERS gating");
  {
    ok(readLayersConfig({}) === null, "readLayersConfig() is null when MNEMOSYNE_LAYERS is unset");
    ok(findGraphifyLayerEntry({}) === null, "findGraphifyLayerEntry() is null when unset");
    // env={} has no PATH at all -> isGraphifyOnPath({}) is false -> the
    // soft-default fallback applies -> isGraphifyConfigured({}) stays
    // false, same observable result as before cr-01, just via a different
    // (PATH-aware) code path now.
    ok(isGraphifyConfigured({}) === false, "isGraphifyConfigured() is false when unset and graphify isn't resolvable (no PATH in env)");

    const withVector = { MNEMOSYNE_LAYERS: JSON.stringify({ layers: [{ name: "vector" }] }) };
    ok(isGraphifyExplicitlyConfigured(withVector) === false, "isGraphifyExplicitlyConfigured() is false when layers omit graphify");
    ok(
      isGraphifyConfigured({ ...withVector, PATH: process.env.PATH }) === false,
      "isGraphifyConfigured() is false when layers explicitly omit graphify, even with graphify ON PATH -- pluggability: explicit config is authoritative, graphify is never invoked",
    );

    const withGraphify = {
      MNEMOSYNE_LAYERS: JSON.stringify({ layers: [{ name: "graphify", options: { repoRoot: "/tmp/x" } }] }),
    };
    ok(isGraphifyConfigured(withGraphify) === true, "isGraphifyConfigured() is true when layers include graphify");
    const entry = findGraphifyLayerEntry(withGraphify);
    ok(entry?.options?.repoRoot === "/tmp/x", "findGraphifyLayerEntry() surfaces the configured options");

    let threw = false;
    try {
      readLayersConfig({ MNEMOSYNE_LAYERS: "{not json" });
    } catch (error) {
      threw = /not valid JSON/.test(error.message);
    }
    ok(threw, "invalid MNEMOSYNE_LAYERS JSON throws loudly, never silently ignored");
  }

  // --- soft-default gating (cr-01-graphify-default-layer) -------------------
  // Deterministic PATH simulation via a throwaway PATH directory (with or
  // without a fake "graphify" executable in it) -- doesn't depend on
  // whether the real graphify CLI happens to be installed on the machine
  // running this suite.
  console.log("SECTION: soft-default gating (MNEMOSYNE_LAYERS entirely unset)");
  {
    const fakePathWithGraphify = await mkdtemp(path.join(os.tmpdir(), "mnemosyne-graphify-bridge-fakepath-"));
    const fakeBin = path.join(fakePathWithGraphify, "graphify");
    await writeFile(fakeBin, "#!/bin/sh\necho fake-graphify\n", "utf8");
    await chmod(fakeBin, 0o755);

    ok(isGraphifyOnPathEnv({ PATH: fakePathWithGraphify }) === true, "isGraphifyOnPath() finds a fake graphify executable on a fake PATH");
    ok(
      isGraphifyConfigured({ PATH: fakePathWithGraphify }) === true,
      "isGraphifyConfigured() is true when MNEMOSYNE_LAYERS is unset AND graphify IS on PATH -- soft default picks graphify",
    );

    const emptyPathDir = await mkdtemp(path.join(os.tmpdir(), "mnemosyne-graphify-bridge-emptypath-"));
    ok(isGraphifyOnPathEnv({ PATH: emptyPathDir }) === false, "isGraphifyOnPath() is false when the PATH dir has no graphify executable");

    // Real subprocess: PATH-broken fallback case, per the epic's TDD
    // guidance -- confirms the WARNING (not a thrown error) really is what
    // happens when a bare, unconfigured install's PATH genuinely lacks
    // graphify. Spawns a fresh node process so this file's own real PATH
    // (which has graphify installed, per this suite's later sections)
    // can't leak in and mask the fallback.
    const probeScript = `
      const { isGraphifyConfigured } = await import(${JSON.stringify(BRIDGE_PATH)});
      const configured = isGraphifyConfigured();
      console.log(JSON.stringify({ configured }));
    `;
    const { spawnSync } = await import("node:child_process");
    const subprocessResult = spawnSync(process.execPath, ["--input-type=module", "-e", probeScript], {
      env: { ...process.env, PATH: emptyPathDir, MNEMOSYNE_LAYERS: "" },
      encoding: "utf8",
    });
    ok(
      subprocessResult.status === 0,
      `a real subprocess with a graphify-less PATH and no MNEMOSYNE_LAYERS exits 0 (soft fallback, not a hard failure) -- status: ${subprocessResult.status}, stderr: ${subprocessResult.stderr}`,
    );
    ok(
      /"configured":false/.test(subprocessResult.stdout),
      `subprocess reports isGraphifyConfigured()===false when graphify is missing from PATH (stdout: ${subprocessResult.stdout})`,
    );
    ok(
      /WARNING: graphify is not installed or not found on PATH/.test(subprocessResult.stderr),
      `subprocess logs a loud WARNING (not silent) about the missing binary on stderr (stderr: ${subprocessResult.stderr})`,
    );

    await rm(fakePathWithGraphify, { recursive: true, force: true });
    await rm(emptyPathDir, { recursive: true, force: true });
  }

  // --- loud failure: no graph.json, autoUpdate disabled ----------------------
  console.log("SECTION: loud failure (no graphify binary needed for this one)");
  {
    const emptyRoot = await mkdtemp(path.join(os.tmpdir(), "mnemosyne-graphify-bridge-empty-"));
    const env = {
      MNEMOSYNE_LAYERS: JSON.stringify({
        layers: [{ name: "graphify", options: { repoRoot: emptyRoot, autoUpdate: false } }],
      }),
    };
    let threw = false;
    let message = "";
    try {
      await graphifyStatsAction(null, {}, env);
    } catch (error) {
      threw = true;
      message = error.message;
    }
    ok(threw, "graphifyStatsAction() throws (not a silent empty stats object) when graph.json is missing and autoUpdate:false");
    ok(/graph\.json/.test(message), `error message names graph.json (${message})`);
    await rm(emptyRoot, { recursive: true, force: true });
  }

  if (!isGraphifyOnPath()) {
    console.log(
      "graphify not found on PATH -- skipping real-binary integration tests " +
        "(install via `uv tool install graphifyy` to run them).",
    );
    console.log(`\n${fails === 0 ? "ALL PASS" : `${fails} FAILURE(S)`}`);
    process.exit(fails === 0 ? 0 : 1);
    return;
  }

  const root = await makeFixtureRepo();
  const env = { MNEMOSYNE_LAYERS: JSON.stringify({ layers: [{ name: "graphify", options: { repoRoot: root } }] }) };

  // --- graphifyStatsAction(): real graph.json ---------------------------
  console.log("SECTION: graphifyStatsAction() against a real graph.json");
  let stats;
  {
    stats = await graphifyStatsAction(null, {}, env);
    ok(typeof stats.nodes === "number" && stats.nodes > 0, `stats.nodes is a positive number (${stats.nodes})`);
    ok(typeof stats.edges === "number" && stats.edges > 0, `stats.edges is a positive number (${stats.edges})`);
    ok(
      stats.edges_by_origin && typeof stats.edges_by_origin === "object" && stats.edges_by_origin.ast > 0,
      `stats.edges_by_origin has a real "ast" bucket (${JSON.stringify(stats.edges_by_origin)})`,
    );
    ok(typeof stats.db === "string" && stats.db.endsWith("graph.json"), `stats.db points at graph.json (${stats.db})`);
    ok(typeof stats.took_ms === "number", "stats.took_ms is present (matches the real GET /graph/stats envelope)");
  }

  // --- graphifyEdgesAction(): shape (matches GET /graph/edges's real
  // {node, count, edges, took_ms} envelope, confirmed live against
  // src/server.mjs) + node filter -----------------------------------------
  console.log("SECTION: graphifyEdgesAction()");
  {
    const allEdgesResult = await graphifyEdgesAction(null, {}, env);
    ok(allEdgesResult.node === null, "graphifyEdgesAction({}) reports node: null, matching the real envelope");
    ok(Array.isArray(allEdgesResult.edges), "graphifyEdgesAction().edges is an array");
    ok(allEdgesResult.count === allEdgesResult.edges.length, "count matches edges.length");
    ok(allEdgesResult.edges.length === stats.edges, `edges length (${allEdgesResult.edges.length}) matches stats.edges (${stats.edges})`);
    const e = allEdgesResult.edges[0];
    ok(
      typeof e.src === "string" && typeof e.dst === "string" && typeof e.predicate === "string",
      `edge has src/predicate/dst (${JSON.stringify(e)})`,
    );
    ok(
      typeof e.src_label === "string" && typeof e.dst_label === "string",
      `edge has src_label/dst_label for display (${JSON.stringify(e)})`,
    );
    ok(e.origin === "ast", `edge origin is "ast" (real deterministic AST parsing, no LLM) (${e.origin})`);
    ok(e.created_at === null, "edge created_at is explicitly null (graphify has no per-edge timestamp)");

    // src/dst are real graph.json node ids now (not labels) -- a genuine
    // fix, not a relaxation: two distinct nodes sharing a short label used
    // to collapse into one under the old label-based contract, verified to
    // actually happen at scale on a real merged cross-repo graph (306 real
    // connected components collapsed to 95). Assert against src_label/
    // dst_label for the human-readable match instead of src/dst directly.
    const greeterEdgesResult = await graphifyEdgesAction(null, { node: "Greeter" }, env);
    ok(greeterEdgesResult.node === "Greeter", "graphifyEdgesAction({node}) echoes the requested node (search term, not id)");
    ok(greeterEdgesResult.edges.length > 0, `edges touching "Greeter" is non-empty (${greeterEdgesResult.edges.length})`);
    ok(
      greeterEdgesResult.edges.every((edge) => edge.src_label === "Greeter" || edge.dst_label === "Greeter"),
      `every filtered edge actually touches Greeter, by label (${JSON.stringify(greeterEdgesResult.edges.map((e) => [e.src_label, e.dst_label]))})`,
    );
  }

  // --- graphifyImpactAction() / graphifyDepsAction(): real traversal, same
  // {node, count, impact/deps, took_ms} envelope as GET /graph/impact|deps --
  console.log("SECTION: graphifyImpactAction() / graphifyDepsAction()");
  {
    const impactResult = await graphifyImpactAction(null, "greet()", { depth: 2 }, env);
    ok(impactResult.node === "greet()", "graphifyImpactAction() echoes the requested node");
    ok(Array.isArray(impactResult.impact), "graphifyImpactAction().impact is an array");
    ok(impactResult.count === impactResult.impact.length, "impact count matches impact.length");
    ok(
      impactResult.impact.some((hit) => hit.node === ".say_hi()" || hit.via.includes(".say_hi()")),
      `impact on greet() includes .say_hi() (the real caller) (${JSON.stringify(impactResult.impact)})`,
    );

    const depsResult = await graphifyDepsAction(null, "App", { depth: 2 }, env);
    ok(Array.isArray(depsResult.deps), "graphifyDepsAction().deps is an array");
    ok(
      depsResult.deps.some((hit) => hit.node === ".run()"),
      `deps of App includes .run() (real containment edge) (${JSON.stringify(depsResult.deps)})`,
    );

    let requireThrew = false;
    try {
      await graphifyImpactAction(null, "", {}, env);
    } catch (error) {
      requireThrew = /node is required/.test(error.message);
    }
    ok(requireThrew, "graphifyImpactAction() requires a non-empty node, loudly");

    const unknownResult = await graphifyDepsAction(null, "TotallyUnknownNode123", {}, env);
    ok(
      Array.isArray(unknownResult.deps) && unknownResult.deps.length === 0 && unknownResult.count === 0,
      "an unknown node returns a clean empty deps array, not an error",
    );
  }

  await rm(root, { recursive: true, force: true });

  console.log(`\n${fails === 0 ? "ALL PASS" : `${fails} FAILURE(S)`}`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
