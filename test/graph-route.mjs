// graph-route.mjs — TDD tests for s-04's GET /graph/* routes: /graph/stats,
// /graph/edges, /graph/impact/:node, /graph/deps/:node.
//
// Runs against a REAL (subprocess) Mnemosyne server. Graph commands read a
// local sqlite file (~/.local/share/swarm-memory/graph.sqlite by default)
// and never touch Qdrant, so most of this suite runs against the real live
// graph (per the story's acceptance criteria: rendered counts must match
// `swarm-memory graph stats` directly, not a fixture standing in for it).
// The zero-edges empty-state case points the subprocess at a fresh,
// throwaway graph.sqlite via SWARM_MEMORY_GRAPH_DB — never the real one.
//
// Also asserts (per s-04's hard constraint): GET /ui never exposes any
// action reaching `swarm-memory graph add`/`graph remove`.
//
// Usage: node test/graph-route.mjs
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { graphStats, graphEdges, graphImpact, graphDeps } from "../src/engine.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, "..", "src", "server.mjs");
const PORT = Number(process.env.MNEMOSYNE_TEST_PORT || 8487);
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

const child = spawn(process.execPath, [SERVER_PATH], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});

let serverOutput = "";
child.stdout.on("data", (d) => { serverOutput += d.toString(); });
child.stderr.on("data", (d) => { serverOutput += d.toString(); });

