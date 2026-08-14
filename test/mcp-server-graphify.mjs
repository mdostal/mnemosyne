// mcp-server-graphify.mjs — la-02-graphify-adapter, AC4: real end-to-end
// verification that graph_stats/graph_edges/graph_impact/graph_deps return
// graphify-backed results (in the SAME response shape existing consumers
// expect) when the real bin/mnemosyne-mcp.mjs process is launched with
// MNEMOSYNE_LAYERS configuring a "graphify" layer.
//
// Real end-to-end, same posture as test/mcp-server.mjs: a real MCP Client
// (StdioClientTransport) spawns the real bin/mnemosyne-mcp.mjs child
// process, talks real MCP JSON-RPC over stdio. Requires the real `graphify`
// CLI (skips, does not fail, if it's not on PATH) AND a live Mnemosyne HTTP
// service dependency chain (same as test/mcp-server.mjs, since ensureRunning()
// always starts/reuses the underlying service regardless of which graph_*
// backend is selected) -- not part of the `npm test` combined script for the
// same reason test/mcp-server.mjs isn't. Run via `npm run test:mcp-server-graphify`.
//
// Uses PORT 8500 -- distinct from server.mjs's default (8477) and every
// other test file's port (8487/8491/8492/8497/8498/8499).
//
// Usage: node test/mcp-server-graphify.mjs

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const MCP_SERVER_PATH = path.join(ROOT, "bin", "mnemosyne-mcp.mjs");
const PORT = 8500;

let fails = 0;
const ok = (condition, message) => {
  console.log(`${condition ? "  PASS" : "  FAIL"}  ${message}`);
  if (!condition) fails++;
};

function isGraphifyOnPath() {
  try {
    execFileSync("graphify", ["--help"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function toolResultJson(result) {
  const text = result.content?.find((c) => c.type === "text")?.text;
  return text ? JSON.parse(text) : null;
}

async function makeFixtureRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mnemosyne-mcp-graphify-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "src", "greeter.py"),
    ["def greet(name):", '    return f"Hello, {name}!"', "", "", "class Greeter:", "    def say_hi(self, name):", "        return greet(name)", ""].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(root, "src", "main.ts"),
    ["export function main() {", '  console.log("starting app");', "}", "", "export class App {", "  run() {", "    main();", "  }", "}", ""].join("\n"),
    "utf8",
  );
  return root;
}

async function main() {
  if (!isGraphifyOnPath()) {
    console.log("graphify not found on PATH -- skipping (install via `uv tool install graphifyy` to run this locally).");
    process.exit(0);
    return;
  }

  const root = await makeFixtureRepo();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_SERVER_PATH],
    env: {
      ...process.env,
      PORT: String(PORT),
      MNEMOSYNE_LAYERS: JSON.stringify({ layers: [{ name: "graphify", options: { repoRoot: root } }] }),
    },
  });
  const client = new Client({ name: "mcp-server-graphify-test", version: "0.1.0" });

  try {
    await client.connect(transport);
    ok(true, "client connected to the real mnemosyne-mcp server (MNEMOSYNE_LAYERS=graphify) over stdio");

    const statsResult = await client.callTool({ name: "graph_stats", arguments: {} });
    ok(!statsResult.isError, `graph_stats did not error (${JSON.stringify(statsResult)})`);
    const stats = toolResultJson(statsResult);
    ok(stats && stats.nodes === 8 && stats.edges === 8, `graph_stats returns graphify's real counts for the fixture repo (${JSON.stringify(stats)})`);
    ok(typeof stats.db === "string" && stats.db.endsWith("graph.json"), `graph_stats.db points at graphify's graph.json, not swarm-memory's sqlite (${stats.db})`);

    // Envelope shapes below ({node, count, edges/impact/deps, took_ms})
    // match src/server.mjs's real GET /graph/edges|impact|deps routes
    // exactly (confirmed live) -- the point of AC4 is that graphify-backed
    // results come back in the SAME shape swarm-memory-backed ones already
    // do, not a bare array.
    const edgesResult = await client.callTool({ name: "graph_edges", arguments: { node: "Greeter" } });
    ok(!edgesResult.isError, "graph_edges did not error");
    const edges = toolResultJson(edgesResult);
    ok(edges.node === "Greeter", "graph_edges echoes the requested node");
    ok(Array.isArray(edges.edges) && edges.edges.length > 0, `graph_edges(node="Greeter") returns real edges (${JSON.stringify(edges)})`);
    ok(edges.count === edges.edges.length, "graph_edges.count matches edges.length");

    const impactResult = await client.callTool({ name: "graph_impact", arguments: { node: "greet()", depth: 2 } });
    ok(!impactResult.isError, "graph_impact did not error");
    const impact = toolResultJson(impactResult);
    ok(
      Array.isArray(impact.impact) && impact.impact.some((hit) => hit.node === ".say_hi()"),
      `graph_impact(node="greet()") includes the real caller .say_hi() (${JSON.stringify(impact)})`,
    );

    const depsResult = await client.callTool({ name: "graph_deps", arguments: { node: "App", depth: 2 } });
    ok(!depsResult.isError, "graph_deps did not error");
    const deps = toolResultJson(depsResult);
    ok(
      Array.isArray(deps.deps) && deps.deps.some((hit) => hit.node === ".run()"),
      `graph_deps(node="App") includes the real .run() method (${JSON.stringify(deps)})`,
    );
  } finally {
    await client.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }

  console.log(`\n${fails === 0 ? "all mcp-server-graphify checks passed" : `${fails} FAILURE(S)`}`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