try {
  const up = await waitForServer(BASE + "/scopes");
  ok(up, "test server came up");

  // --- GET /graph/stats: counts match `swarm-memory graph stats` directly ---
  let liveStats;
  {
    const direct = await graphStats();
    liveStats = direct;
    const res = await fetch(BASE + "/graph/stats");
    const body = await res.json();
    ok(res.status === 200, `GET /graph/stats -> 200 (got ${res.status})`);
    ok(body.nodes === direct.nodes, `GET /graph/stats nodes (${body.nodes}) === direct CLI nodes (${direct.nodes})`);
    ok(body.edges === direct.edges, `GET /graph/stats edges (${body.edges}) === direct CLI edges (${direct.edges})`);
    ok(JSON.stringify(body.edges_by_origin) === JSON.stringify(direct.edges_by_origin),
      "GET /graph/stats edges_by_origin matches direct CLI output");
  }

  // --- GET /graph/edges: shape + count matches `swarm-memory graph edges` ---
  let liveEdges;
  {
    const direct = await graphEdges();
    liveEdges = direct;
    const res = await fetch(BASE + "/graph/edges");
    const body = await res.json();
    ok(res.status === 200, `GET /graph/edges -> 200 (got ${res.status})`);
    ok(Array.isArray(body.edges), "GET /graph/edges returns {edges: [...]}");
    ok(body.edges.length === direct.length,
      `GET /graph/edges length (${body.edges.length}) === direct CLI length (${direct.length})`);
    ok(body.count === direct.length, `GET /graph/edges echoes count (${body.count})`);
    if (direct.length) {
      ok(JSON.stringify(body.edges[0]) === JSON.stringify(direct[0]), "first edge matches direct CLI output exactly");
    }
  }

  // --- GET /graph/edges?node=X: filters, matches `graph edges NODE` ---------
  if (liveEdges.length) {
    const target = liveEdges[0].dst;
    const direct = await graphEdges(target);
    const res = await fetch(BASE + "/graph/edges?" + new URLSearchParams({ node: target }));
    const body = await res.json();
    ok(res.status === 200, `GET /graph/edges?node= -> 200 (got ${res.status})`);
    ok(body.edges.length === direct.length,
      `GET /graph/edges?node=${target} length matches direct CLI (${body.edges.length} vs ${direct.length})`);
    ok(body.node === target, "response echoes the requested node");
  }

  // --- GET /graph/impact/:node: matches `swarm-memory graph impact NODE` ----
  if (liveEdges.length) {
    const node = liveEdges[0].dst;
    const direct = await graphImpact(node);
    const res = await fetch(BASE + "/graph/impact/" + encodeURIComponent(node));
    const body = await res.json();
    ok(res.status === 200, `GET /graph/impact/:node -> 200 (got ${res.status})`);
    ok(Array.isArray(body.impact), "response has {impact: [...]}");
    ok(JSON.stringify(body.impact) === JSON.stringify(direct),
      `GET /graph/impact/${node} matches direct \`swarm-memory graph impact\` output exactly`);
    ok(body.node === node, "response echoes the requested node");
  }

  // --- GET /graph/deps/:node: matches `swarm-memory graph deps NODE` --------
  if (liveEdges.length) {
    const node = liveEdges[0].src;
    const direct = await graphDeps(node);
    const res = await fetch(BASE + "/graph/deps/" + encodeURIComponent(node));
    const body = await res.json();
    ok(res.status === 200, `GET /graph/deps/:node -> 200 (got ${res.status})`);
    ok(Array.isArray(body.deps), "response has {deps: [...]}");
    ok(JSON.stringify(body.deps) === JSON.stringify(direct),
      `GET /graph/deps/${node} matches direct \`swarm-memory graph deps\` output exactly`);
    ok(body.node === node, "response echoes the requested node");
  }

  // --- GET /graph/impact/:node and /graph/deps/:node for an unknown node ----
  // (empty array, not an error — proven live against engine.mjs above)
  {
    const nodeEnc = encodeURIComponent("no-such-node-xyz-mnemosyne-test");
    const impactRes = await fetch(BASE + "/graph/impact/" + nodeEnc);
    const impactBody = await impactRes.json();
    ok(impactRes.status === 200 && Array.isArray(impactBody.impact) && impactBody.impact.length === 0,
      `GET /graph/impact/:unknown-node -> 200 {impact: []} (got ${impactRes.status}, ${JSON.stringify(impactBody.impact)})`);

    const depsRes = await fetch(BASE + "/graph/deps/" + nodeEnc);
    const depsBody = await depsRes.json();
    ok(depsRes.status === 200 && Array.isArray(depsBody.deps) && depsBody.deps.length === 0,
      `GET /graph/deps/:unknown-node -> 200 {deps: []} (got ${depsRes.status}, ${JSON.stringify(depsBody.deps)})`);
  }

  // --- node names with '/' round-trip correctly through the URL path --------
  if (liveEdges.some((e) => e.src.includes("/"))) {
    const slashy = liveEdges.find((e) => e.src.includes("/")).src;
    const direct = await graphDeps(slashy);
    const res = await fetch(BASE + "/graph/deps/" + encodeURIComponent(slashy));
    const body = await res.json();
    ok(res.status === 200 && body.node === slashy,
      `a node name containing '/' (${slashy}) round-trips through GET /graph/deps/:node`);
    ok(JSON.stringify(body.deps) === JSON.stringify(direct), "and its deps match the direct CLI call");
  }

  // --- GET /ui mentions the Graph panel --------------------------------------
  {
    const res = await fetch(BASE + "/ui");
    const body = await res.text();
    ok(res.status === 200, `GET /ui -> 200 (got ${res.status})`);
    ok(/graph/i.test(body), "GET /ui body mentions a Graph panel");
    ok(/graph-panel|id="graph"/i.test(body), "GET /ui body has a graph panel section");
  }

  // --- hard constraint: no UI path reaches `graph add`/`graph remove` -------
  // Checked against the actual REACHABLE-code patterns (fetch() targets and
  // CLI argv construction), not a blanket prose grep over served HTML/JS —
  // this file's own doc comments legitimately explain "we never call graph
  // add/remove", which would otherwise false-positive a naive text match.
  {
    const appJs = await (await fetch(BASE + "/ui/app.js")).text();
    ok(!/fetch\(\s*["'`]\/graph\/(add|remove)\b/.test(appJs),
      "ui/app.js never fetch()es a /graph/add or /graph/remove URL");
    ok(!/["'`]\/graph\/(add|remove)\b/.test(appJs),
      "ui/app.js never references a /graph/add or /graph/remove path string at all");

    const engineSrc = await readFile(path.join(__dirname, "..", "src", "engine.mjs"), "utf8");
    ok(!/\[\s*["'`]graph["'`]\s*,\s*["'`](add|remove)["'`]/.test(engineSrc),
      "engine.mjs never constructs a `swarm-memory graph add`/`graph remove` CLI invocation");

    const serverSrc = await readFile(path.join(__dirname, "..", "src", "server.mjs"), "utf8");
    ok(!/["'`](GET|POST|PUT|DELETE)\s+\/graph\/(add|remove)["'`]/.test(serverSrc),
      "server.mjs registers no route for /graph/add or /graph/remove");
    ok(!serverSrc.includes("graphAdd") && !serverSrc.includes("graphRemove"),
      "server.mjs never imports/calls a graphAdd or graphRemove engine function (none exist)");
  }
} finally {
  child.kill();
}

// --- zero-edges empty state: fresh throwaway graph.sqlite, separate server -
await (async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mnemosyne-graph-route-empty-"));
  const dbPath = path.join(dir, "fresh-graph.sqlite");
  const emptyPort = PORT + 1;
  const emptyBase = `http://127.0.0.1:${emptyPort}`;
  const emptyChild = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, PORT: String(emptyPort), SWARM_MEMORY_GRAPH_DB: dbPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let emptyOutput = "";
  emptyChild.stdout.on("data", (d) => { emptyOutput += d.toString(); });
  emptyChild.stderr.on("data", (d) => { emptyOutput += d.toString(); });
  try {
    const up = await waitForServer(emptyBase + "/scopes");
    ok(up, "empty-graph test server came up");

    const statsRes = await fetch(emptyBase + "/graph/stats");
    const statsBody = await statsRes.json();
    ok(statsRes.status === 200 && statsBody.nodes === 0 && statsBody.edges === 0,
      `GET /graph/stats on a fresh graph.sqlite -> {nodes:0, edges:0} (got ${JSON.stringify(statsBody)})`);

    const edgesRes = await fetch(emptyBase + "/graph/edges");
    const edgesBody = await edgesRes.json();
    ok(edgesRes.status === 200 && Array.isArray(edgesBody.edges) && edgesBody.edges.length === 0,
      `GET /graph/edges on a fresh graph.sqlite -> {edges: []} (got ${JSON.stringify(edgesBody)})`);
  } finally {
    if (fails) console.log("\n--- empty-graph server output ---\n" + emptyOutput);
    emptyChild.kill();
    await rm(dir, { recursive: true, force: true });
  }
})();

// --- graphify-configured: same routes, delegated to bin/graphify-bridge.mjs
// (la-02-graphify-adapter's extension to this repo's own GET /graph/* — the
// UI's graph panel, not just the MCP tools) -------------------------------
await (async () => {
  const graphifyPort = PORT + 2;
  const graphifyBase = `http://127.0.0.1:${graphifyPort}`;
  const graphifyChild = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, PORT: String(graphifyPort), MNEMOSYNE_LAYERS: JSON.stringify({ layers: [{ name: "graphify" }] }) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let graphifyOutput = "";
  graphifyChild.stdout.on("data", (d) => { graphifyOutput += d.toString(); });
  graphifyChild.stderr.on("data", (d) => { graphifyOutput += d.toString(); });
  try {
    const up = await waitForServer(graphifyBase + "/scopes");
    ok(up, "graphify-configured test server came up");

    const statsRes = await fetch(graphifyBase + "/graph/stats");
    const statsBody = await statsRes.json();
    ok(statsRes.status === 200 && typeof statsBody.nodes === "number" && statsBody.nodes > 0,
      `GET /graph/stats (MNEMOSYNE_LAYERS=graphify) -> real graphify node count, not swarm-memory's (got ${JSON.stringify(statsBody)})`);
    ok(statsBody.db && statsBody.db.includes("graph.json"),
      `GET /graph/stats (graphify) -> db path points at graphify's graph.json, not swarm-memory's sqlite (got ${statsBody.db})`);

    const edgesRes = await fetch(graphifyBase + "/graph/edges");
    const edgesBody = await edgesRes.json();
    ok(edgesRes.status === 200 && Array.isArray(edgesBody.edges) && edgesBody.edges.length > 0,
      `GET /graph/edges (graphify) -> real edges from this repo's own graphify graph (got count=${edgesBody.count})`);
  } finally {
    if (fails) console.log("\n--- graphify-configured server output ---\n" + graphifyOutput);
    graphifyChild.kill();
  }
})();

if (fails) {
  console.log("\n--- server output (for debugging) ---");
  console.log(serverOutput);
}

console.log(fails ? `\n${fails} check(s) failed` : "\nall graph-route checks passed");
process.exit(fails ? 1 : 0);
